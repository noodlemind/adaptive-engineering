import http from 'node:http';
import https from 'node:https';

const BASE_URL = process.env.HARNESS_PROVIDER_BASE_URL || '';
const API_PATH = '/v1/messages';
const API_VERSION = '2023-06-01';

function scrubCredential(value, key) {
  if (!key || key.length < 8) return value;
  if (typeof value === 'string') return value.split(key).join('[redacted]');
  if (Array.isArray(value)) return value.map((v) => scrubCredential(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubCredential(v, key);
    return out;
  }
  return value;
}

function send(message) {
    const safe = scrubCredential(message, process.env[process.env.HARNESS_PROVIDER_KEY_VAR || 'ANTHROPIC_API_KEY']);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

function toWireMessages(messages) {
  const out = [];
  for (const message of messages || []) {
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.blocks) && message.blocks.length
        ? message.blocks
        : [{ type: 'text', text: String(message.text ?? '') }];
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (Array.isArray(message.toolResults) && message.toolResults.length) {
      out.push({
        role: 'user',
        content: message.toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: String(r.output ?? ''),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
      continue;
    }
    out.push({ role: 'user', content: String(message.text ?? '') });
  }
  return out;
}

function toWireTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema ?? { type: 'object', properties: {} },
  }));
}

export function foldAnthropicEvent(acc, event) {
  switch (event?.type) {
    case 'message_start':
      if (event.message?.model) acc.model = event.message.model;
      if (event.message?.usage?.input_tokens != null) acc.usage.input_tokens = event.message.usage.input_tokens;
      return null;
    case 'content_block_start':
      acc.blocks[event.index] = event.content_block?.type === 'tool_use'
        ? { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, _json: '' }
        : { type: 'text', text: event.content_block?.text ?? '' };
      return null;
    case 'content_block_delta': {
      const block = acc.blocks[event.index];
      if (!block) return null;
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        block.text = (block.text ?? '') + event.delta.text;
        return event.delta.text;
      }
      if (event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        block._json += event.delta.partial_json;
      }
      return null;
    }
    case 'message_delta':
      if (event.delta?.stop_reason) acc.stopReason = event.delta.stop_reason;
      if (event.usage?.output_tokens != null) acc.usage.output_tokens = event.usage.output_tokens;
      return null;
    default:
      return null;
  }
}

/** The accumulated stream, reassembled into the non-streaming response shape
 * so `shapeResult` stays the single normalizer for both transports. */
export function anthropicStreamToResponse(acc) {
  return {
    content: acc.blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      let input = {};
      try { input = b._json ? JSON.parse(b._json) : {}; } catch { /* refused below as an empty input, never a crash */ }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    }),
    stop_reason: acc.stopReason ?? null,
    usage: acc.usage,
    model: acc.model ?? null,
  };
}

function callModel({ apiKey, model, system, messages, tools, maxTokens, temperature }, { onDelta = null } = {}) {
  const wireTools = toWireTools(tools);
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens ?? 4096,
    stream: true,
    ...(system ? { system } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(wireTools ? { tools: wireTools } : {}),
    messages: toWireMessages(messages),
  });

  const url = new URL(BASE_URL);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const acc = { blocks: [], stopReason: null, usage: { input_tokens: null, output_tokens: null }, model: null };
    let sse = false;
    let carry = '';
    const feedSse = (text) => {
      carry += text;
      const frames = carry.split('\n\n');
      carry = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const delta = foldAnthropicEvent(acc, JSON.parse(line.slice(5).trim()));
            if (delta && onDelta) onDelta(delta);
          } catch { /* a malformed frame is dropped; the stream carries on */ }
        }
      }
    };
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || undefined,
                path: `${url.pathname.replace(/\/+$/, '')}${API_PATH}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'content-length': Buffer.byteLength(payload),
          'anthropic-version': API_VERSION,
          'x-api-key': apiKey,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        sse = String(res.headers['content-type'] ?? '').includes('text/event-stream');
        res.on('data', (c) => {
          if (res.statusCode >= 200 && res.statusCode < 300 && sse) feedSse(c);
          else body += c;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let detail = body.slice(0, 500);
            try {
              detail = JSON.parse(body)?.error?.message ?? detail;
            } catch { /* keep the raw prefix */ }
            reject(new Error(`anthropic ${res.statusCode}: ${detail}`));
            return;
          }
          if (sse) { resolve(anthropicStreamToResponse(acc)); return; }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`anthropic returned unparseable JSON: ${error.message}`));
          }
        });
      },
    );
    req.on('error', (error) => reject(new Error(`anthropic request failed: ${error.code || error.message}`)));
    req.write(payload);
    req.end();
  });
}

function shapeResult(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return {
    text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks
      .filter((b) => b?.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    blocks,
        stopReason: response?.stop_reason === 'max_tokens' ? 'length' : (response?.stop_reason ?? null),
    usage: {
      inputTokens: response?.usage?.input_tokens ?? null,
      outputTokens: response?.usage?.output_tokens ?? null,
    },
    model: response?.model ?? null,
  };
}

/** Declared, not echoed — see the shared adapter's note: an echo made the
 * host's protocol-mismatch warning structurally unable to fire. */
const ADAPTER_PROTOCOL_VERSION = 1;
const ADAPTER_CAPABILITIES = Object.freeze(['network']);

async function handle(message) {
  if (message.type === 'hello') {
    send({ type: 'hello', protocol: ADAPTER_PROTOCOL_VERSION, capabilities: [...ADAPTER_CAPABILITIES] });
    return;
  }
  if (message.type === 'shutdown') {
    process.exit(0);
  }
  if (message.type !== 'request') return;

  if (message.method !== 'complete') {
    send({ type: 'error', id: message.id, message: `unknown method: ${message.method}` });
    return;
  }
  if (!BASE_URL) {
    send({ type: 'error', id: message.id, message: 'HARNESS_PROVIDER_BASE_URL is not set in the provider environment' });
    return;
  }
    const keyVar = process.env.HARNESS_PROVIDER_KEY_VAR || 'ANTHROPIC_API_KEY';
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    send({ type: 'error', id: message.id, message: `${keyVar} is not set in the provider environment` });
    return;
  }
  try {
    const response = await callModel({ apiKey, ...message.params }, {
      onDelta: (text) => send({ type: 'chunk', id: message.id, text }),
    });
    send({ type: 'result', id: message.id, result: shapeResult(response) });
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      }
  }
});
}
