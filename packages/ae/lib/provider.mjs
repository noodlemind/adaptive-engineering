/** First-party provider seam: start out-of-process adapters; core holds no model SDK. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_COMPLETION_LINE_BYTES, startPlugin } from './plugin-host.mjs';
import { bridgeStatePath, readEditorBridgeState } from './vscode-lm-bridge.mjs';

export const PROVIDER_TIMEOUT_MS = 300_000;

export const AUTO_MODEL = 'auto';

export function isAutoModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL;
}

export const DEFAULT_PROVIDER = 'github-copilot';

export const PROVIDERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    keyVar: 'ANTHROPIC_API_KEY',
    baseUrlVar: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.anthropic.com',
    adapter: 'providers/anthropic.mjs',
    defaultModel: 'claude-sonnet-5',
  },
  openrouter: {
    id: 'openrouter',
    keyVar: 'OPENROUTER_API_KEY',
    baseUrlVar: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.ai/api/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'anthropic/claude-sonnet-4.5',
  },
  zen: {
    id: 'zen',
    keyVar: 'OPENCODE_API_KEY',
    baseUrlVar: 'OPENCODE_BASE_URL',
    baseUrl: 'https://opencode.ai/zen/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'claude-sonnet-4-5',
  },
  'zen-go': {
    id: 'zen-go',
    keyVar: 'OPENCODE_API_KEY',
    baseUrlVar: 'OPENCODE_GO_BASE_URL',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'claude-sonnet-4-5',
  },
  openai: {
    id: 'openai',
    keyVar: 'OPENAI_API_KEY',
    baseUrlVar: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'gpt-5',
  },
  ollama: {
    id: 'ollama',
    keyVar: 'OLLAMA_API_KEY',
    keyRequired: false,
    baseUrlVar: 'OLLAMA_BASE_URL',
    baseUrl: 'http://127.0.0.1:11434/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'qwen3:8b',
  },
  // ── the second wave: every row below is the SAME wire format ──────────
  gemini: {
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    baseUrlVar: 'GEMINI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'gemini-2.5-pro',
  },
  xai: {
    id: 'xai',
    keyVar: 'XAI_API_KEY',
    baseUrlVar: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'grok-4',
  },
  groq: {
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    baseUrlVar: 'GROQ_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  deepseek: {
    id: 'deepseek',
    keyVar: 'DEEPSEEK_API_KEY',
    baseUrlVar: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'deepseek-chat',
  },
  mistral: {
    id: 'mistral',
    keyVar: 'MISTRAL_API_KEY',
    baseUrlVar: 'MISTRAL_BASE_URL',
    baseUrl: 'https://api.mistral.ai/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'mistral-large-latest',
  },
  'github-models': {
    id: 'github-models',
        keyVar: 'GITHUB_MODELS_TOKEN',
    baseUrlVar: 'GITHUB_MODELS_BASE_URL',
    baseUrl: 'https://models.github.ai/inference',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'openai/gpt-4o',
  },
  lmstudio: {
    id: 'lmstudio',
    keyVar: 'LMSTUDIO_API_KEY',
    keyRequired: false,
    baseUrlVar: 'LMSTUDIO_BASE_URL',
    baseUrl: 'http://127.0.0.1:1234/v1',
    adapter: 'providers/openai-compatible.mjs',
    defaultModel: 'qwen/qwen3-8b',
  },

  'github-copilot': {
    id: 'github-copilot',
    keyRequired: false,
    adapter: 'providers/github-copilot.mjs',
    defaultModel: 'gpt-4.1',
    transport: 'vscode.lm',
  },
});

/** Known provider ids — shared with config validation (`agent.providers`). */
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export const PROVIDER_MODELS = Object.freeze({
    'github-copilot': [AUTO_MODEL],
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  zen: ['claude-sonnet-4-5', 'gpt-5', 'qwen3-coder'],
  'zen-go': ['claude-sonnet-4-5', 'gpt-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  xai: ['grok-4', 'grok-3-mini'],
  groq: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'codestral-latest'],
  'github-models': ['openai/gpt-4o', 'openai/o3-mini', 'meta/Llama-3.3-70B-Instruct'],
  ollama: ['qwen3:8b', 'llama3.3', 'deepseek-r1'],
  lmstudio: ['qwen/qwen3-8b'],
});

