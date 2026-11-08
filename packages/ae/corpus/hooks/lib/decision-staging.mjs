import fs from 'node:fs';
import path from 'node:path';

function addFileInput(payload, normalized) {
  const names = [payload.tool_name, payload.toolName, payload.ae_native_tool_name].filter(value => value !== undefined);
  if (!names.includes('apply_patch') || names.some(value => !['apply_patch', 'Edit'].includes(value))) return null;
  const input = normalized?.toolInput;
  if (!input || Object.keys(input).some(key => !['input', 'patch'].includes(key))) return null;
  const patches = [input.input, input.patch].filter(value => value !== undefined);
  if (!patches.length || patches.some(value => typeof value !== 'string' || value !== patches[0]) || Buffer.byteLength(patches[0]) > 2 * 1024 * 1024) return null;
  const lines = patches[0].split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return null;
  const target = lines[1]?.match(/^\*\*\* Add File: (.+)$/)?.[1], body = lines.slice(2, -1);
  if (!target || !body.length || body.some(line => !line.startsWith('+'))) return null;
  if (normalized.targets.length !== 1 || path.resolve(normalized.workspace, target) !== path.resolve(normalized.workspace, normalized.targets[0])) return null;
  const content = `${body.map(line => line.slice(1)).join('\n')}\n`, bytes = Buffer.byteLength(content);
  if (bytes > 1024 * 1024) return null;
  let value;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (!nativeInput(value, bytes) && !lifecycleInput(value))) return null;
  return { target, content };
}

/** A contained authoring destination is data, never lifecycle or receipt state. */
export function decisionInputTarget(payload, normalized) {
  const patch = addFileInput(payload, normalized);
  const tools = ['Write', 'create_file', 'createFile', 'create_new_file'];
  if ((!patch && !tools.includes(normalized?.toolName)) || normalized.targets.length !== 1 || normalized.command || normalized.terminalEffects.hasOpaque) return false;
  if (!patch && [payload.tool_name, payload.toolName, payload.ae_native_tool_name].some(value => value !== undefined && ![...tools, 'create'].includes(value))) return false;
  const input = normalized.toolInput;
  if (patch?.target.replaceAll('\\', '/').split('/').includes('..') || normalized.targets.some(target => String(target).replaceAll('\\', '/').split('/').includes('..')) || ['file_path', 'filePath', 'path', 'target_file'].some(key => typeof input[key] === 'string' && input[key].replaceAll('\\', '/').split('/').includes('..'))) return false;
  const workspace = path.resolve(normalized.workspace), full = path.resolve(workspace, normalized.targets[0]);
  const relative = path.relative(workspace, full).replaceAll('\\', '/');
  if (!/^\.harness\/decisions\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\.json$/.test(relative)) return false;
  if (patch) {
    try { if (fs.lstatSync(full, { throwIfNoEntry: false })) return false; }
    catch { return false; }
  }
  // Walk through the filesystem root as a symlink above the workspace is also unsafe.
  let cursor = full;
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || (cursor === full ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) return false;
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return true;
}

function stagedInput(payload, normalized) {
  if (!decisionInputTarget(payload, normalized)) return null;
  const input = normalized.toolInput;
  const content = addFileInput(payload, normalized)?.content ?? input.content ?? input.text ?? input.file_content ?? input.file_text;
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) return null;
  let value;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { value, bytes: Buffer.byteLength(content) };
}

const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const line = value => typeof value === 'string' && value.trim() && !/[\0\r\n]/.test(value);
const nonempty = value => typeof value === 'string' && value.trim() && !value.includes('\0');
const digest = value => /^[a-f0-9]{64}$/.test(value || '');
function nativeInput(value, bytes) {
  if (value.schema !== 1 || bytes > 65536) return false;
  const keys = value.operation === 'prepare' ? ['schema', 'operation', 'taskId', 'sessionId', 'type', 'intent', 'action', 'sources', 'context', 'planPath', 'capability', 'memory']
    : value.operation === 'record' ? ['schema', 'operation', 'requestId'] : value.operation === 'status' ? ['schema', 'operation', 'taskId', 'requestId'] : null;
  return Boolean(keys && only(value, keys));
}

