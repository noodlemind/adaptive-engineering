#!/usr/bin/env node
// Review-recall eval runner (scaffold). The default dry run validates the
// frozen cases against the local Git history and prints the trial plan. It
// makes no model calls. Scoring of collected records works today; live arms
// are a hook a host fills in later (see README.md).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCases, scoreArm } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = rel => JSON.parse(fs.readFileSync(path.join(here, rel), 'utf8'));

export function planTrials({ cases, protocol, split = null }) {
  const selected = cases.cases.filter(c => !split || c.split === split);
  return protocol.arms.flatMap(arm => selected.flatMap(c => Array.from({ length: protocol.repeats }, (_, repeat) => ({ arm: arm.id, case: c.id, repeat }))));
}

/** Hook for a live arm: given a case and arm, return an assembled review record. Not implemented yet. */
export async function runArm() {
  throw new Error('Live review arms are not wired yet. Run each arm in a host with `ae review prepare/assemble`, save the records, then score them with --score <dir>.');
}

function commitsPresent(repoRoot, cases) {
  const missing = [];
  for (const c of cases.cases) for (const sha of [c.base, c.head]) {
    const r = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) missing.push(`${c.id}: ${sha}`);
  }
  return missing;
}

async function main(argv) {
  const cases = readJson('cases.json'), protocol = readJson('protocol.json');
  const problems = validateCases(cases);
  if (problems.length) { console.error(problems.join('\n')); return 2; }
  const at = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--live')) { await runArm(); return 1; }
  const scoreDir = at('--score');
  if (scoreDir) {
    // <dir>/<arm>/<case>.json holds one assembled review record per case.
    const out = {};
    for (const arm of protocol.arms) {
      const dir = path.join(scoreDir, arm.id);
      if (!fs.existsSync(dir)) continue;
      const records = Object.fromEntries(cases.cases.map(c => { const f = path.join(dir, `${c.id}.json`); return [c.id, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null]; }));
      out[arm.id] = scoreArm({ cases: cases.cases, records, protocol });
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  const missing = commitsPresent(path.resolve(here, '../../../..'), cases);
  const trials = planTrials({ cases, protocol, split: at('--split') });
  console.log(JSON.stringify({ dryRun: true, cases: cases.cases.length, arms: protocol.arms.map(a => a.id), trials: trials.length, missingCommits: missing, status: protocol.status }, null, 2));
  return missing.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
