import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { projectStoreDir } from './project-layout.mjs';

const FILE_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'];
const MAX_MARKER_BYTES = 256 * 1024;
const GIT_TIMEOUT = 4000;

export function emptyLayout() {
  return {
    boundRoot: null,
    projectStore: null,
    kind: 'unknown',
    markers: [],
    workspaceType: 'none',
    workspaceFile: null,
    roots: [],
    domainSuggestion: null,
  };
}

function readText(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function packageWorkspaces(text) {
  try {
    const workspaces = JSON.parse(text).workspaces;
    if (Array.isArray(workspaces)) return workspaces.length > 0;
    return Array.isArray(workspaces?.packages) && workspaces.packages.length > 0;
  } catch {
    return false;
  }
}

function skipGradleString(text, index) {
  const quote = text[index];
  let i = index + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function takeParen(text, open) {
  let depth = 0;
  let i = open;
  const start = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipGradleString(text, i); continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i += 1;
  }
  return text.slice(start);
}

export function gradleIncludeCount(text) {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') { i += 2; while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === '"' || ch === "'") { i = skipGradleString(text, i); continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
      if (text.slice(start, i) !== 'include') continue;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      const body = text[i] === '(' ? takeParen(text, i) : text.slice(i, text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i));
      count += (body.match(/'[^'\n]*'|"[^"\n]*"|:[A-Za-z0-9_.-]+/g) || []).length;
      continue;
    }
    i += 1;
  }
  return count;
}

export function mavenModuleCount(text) {
  const stripped = String(text).replace(/<!--[\s\S]*?-->/g, '');
  let count = 0;
  for (const block of stripped.matchAll(/<modules\b[^>]*>([\s\S]*?)<\/modules>/gi)) {
    count += (block[1].match(/<module\b[^>]*>[\s\S]*?<\/module>/gi) || []).length;
  }
  return count;
}

export function classifyRepo(root) {
  const markers = [];
  if (!root) return { kind: 'product-repo', markers };
  for (const name of FILE_MARKERS) {
    if (readText(path.join(root, name)) !== null) markers.push(name);
  }
  if (packageWorkspaces(readText(path.join(root, 'package.json')) || '')) markers.push('package.json');
  for (const name of ['settings.gradle', 'settings.gradle.kts']) {
    const text = readText(path.join(root, name));
    if (text !== null && gradleIncludeCount(text) > 1) markers.push(name);
  }
  const pom = readText(path.join(root, 'pom.xml'));
  if (pom !== null && mavenModuleCount(pom) > 0) markers.push('pom.xml');
  return { kind: markers.length ? 'monorepo' : 'product-repo', markers };
}

export function detectWorkspace(workspace, { home } = {}) {
  const layout = emptyLayout();
  try {
    const result = spawnSync(gitExecutable(), ['rev-parse', '--show-toplevel'], {
      cwd: workspace, encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024,
      env: gitMetadataEnvironment(), windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout.trim()) return layout;
    layout.boundRoot = fs.realpathSync.native(path.resolve(result.stdout.trim()));
    Object.assign(layout, classifyRepo(layout.boundRoot));
  } catch {
    return layout;
  }
  try { layout.projectStore = projectStoreDir(workspace, { home }); }
  catch { /* The bound root remains useful when its storage binding is unavailable. */ }
  return layout;
}
