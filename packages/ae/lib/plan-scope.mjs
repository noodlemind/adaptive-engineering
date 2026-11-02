import { gitExecutable } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'node:fs';
import { planRecordRoot } from './domain-context.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readGitArgs, gitMetadataEnvironment } from '../corpus/hooks/lib/product-diff.mjs';
import { parseImpactedText } from '../corpus/hooks/lib/impacted-files.mjs';
import { readPlanRecord } from './plan-record.mjs';
import { cachedGitObservation } from './git-observation-cache.mjs';

export { parseImpactedText };

function runGit(workspace, args, prefix) {
  return spawnSync(gitExecutable(), [...prefix, ...args], { cwd: workspace, encoding: 'utf8', timeout: 30_000, env: gitMetadataEnvironment() });
}

function lines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

export function parseImpactedFiles(plan) {
  return parseImpactedText(plan.sections?.impactedFiles || '');
}

function withParsed(message, allowed) {
  const parsed = allowed.length ? allowed.join(', ') : '(none)';
  return `${message} Parsed impacted files: ${parsed}.`;
}

export function matchesScope(file, allowed) {
  return allowed.some((entry) => {
    if (entry.endsWith('/**')) return file === entry.slice(0, -3) || file.startsWith(entry.slice(0, -2));
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry;
  });
}

export function collectChangedFiles(workspace, base = null) {
  return cachedGitObservation(['changed', path.resolve(workspace), base], () => readChangedFiles(workspace, base));
}

function readChangedFiles(workspace, base) {
  const prefix = readGitArgs(workspace, { timeout: 30_000, env: gitMetadataEnvironment() });
  if (!prefix) return { files: [], error: 'Git helper configuration could not be read safely; scope cannot be verified' };
  const inside = runGit(workspace, ['rev-parse', '--is-inside-work-tree'], prefix);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { files: [], error: 'Workspace is not a git worktree; scope cannot be verified' };
  }

  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=ACMRDTUXB'];
  if (base && (typeof base !== 'string' || base.startsWith('-') || /[\0\r\n]/.test(base))) {
    return { files: [], error: 'Base must be a safe git ref' };
  }
  if (base) diffArgs.push(base, '--');
  else if (fs.existsSync(path.join(workspace, '.git'))) diffArgs.push('HEAD');
  const diff = runGit(workspace, diffArgs, prefix);
  if (diff.status !== 0) {
    return { files: [], error: diff.error?.message || String(diff.stderr || '').trim() || 'git diff failed' };
  }

  const untracked = runGit(workspace, ['ls-files', '--others', '--exclude-standard'], prefix);
  if (untracked.status !== 0) {
    return { files: [], error: untracked.error?.message || String(untracked.stderr || '').trim() || 'git ls-files failed' };
  }

  const files = [...new Set([...lines(diff.stdout), ...lines(untracked.stdout)])]
    .filter((file) => !file.startsWith('.harness/'))
    .sort();
  return { files, error: null };
}

export function validatePlanScope({ workspace, plan, base = null }) {
  const allowed = parseImpactedFiles(plan);
  const changed = collectChangedFiles(workspace, base);
  if (changed.error) return { status: 'inconclusive', allowed, changedFiles: [], violations: [], message: changed.error };
  const activePlan = String(plan.path || '').replace(/\\/g, '/');
  const governedFiles = changed.files.filter((file) => file !== activePlan);
  if (plan.fm?.domain_parent) {
    planRecordRoot(workspace, plan);
    const pass = allowed.length === 0 && governedFiles.length === 0;
    return { status: pass ? 'passed' : 'failed', allowed, changedFiles: changed.files, violations: governedFiles, message: pass ? 'Domain coordinator is unchanged and grants no product scope' : withParsed('Domain parent requires an unchanged coordinator and empty product scope', allowed) };
  }
  if (allowed.length === 0) {
    if (readPlanRecord(plan.text)) {
      return {
        status: 'passed',
        allowed,
        changedFiles: changed.files,
        violations: [],
        message: 'Short plan record has no Impacted Files list',
      };
    }
    return { status: 'failed', allowed, changedFiles: changed.files, violations: governedFiles, message: withParsed('No Impacted Files allowlist', allowed) };
  }
  const violations = governedFiles.filter((file) => !matchesScope(file, allowed));
  return {
    status: violations.length ? 'failed' : 'passed',
    allowed,
    changedFiles: changed.files,
    violations,
    message: violations.length ? withParsed(`${violations.length} changed files outside plan scope: ${violations.join(', ')}`, allowed) : 'Changed files match plan scope',
  };
}
