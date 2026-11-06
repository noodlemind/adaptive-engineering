import fs from 'node:fs';
import path from 'node:path';

/** An authored decision input is data, never a policy, receipt or approval. */
export function decisionInputStaging(payload, normalized) {
  const tools = ['Write', 'create_file', 'createFile', 'create_new_file'];
  if (!tools.includes(normalized?.toolName) || normalized.targets.length !== 1 || normalized.command || normalized.terminalEffects.hasOpaque) return false;
  if ([payload.tool_name, payload.toolName, payload.ae_native_tool_name].some(value => value !== undefined && ![...tools, 'create'].includes(value))) return false;
  const input = normalized.toolInput;
  if (['file_path', 'filePath', 'path', 'target_file'].some(key => typeof input[key] === 'string' && input[key].replaceAll('\\', '/').split('/').includes('..'))) return false;
  const workspace = path.resolve(normalized.workspace), full = path.resolve(workspace, normalized.targets[0]);
  const relative = path.relative(workspace, full).replaceAll('\\', '/');
  if (!/^\.harness\/decisions\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\.json$/.test(relative)) return false;
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
  const content = input.content ?? input.text ?? input.file_content ?? input.file_text;
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536) return false;
  let value;
  try { value = JSON.parse(content); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) return false;
  const keys = value.operation === 'prepare' ? ['schema', 'operation', 'taskId', 'sessionId', 'type', 'intent', 'action', 'sources', 'context', 'planPath', 'capability', 'memory']
    : value.operation === 'record' ? ['schema', 'operation', 'requestId'] : value.operation === 'status' ? ['schema', 'operation', 'taskId', 'requestId'] : null;
  return Boolean(keys && Object.keys(value).every(key => keys.includes(key)));
}
