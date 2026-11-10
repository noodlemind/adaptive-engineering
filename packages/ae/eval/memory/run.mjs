#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { authorizeFixtureChecks, memoryAgentArgs, runAgentProcess, resolveStudyOutput, runStudy, runnableArms } from './study.mjs';
import { PROVIDERS } from '../../lib/provider.mjs';

const args = process.argv.slice(2);
const options = {};
const allowed = ['out', 'provider', 'model', 'split', 'repeats', 'arms'];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live') { options.live = true; continue; }
  if (args[i] === '--allow-auto') { options.allowAuto = true; continue; }
  const name = args[i].slice(2);
  if (!args[i].startsWith('--') || !allowed.includes(name) || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid argument: ${args[i]}`);
  options[name] = args[++i];
}
if (!options.out) throw new Error('--out <new-external-directory> is required');
// A plain positive decimal integer only: Number() would also take '0x2', '1e1' or ' 3 '.
if (options.repeats !== undefined && !/^[1-9][0-9]*$/.test(options.repeats)) throw new Error('--repeats must be a positive decimal integer');
const checkout = path.resolve(import.meta.dirname, '../../../..');
const out = resolveStudyOutput({ checkout, output: options.out });
if (options.live && (!Object.hasOwn(PROVIDERS, options.provider) || !options.model)) throw new Error('live runs require an explicit provider and model; no fallback is selected');
if (options.live && options.model.trim().toLowerCase() === 'auto') {
  if (!options.allowAuto) throw new Error('Auto diagnostics require explicit --allow-auto; results cannot qualify promotion');
  if (options.provider !== 'github-copilot') throw new Error('--allow-auto supports native GitHub Copilot Auto only');
  options.model = 'auto';
}
const split = options.split || 'all';
if (!['all', 'development', 'held-out'].includes(split)) throw new Error('split must be all, development or held-out');
const bin = path.resolve(import.meta.dirname, '../../bin/ae.mjs');

async function execute(fixture) {
  const { workspace, copilotHome, harnessHome, protocol, env } = fixture;
  const common = ['--workspace', workspace, '--copilot-home', copilotHome, '--harness-home', harnessHome, '--no-events', '--json'];
  const setup = spawnSync(process.execPath, [bin, 'config', 'set', 'agent.enabled', 'true', '--scope', 'user', ...common], { env, encoding: 'utf8', timeout: 15_000 });
  if (setup.error || setup.status !== 0) throw new Error(`fixture configuration failed: ${setup.error?.code || setup.stderr?.slice(0, 1000)}`);
  // The operator, not the agent, registers the public verifier as a named check and grants fixture trust.
  authorizeFixtureChecks(fixture);
  // Its own process group, killed after the task, so nothing the agent left running reaches the next task's restore.
  const result = await runAgentProcess(process.execPath, [bin, 'agent', ...memoryAgentArgs({ ...fixture, provider: options.provider })], { cwd: workspace, env, timeoutMs: (protocol.maxSeconds + 30) * 1000, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw new Error(`agent process failed: ${result.error.code}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`agent returned no result (exit ${result.status}): ${result.stderr?.slice(0, 1000)}`); }
}

const result = await runStudy({ root: out, split, dryRun: !options.live, execute, model: options.model || null,
  host: options.live ? `cli:${options.provider}` : 'dry-run',
  arms: options.arms ? options.arms.split(',') : runnableArms(),
  ...(options.repeats ? { repeats: Number(options.repeats) } : {}),
});
console.log(JSON.stringify({ output: out, ...result.summary }, null, 2));