export function modelCatalog({ parentEnv = process.env, cache = {}, enabledIds = null, copilotHome = null } = {}) {
  return providerReadiness({ parentEnv, enabledIds, copilotHome }).map((provider) => {
    const cached = cache?.[provider.id];
    if (cached?.models?.length) {
      const models = cached.models.includes(AUTO_MODEL) ? cached.models : [AUTO_MODEL, ...cached.models];
      const labels = { [AUTO_MODEL]: `provider default (${provider.defaultModel})`, ...(cached.labels ?? {}) };
      return { ...provider, models, labels, source: 'fetched', fetchedAt: cached.fetchedAt ?? null };
    }
    return {
      ...provider,
      models: PROVIDER_MODELS[provider.id] ?? [provider.defaultModel],
      labels: PROVIDER_MODELS[provider.id]?.includes(AUTO_MODEL)
        ? { [AUTO_MODEL]: `provider default (${provider.defaultModel})` }
        : {},
      source: 'built-in',
      fetchedAt: null,
    };
  });
}

export function resolveDefaultModel(providerId, cache = {}) {
  const models = cache?.[providerId]?.models ?? [];
  const preferred = PROVIDERS[providerId]?.defaultModel ?? null;
    if (preferred && (!models.length || models.includes(preferred))) return preferred;
  return models[0] ?? preferred ?? null;
}

export function resolveRequestedModel(providerId, requested, cache = {}) {
  if (isAutoModel(requested)) {
    return providerId === 'github-copilot' ? AUTO_MODEL : resolveDefaultModel(providerId, cache);
  }
  return requested || resolveDefaultModel(providerId, cache);
}

/** Loopback is the one place a plaintext base URL is not a mistake. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

export function resolveBaseUrl(provider, { parentEnv = process.env } = {}) {
  const raw = provider.baseUrlVar ? parentEnv[provider.baseUrlVar] : null;
  const value = (raw && String(raw).trim()) || provider.baseUrl;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw usageError(
      `${provider.baseUrlVar} is not a valid URL: ${value}`,
      `expected something like ${provider.baseUrl}`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError(`${provider.baseUrlVar} must be http or https, got ${url.protocol}`, `expected something like ${provider.baseUrl}`);
  }
    if (url.username || url.password) {
    throw usageError(
      `${provider.baseUrlVar} must not embed credentials`,
      `put the key in ${provider.keyVar} instead of the URL`,
    );
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw usageError(
      `refusing a plaintext base URL to ${url.hostname}`,
      `${provider.keyVar} would cross the network unencrypted — use https, or point at loopback for a local model`,
    );
  }
  // Trailing slashes are the classic source of `//v1//chat/completions`.
  return url.href.replace(/\/+$/, '');
}

function usageError(message, hint) {
  return Object.assign(new Error(message), { code: 'E_USAGE', exit: 2, hint });
}

export function providerEnv(provider, { parentEnv = process.env, copilotHome = null } = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  env.HARNESS_PROVIDER_ID = provider.id;

  if (parentEnv.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS !== undefined) {
    env.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS = parentEnv.HARNESS_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  if (provider.transport === 'vscode.lm') {
    env.HARNESS_COPILOT_BRIDGE_STATE = bridgeStatePath(copilotHome, parentEnv);
    return env;
  }

  if (parentEnv.NODE_EXTRA_CA_CERTS !== undefined) {
    env.NODE_EXTRA_CA_CERTS = parentEnv.NODE_EXTRA_CA_CERTS;
  }
  env.HARNESS_PROVIDER_BASE_URL = resolveBaseUrl(provider, { parentEnv });

  for (const name of [
    'HARNESS_PROVIDER_RETRIES',
    'HARNESS_PROVIDER_RETRY_BASE_MS',
  ]) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

    for (const name of provider.passEnv ?? []) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }

    if (provider.id === 'github-models' && !parentEnv[provider.keyVar]) {
    const conventional = parentEnv.GH_TOKEN || parentEnv.GITHUB_TOKEN;
    if (conventional) {
      env[provider.keyVar] = conventional;
      return env;
    }
  }

  const key = parentEnv[provider.keyVar];
  if (!key) {
    if (provider.keyRequired === false) return env;
    throw usageError(
      `${provider.keyVar} is not set`,
      `the provider process reads it; harness core never does — export ${provider.keyVar} and re-run`,
    );
  }
  env[provider.keyVar] = key;
    env.HARNESS_PROVIDER_KEY_VAR = provider.keyVar;
  return env;
}

export function resolveProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw usageError(`unknown provider: ${id}`, `known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

/** How an operator connects this provider — guide-only, never stores a key. */
export function connectHint(provider) {
  if (provider.transport === 'vscode.lm') {
    return 'run ae install --configure-vscode, reload VS Code, and sign in to Copilot Chat';
  }
  if (provider.keyRequired === false) {
    return `ensure the local server is running (default ${provider.baseUrl})`;
  }
  return `export ${provider.keyVar}=…`;
}

