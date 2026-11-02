import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { activatedSkillFromPayload, normalizeToolPayload, toolMutationSucceeded } from './tool-payload.mjs';

const MAX_SKILL_BYTES = 128 * 1024;
const localHome = fileURLToPath(new URL('../..', import.meta.url));
const packaged = path.basename(path.resolve(localHome)) === 'corpus' && fs.existsSync(path.resolve(localHome, '../bin/ae.mjs'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function homes(copilotHome) {
  const xdg = process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'copilot');
  const selected = copilotHome || process.env.COPILOT_HOME || (!packaged ? localHome : xdg && fs.existsSync(xdg) ? xdg : path.join(os.homedir(), '.copilot'));
  return [...new Set([path.resolve(selected), ...(packaged ? [localHome] : [])])];
}

function skillSource(root, skill) {
  try {
    const base = fs.realpathSync.native(root);
    let full = base;
    for (const part of [skill, 'SKILL.md']) {
      full = path.join(full, part);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (part === 'SKILL.md' ? !stat.isFile() || stat.size > MAX_SKILL_BYTES : !stat.isDirectory())) return null;
    }
    const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_SKILL_BYTES || !bytes.toString('utf8').trim()) return null;
      return { path: full, sha256: digest(bytes), text: bytes.toString('utf8') };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function selectedSources(skill, copilotHome) {
  if (process.env.AE_SKILLS_HOME) {
    const skillsRoot = path.resolve(process.env.AE_SKILLS_HOME);
    const source = skillSource(skillsRoot, skill);
    return source ? [{ root: path.dirname(skillsRoot), source }] : [];
  }
  return homes(copilotHome).map(root => ({ root, source: skillSource(path.join(root, 'skills'), skill) })).filter(item => item.source);
}

function coversSource(input, text) {
  const count = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
  const ranges = [];
  if (input.startLine !== undefined || input.endLine !== undefined) ranges.push([input.startLine ?? 1, input.endLine ?? Infinity]);
  if (input.offset !== undefined) ranges.push([input.offset, Infinity]);
  for (const limit of [input.lines, input.limit]) if (limit !== undefined) ranges.push([input.offset ?? 1, (input.offset ?? 1) + limit - 1]);
  if (input.view_range !== undefined) {
    if (!Array.isArray(input.view_range) || input.view_range.length !== 2) return false;
    ranges.push([input.view_range[0], input.view_range[1] === -1 ? Infinity : input.view_range[1]]);
  }
  return ranges.every(([start, end]) => Number.isInteger(start) && start === 1 && (end === Infinity || Number.isInteger(end) && end >= count));
}

function returnedWholeSource(value, text) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return false;
  const wanted = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const actual = value.replace(/\r\n/g, '\n');
  if (actual.includes(wanted)) return true;
  // CLI view may prefix source lines with their numbers. Require every line,
  // in order, rather than treating a successful range as a whole-file read.
  const lines = wanted.split('\n');
  const numbered = actual.split('\n').map(line => line.match(/^\s*(\d+)(?:[.:|]|[→│]) ?(.*)$/));
  for (let i = 0; i + lines.length <= numbered.length; i++) {
    if (lines.every((line, j) => numbered[i + j] && +numbered[i + j][1] === j + 1 && numbered[i + j][2] === line)) return true;
  }
  return false;
}

function returnedText(value) {
  if (typeof value === 'string') return value.length <= 2 * 1024 * 1024 ? [value] : null;
  const blocks = Array.isArray(value) ? value : value?.type === 'text' ? [value] : null;
  if (!blocks?.length || blocks.length > MAX_SKILL_BYTES) return null;
  const parts = [];
  let size = 0;
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return null;
    size += block.text.length;
    if (size > 2 * 1024 * 1024) return null;
    parts.push(block.text);
  }
  return [parts.join(''), parts.join('\n')];
}

/** Recorded adapter evidence, not an authenticated native-host transcript. */
export function readSkillActivation(payload, { copilotHome } = {}) {
  const skill = activatedSkillFromPayload(payload);
  if (!skill || !toolMutationSucceeded(payload)) return null;
  const normalized = normalizeToolPayload(payload), input = normalized.toolInput;
  if (normalized.terminalEffects.hasOpaque) return null;
  const candidates = normalized.targets;
  const source = selectedSources(skill, copilotHome).find(({ root, source }) => {
    if (!candidates.length) return ['read_skill', 'readSkill'].includes(normalized.toolName);
    const requested = path.resolve(normalized.workspace, candidates[0]);
    return candidates.length === 1 && (samePath(requested, path.join(root, 'skills', skill, 'SKILL.md')) || samePath(requested, source.path));
  })?.source;
  if (!source || !coversSource(input, source.text)) return null;
  const results = [payload.tool_response, payload.tool_result, payload.toolResult].filter(result => result && typeof result === 'object');
  if (payload.truncated === true || results.some(result => result.truncated === true)) return null;
  const texts = results.flatMap(result => ['text_result_for_llm', 'textResultForLlm', 'content']
    .filter(key => Object.hasOwn(result, key)).map(key => returnedText(result[key])));
  if (texts.some(versions => !versions?.some(value => returnedWholeSource(value, source.text)))
    || results.some(result => result.sha256 !== undefined && result.sha256 !== source.sha256)) return null;
  const complete = texts.length > 0 || candidates.length > 0 && results.some(result => result.truncated === false);
  if (!complete) return null;
  return { skill, source: { version: 1, path: source.path, sha256: source.sha256 } };
}

export function skillActivationSourceCurrent(activation, skill, { copilotHome } = {}) {
  const binding = activation?.source;
  return binding?.version === 1 && typeof binding.path === 'string' && selectedSources(skill, copilotHome).some(({ source }) => samePath(source.path, binding.path) && source.sha256 === binding.sha256);
}
