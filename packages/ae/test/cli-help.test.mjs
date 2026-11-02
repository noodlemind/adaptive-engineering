import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyRetired, syncAssetsToTarget } from '../lib/sync.mjs';
import { parsePlanFrontmatter } from '../lib/plan-parse.mjs';
import { scanPlansForGate } from '../lib/gate.mjs';
import { CONTEXT_PACK_MAX_BYTES, buildContextPack } from '../lib/context-pack.mjs';
import { extractGoalFromPlan } from '../lib/plan-goal.mjs';
import { loadPlan } from '../lib/plan-parse.mjs';
import { createEvidenceBinding, readEvidence, validateEvidence, writeEvidence } from '../lib/evidence.mjs';
import { ensureHarnessDir } from '../lib/session.mjs';
import { installGlobalHarnessShim, globalHarnessShimPath, INSTALL_FIX_HINT } from '../lib/global-bin.mjs';
import { harnessRunnerSource, RUNNER_VERSION, writeHarnessRunner } from '../lib/resolve-harness-bin.mjs';
import { installHarnessBin } from '../lib/install-harness-bin.mjs';
import { recordSkillUsage } from '../lib/telemetry.mjs';
import { mergeVSCodeSettings, parseVSCodeSettings } from '../lib/vscode-settings.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { validatePlanScope } from '../lib/plan-scope.mjs';
import { listCommands } from '../lib/registry.mjs';
import { HELP_COMMAND_ORDER } from '../bin/ae.mjs';
import YAML from 'yaml';
import { approveProject } from '../lib/trust.mjs';
import { tempDir, runHarness, writePlan, packageRoot, binPath } from './helpers/index.mjs';
import {
  writeKnowledgeSolution,
  runIndex,
  writeProductSolution,
  writeChecks,
  writeVersionedPlan,
  initGit,
  runHook,
  runHookWithPolicy,
  hookResponse,
  assertHookBlocked,
  recordSuccessfulEdit,
} from './helpers/cli-fixtures.mjs';

function readEvents(workspace) {
  const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('help works from a clean repo checkout without installed package deps', () => {
  const result = runHarness(['help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /^setup\s+host · mcp · install · upgrade/m);
  assert.match(result.stdout, /Choose a host: ae host list · ae host setup/);
  assert.match(result.stdout, /^ae /);
});

test('HELP_COMMAND_ORDER covers exactly the registered commands — nothing silently vanishes from help', () => {
  const registered = listCommands();
  const registeredSet = new Set(registered);
  const orderedSet = new Set(HELP_COMMAND_ORDER);

  assert.equal(HELP_COMMAND_ORDER.length, new Set(HELP_COMMAND_ORDER).size, 'HELP_COMMAND_ORDER must not list a command twice');

  const missingFromHelp = registered.filter((name) => !orderedSet.has(name));
  assert.deepEqual(missingFromHelp, [], `registered command(s) missing from HELP_COMMAND_ORDER (would vanish from "ae help"): ${missingFromHelp.join(', ')}`);

  const staleInHelp = HELP_COMMAND_ORDER.filter((name) => !registeredSet.has(name));
  assert.deepEqual(staleInHelp, [], `HELP_COMMAND_ORDER name(s) no longer registered: ${staleInHelp.join(', ')}`);
});