export function normalizeEnabledProviders(list) {
  if (!Array.isArray(list) || !list.length) return [DEFAULT_PROVIDER];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = String(raw ?? '').trim();
    if (!id || !PROVIDERS[id] || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length ? out : [DEFAULT_PROVIDER];
}

/** Provider connectivity without reading secret values. Optional `enabledIds` filters the menu. */
export function providerReadiness({ parentEnv = process.env, enabledIds = null, copilotHome = null } = {}) {
  const allow = enabledIds == null ? null : new Set(normalizeEnabledProviders(enabledIds));
  return Object.values(PROVIDERS)
    .filter((provider) => !allow || allow.has(provider.id))
    .map((provider) => {
      const connect = connectHint(provider);

      if (provider.transport === 'vscode.lm') {
        const viaBridge = Boolean(readEditorBridgeState({ copilotHome, parentEnv }));
        return {
          id: provider.id,
          defaultModel: provider.defaultModel,
          ready: viaBridge,
          how: viaBridge ? 'VS Code language model bridge' : null,
          reason: viaBridge ? null : connect,
          connect,
        };
      }

      const local = provider.keyRequired === false;
      const hasKey = Boolean(parentEnv[provider.keyVar]);
      const ready = local || hasKey;
      return {
        id: provider.id,
        defaultModel: provider.defaultModel,
        ready,
        how: local ? 'runs locally' : hasKey ? `${provider.keyVar} is set` : null,
        reason: ready ? null : connect,
        connect,
      };
    });
}

export function startProvider({
  provider: providerId = DEFAULT_PROVIDER,
  model: requestedModel = null,
  packageRoot = null,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  parentEnv = process.env,
  copilotHome = null,
  enabledIds = null,
  onChunk = null,
  spawnFn = undefined,
} = {}) {
  if (enabledIds != null) {
    const allow = new Set(normalizeEnabledProviders(enabledIds));
    if (!allow.has(providerId)) {
      throw usageError(
        `provider ${providerId} is disabled`,
        `enable it with: ae config set agent.providers ${[...allow, providerId].join(',')} --scope user`,
      );
    }
  }
  const provider = resolveProvider(providerId);
  const model = resolveRequestedModel(providerId, requestedModel);
    const root = packageRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const adapter = path.join(root, 'lib', provider.adapter);
  if (!fs.existsSync(adapter)) {
    throw Object.assign(new Error(`provider adapter missing: ${provider.adapter}`), { code: 'E_TARGET', exit: 1 });
  }

  const plugin = startPlugin({
    command: process.execPath,
    args: [adapter],
        granted: ['network'],
    requested: ['network'],
    env: providerEnv(provider, {
      parentEnv,
      copilotHome,
    }),
    timeoutMs,
    maxLineBytes: MAX_COMPLETION_LINE_BYTES,
    onChunk,
    ...(spawnFn ? { spawnFn } : {}),
  });

  return {
    provider: provider.id,
    model: model || provider.defaultModel,
    get alive() {
      return plugin.alive;
    },
    get logs() {
      return plugin.logs;
    },
    complete(request, options = {}) {
      return plugin.request('complete', { ...request, model: model || provider.defaultModel }, options);
    },
    /** Catalogue fetch. Providers may honor `{ verify: true }` with model probes. */
    models(params = {}, options = {}) {
      return plugin.request('models', params, options);
    },
    close() {
      plugin.close();
    },
  };
}

export async function fetchModels({
  provider: providerId,
  packageRoot = null,
  parentEnv = process.env,
  /** When true, providers that support probing may validate each candidate. */
  verify = false,
  timeoutMs = verify ? 180_000 : 60_000,
  copilotHome = null,
  startProviderFn = null,
  enabledIds = null,
} = {}) {
  const start = startProviderFn
    || (() => startProvider({
      provider: providerId,
      packageRoot,
      parentEnv,
      timeoutMs,
      copilotHome,
      enabledIds,
    }));
  const handle = start();
  try {
    const result = await handle.models(verify ? { verify: true } : {});
    const entries = Array.isArray(result?.models) ? result.models : [];
    const models = [];
    const labels = {};
    for (const entry of entries) {
      const id = typeof entry === 'string' ? entry : String(entry?.id ?? '');
      if (!id || models.includes(id)) continue;
      models.push(id);
      if (entry && typeof entry.label === 'string' && entry.label) labels[id] = entry.label;
    }
    if (!models.length) {
      throw Object.assign(new Error(`${providerId} returned no models`), { code: 'E_TARGET', exit: 1 });
    }
    const client = result?.client && typeof result.client === 'object' ? result.client : null;
    return {
      provider: providerId,
      models,
      labels,
      fetchedAt: new Date().toISOString(),
      ...(result?.probed ? { probed: result.probed } : {}),
      ...(result?.source ? { source: result.source } : {}),
      ...(client ? { client } : {}),
    };
  } finally {
    handle.close();
  }
}

export const SANCTIONED_PLUGIN_CALLERS = Object.freeze(['lib/provider.mjs']);