/** The native judgment protocol remains distinct from other authored CLI inputs. */
export function nativeDecisionInputStaging(payload, normalized) {
  const input = stagedInput(payload, normalized);
  return Boolean(input && nativeInput(input.value, input.bytes));
}

function observedIntentInput(value) {
  const observed = value.observedIntent;
  if (observed === undefined) return true;
  if (!observed || typeof observed !== 'object' || Array.isArray(observed) || !only(observed, ['id', 'disposition', 'rationale'])
    || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(observed.id || '') || !['amend', 'unchanged'].includes(observed.disposition)
    || typeof observed.rationale !== 'string' || !observed.rationale.trim() || observed.rationale.length > 1000 || /[\u0000-\u001f\u007f]/.test(observed.rationale)
    || !['start', 'amend', 'progress', 'finding', 'gap'].includes(value.action)) return false;
  return observed.disposition !== 'amend' || value.action === 'amend' && Boolean(Object.keys(value.changes || {}).length || value.intentSources?.length || value.intentSelection || value.migrateIntent);
}

function lifecycleInput(value) {
  if (value.version === 1 && ['full', 'short'].includes(value.format)) return only(value, ['version', 'format', 'slug', 'type', 'title', 'goal', 'acceptance', 'constraints', 'scope', 'check', 'intentSources', 'risk', 'status', 'notes', 'phases', 'outputs', 'skillsUsed', 'verificationRecipe', 'playbook', 'experiment'])
    && line(value.goal) && Array.isArray(value.acceptance) && value.acceptance.length > 0 && value.acceptance.every(nonempty);
  if (value.version === 1 && ['start', 'amend', 'progress', 'finding', 'gap', 'complete', 'convert'].includes(value.action)) {
    const authority = value.authority;
    return only(value, ['version', 'id', 'action', 'expect', 'rationale', 'authority', 'changes', 'intentSources', 'intentSelection', 'finding', 'gap', 'migrateIntent', 'progress', 'observedIntent'])
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value.id || '') && digest(value.expect)
      && observedIntentInput(value)
      && (authority === undefined || authority && typeof authority === 'object' && !Array.isArray(authority) && only(authority, ['scope', 'basis']) && ['plan-intent', 'domain-intent', 'experiment-intent'].includes(authority.scope) && line(authority.basis));
  }
  if (['publish', 'no-learning'].includes(value.decision)) return only(value, ['operation', 'decision', 'rationale', 'scope', 'title', 'body', 'category', 'tags', 'trigger', 'claim'])
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.operation || '') && nonempty(value.rationale) && (value.scope === undefined || ['private', 'global', 'ship-set-proposal'].includes(value.scope))
    && (value.decision === 'no-learning' || nonempty(value.title) && nonempty(value.body)) && (value.tags === undefined || Array.isArray(value.tags) && value.tags.every(value => typeof value === 'string'));
  // Personal writers validate the canonical text and exact expected digests;
  // authoring the input cannot install or activate that text.
  return value.schema === 1 && only(value, ['schema', 'text', 'expectedDigest', 'expectedSourceDigest']) && typeof value.text === 'string' && Buffer.byteLength(value.text) <= 65536
    && ['expectedDigest', 'expectedSourceDigest'].every(key => value[key] === undefined || /^sha256-[a-f0-9]{64}$/.test(value[key]));
}

/** Closed authored CLI input only; its consumer retains all authority checks. */
export function decisionInputStaging(payload, normalized) {
  const input = stagedInput(payload, normalized);
  return Boolean(input && (nativeInput(input.value, input.bytes) || lifecycleInput(input.value)));
}
