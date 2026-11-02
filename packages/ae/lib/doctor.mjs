import { gitExecutable, spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { completeWork } from './completion.mjs';
import { runCompound } from './compound.mjs';
import { loadPolicy } from './policy.mjs';
import { resolveIndexDir } from './recall-config.mjs';
import { isIndexStale } from './postings-index.mjs';
import { loadManifest } from './recall-rank.mjs';
import { resolveHarnessBin, RUNNER_VERSION, workspaceRunnerStatus } from './resolve-harness-bin.mjs';
import { globalHarnessShimPath, findHarnessOnPath } from './global-bin.mjs';
import { readLock } from './lock.mjs';
import { planDigest } from './evidence.mjs';
import { loadPlan } from './plan-parse.mjs';
import { runVerify } from './verify.mjs';
import { approveProject } from './trust.mjs';
import { readSession, writeSession } from './session.mjs';
import { parseVSCodeSettings, vscodeCustomizationLocations } from './vscode-settings.mjs';
import { harnessGlobalHome, resolveIntelliJHome, resolveVSCodeSettingsPaths } from './paths.mjs';
import { loadRetired, findStaleOrphans } from './sync.mjs';
import { storeDir, storeDirForId, repoId, localRepoId, workspaceStorageId, listLearnings, readSavedLearningFiles, matchingLocalStoreIds, carriedBytesDiffer } from './knowledge/store.mjs';
import { storageIdForRepo } from './storage-aliases.mjs';
import { consolidateStatus } from './knowledge/consolidate.mjs';
import { loadRoutingPolicy } from './routing-policy.mjs';
import { listBuckets } from './knowledge/overlay.mjs';
import { branchExists } from './knowledge/layer.mjs';
import { deriveGitContext, resolveDefaultBranch } from './git-context.mjs';
import { loadReportEvents, knowledgeSlos } from './report.mjs';
import { recoveryDiagnostics } from './diagnostics.mjs';
import { readStructuralIndex } from './repo-map/structural-index.mjs';
import { grammarStatus, packageGrammarRoots } from './repo-map/treesitter-extractor.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';
import { leftoverWorkspaceArtifacts } from './migrate-layout.mjs';
import { planReadDirs } from './project-layout.mjs';

const MIN_ENRICHED_RATIO = 0.5;

function fieldText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEntryEnriched(entry) {
  return ['symptom', 'module', 'trigger', 'summary', 'excerpt', 'claim'].some((key) => fieldText(entry?.[key]));
}

function manifestStamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function hookCommands(config, event) {
  return (config?.hooks?.[event] || []).flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : [entry]));
}

function commandScript(command, hookRoot) {
  const match = String(command?.command || '').match(/^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!match) return null;
  const script = match[1] || match[2] || match[3];
  const cwd = command.cwd ? path.resolve(command.cwd) : hookRoot;
  return path.isAbsolute(script) ? script : path.resolve(cwd, script);
}

function loadInstalledHookConfig(hookRoot) {
  const configPath = path.join(hookRoot, 'hooks.json');
  if (!fs.existsSync(configPath)) return { config: null, error: 'Installed hooks/hooks.json is missing' };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const requiredEvents = ['PreToolUse', 'PostToolUse', 'Stop'];
    for (const event of requiredEvents) {
      if (hookCommands(config, event).length === 0) throw new Error(`${event} is not registered`);
    }
    for (const event of Object.keys(config.hooks || {})) {
      for (const command of hookCommands(config, event)) {
        const script = commandScript(command, hookRoot);
        if (!script || !fs.existsSync(script)) throw new Error(`${event} command is not resolvable: ${command.command}`);
      }
    }
    return { config, error: null };
  } catch (error) {
    return { config: null, error: error.message };
  }
}

function vscodeDiscoveryConfigured(settingsPaths, copilotHome) {
  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const settings = parseVSCodeSettings(fs.readFileSync(settingsPath, 'utf8'));
      const locations = Object.entries(vscodeCustomizationLocations(copilotHome)).every(([key, location]) => settings[key]?.[location] === true);
      const nested = settings['chat.subagents.allowInvocationsFromSubagents'] === true;
      if (locations && nested && settings['chat.useAgentSkills'] === true && settings['chat.customAgentInSubagent.enabled'] === true) return true;
    } catch {
      // A parseable-settings check is represented by this false result.
    }
  }
  return false;
}

function fixturePlan() {
  return `---
plan_schema: 1
title: "VS Code hook doctor fixture"
type: fix
status: in-progress
plan_lock: true
phase: 1
risk: green
intent: "Prove the installed hook lifecycle"
expected_outputs: ["hook evidence"]
success_criteria: ["AC1 Hook probe passes"]
verification:
  required: [hook-probe]
  criteria:
    AC1: [hook-probe]
reviews:
  required: []
  completed: []
  critical_open: []
skills_used: [engineer]
capability_gaps: []
---

# VS Code hook doctor fixture

## Overview

Exercise installed hooks in an isolated fixture.

## Intent Contract

- **Goal:** Prove the installed hook lifecycle.
- **Expected outputs:** Hook evidence.
- **Success criteria:** AC1 passes.

## Acceptance Criteria

- [x] **AC1** Hook probe passes.

## Plan

### Phase 1 — Probe

- [x] Exercise the hook lifecycle.

## Impacted Files

- \`src/schema.json\`

## Verification Plan

- Run the trusted hook probe.

## Risk & Review Routing

- Green fixture-only risk.

## Review Findings

- None.

## Activity

- Doctor fixture created.
`;
}

function runHook(script, workspace, payload, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: workspace,
    input: JSON.stringify({
      cwd: workspace,
      session_id: 'doctor-vscode-session',
      ...payload,
    }),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ENFORCEMENT: 'enforce', ...env },
    timeout: 15_000,
  });
}

function hookBlocked(result, event) {
  if (result.status === 2) return true;
  try {
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const output = line ? JSON.parse(line) : {};
    if (event === 'PreToolUse') {
      return (
        output.hookSpecificOutput?.permissionDecision === 'deny' || output.permissionDecision === 'deny'
      );
    }
    return output.hookSpecificOutput?.decision === 'block' || output.decision === 'block';
  } catch {
    return false;
  }
}

// P1.6: async — runVerify (lib/verify.mjs) is now async (AC8, wired onto
// lib/runner.mjs's async spawn). Nothing about this fixture probe's own
// behavior changes; it just has to await the one call it already made.
export async function runVSCodeHookProbe(hookRoot) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-vscode-'));
  // The probe's own throwaway user scope. The approval below belongs to this
  // fixture and must not accumulate temp-directory entries in the real
  // ~/.copilot trust store every time someone runs `ae doctor`.
  const doctorCopilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-home-'));
  const previousHome = process.env.HARNESS_HOME;
  const previousAeHome = process.env.AE_HOME;
  process.env.HARNESS_HOME = doctorCopilotHome;
  process.env.AE_HOME = doctorCopilotHome;
  const probeBin = fileURLToPath(new URL('../bin/ae.mjs', import.meta.url));
  const probeHook = (script, workspace, payload) => runHook(script, workspace, payload, { COPILOT_HOME: doctorCopilotHome, AE_HOME: doctorCopilotHome, HARNESS_HOME: doctorCopilotHome, AE_BIN: probeBin, HARNESS_BIN: probeBin });
  const planRel = 'docs/plans/vscode-hook-doctor-plan.md';
  const result = {
    recognized: false,
    missingGateDenied: false,
    gatedAllowed: false,
    postRecorded: false,
    unverifiedDenied: false,
    verifiedAllowed: false,
  };
  try {
    fs.mkdirSync(path.join(workspace, 'docs', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.github', 'harness'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, planRel), fixturePlan());
    fs.writeFileSync(path.join(workspace, 'src', 'schema.json'), '{}\n');
    fs.writeFileSync(
      path.join(workspace, '.github', 'harness', 'policy.yaml'),
      'version: 1\nenforcement: enforce\ngate_ttl_minutes: 30\nevidence_ttl_hours: 24\n'
    );
    fs.writeFileSync(
      path.join(workspace, '.github', 'harness', 'checks.yaml'),
      `version: 1\nchecks:\n  hook-probe:\n    command: ${JSON.stringify([process.execPath, '-e', 'process.exit(0)'])}\n`
    );
    const git = (args) => {
      try {
        return spawnGitSync(args, {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        });
      } catch (error) { return { status: null, error }; }
    };
    if (git(['init', '-q']).status !== 0) return result;
    git(['config', 'user.email', 'harness@example.test']);
    git(['config', 'user.name', 'Harness Doctor']);
    git(['add', '.']);
    if (git(['commit', '-qm', 'fixture']).status !== 0) return result;

    // P3AC6: named checks execute repo-authored argv and are gated on trust.
    // This fixture is not a repository anyone cloned — the doctor created the
    // directory and wrote `checks.yaml` itself moments ago, so the code it is
    // about to run is the harness's own. Approving it is a statement of that
    // fact, not a bypass: the probe would otherwise fail V9 for a reason that
    // has nothing to do with the hook behavior it exists to prove.
    approveProject({ workspace, copilotHome: doctorCopilotHome });

    const pre = path.join(hookRoot, 'require-plan-gate.mjs');
    const post = path.join(hookRoot, 'record-successful-edit.mjs');
    const stop = path.join(hookRoot, 'require-verification.mjs');
    const mutation = {
      hook_event_name: 'PreToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/schema.json' },
    };
    const missing = probeHook(pre, workspace, mutation);
    result.missingGateDenied = hookBlocked(missing, 'PreToolUse');
    const eventsPath = path.join(workspace, '.harness', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      result.recognized = events.some(
        (event) => event.type === 'pre_tool' && event.tool === 'replace_string_in_file' && event.targetResolved === true
      );
    }

    writeSession(workspace, {
      sessionId: 'doctor-vscode-session',
      activePlan: planRel,
      gatedPlan: planRel,
      gatedPlanDigest: planDigest(fs.readFileSync(path.join(workspace, planRel), 'utf8')),
      gateStatus: 'pass',
      lastGateAt: new Date().toISOString(),
    });
    const allowed = probeHook(pre, workspace, mutation);
    result.gatedAllowed = allowed.status === 0 && !hookBlocked(allowed, 'PreToolUse');

    const postResult = probeHook(post, workspace, {
      hook_event_name: 'PostToolUse',
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'src/schema.json' },
      tool_response: 'File edited successfully',
    });
    const afterPost = readSession(workspace);
    result.postRecorded = postResult.status === 0 && Boolean(afterPost?.lastEditAt);

    const deniedStop = probeHook(stop, workspace, { hook_event_name: 'Stop', stop_hook_active: false });
    result.unverifiedDenied = hookBlocked(deniedStop, 'Stop');

    const plan = loadPlan(workspace, planRel);
    const verification = await runVerify({
      workspace,
      flags: { plan: planRel, base: 'HEAD', dryRun: false, enforcement: 'enforce', copilotHome: doctorCopilotHome },
    });
    if (verification.outcome === 'passed' && plan) {
      writeSession(workspace, {
        ...readSession(workspace),
        activePlan: planRel,
        lastVerifyAt: new Date().toISOString(),
        lastVerifyOutcome: verification.outcome,
        lastEvidencePath: verification.evidencePath,
      });
      const decisionPath = path.join(workspace, '.harness/doctor-learning.json');
      fs.writeFileSync(decisionPath, JSON.stringify({ operation: 'doctor-fixture-learning', decision: 'no-learning', rationale: 'Disposable verification fixture has no durable product lesson.' }));
      const learning = await runCompound({ workspace, copilotHome: doctorCopilotHome, flags: { plan: planRel, learningDecision: decisionPath } });
      if (!learning.pass) return result;
      completeWork({ workspace, plan, copilotHome: doctorCopilotHome });
      fs.writeFileSync(path.join(workspace, planRel), plan.text.replace(/^status: in-progress$/m, 'status: done'));
      const allowedStop = probeHook(stop, workspace, { hook_event_name: 'Stop', stop_hook_active: false });
      const endEvents = fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [];
      result.verifiedAllowed =
        allowedStop.status === 0 &&
        !hookBlocked(allowedStop, 'Stop') &&
        endEvents.some((event) => event.type === 'session_end' && event.result === 'pass');
    }
    return result;
  } finally {
    // BOTH fixtures. Only `workspace` was removed, so every
    // `ae doctor --host vscode` left a `harness-doctor-home-*` directory
    // behind — with a trust store inside it. The stated goal above was to stop
    // fixture state accumulating; without this it accumulated in tmpdir instead
    // of ~/.copilot, which is a move rather than a fix.
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(doctorCopilotHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    if (previousAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = previousAeHome;
  }
}

async function installedHookChecks({ copilotHome, settingsPaths = [], target }) {
  const vscode = target === 'vscode', prefix = vscode ? 'V' : 'C', host = vscode ? 'VS Code' : 'Copilot CLI';
  const hookRoot = path.join(copilotHome, 'hooks');
  const installed = fs.existsSync(path.join(hookRoot, 'hooks.json'));
  const loaded = installed ? loadInstalledHookConfig(hookRoot) : { config: null, error: 'Installed hook bundle is missing' };
  const probe = loaded.config ? await runVSCodeHookProbe(hookRoot) : {};
  return [
    { id: `${prefix}1`, name: `${host} hook bundle installed`, pass: installed, hint: `Run: ae install --target ${target}` },
    { id: `${prefix}2`, name: `${host} hook configuration and commands resolvable`, pass: Boolean(loaded.config), hint: loaded.error || 'Mechanical compatibility probe; actual native host discovery is unverified' },
    ...(vscode ? [{ id: 'V3', name: 'VS Code user customization discovery configured', pass: vscodeDiscoveryConfigured(settingsPaths, copilotHome), hint: 'Run: ae install --target vscode --configure-vscode with the selected --copilot-home — sets agents, instructions, skills, chat.hookFilesLocations and chat.subagents.allowInvocationsFromSubagents' }] : []),
    { id: `${prefix}4`, name: `${host} compatible mutation payload recognized`, pass: Boolean(probe.recognized), hint: 'Inspect payload normalization and hook events' },
    { id: `${prefix}5`, name: 'Missing-gate mutation denied', pass: Boolean(probe.missingGateDenied), hint: 'Inspect PreToolUse policy output' },
    { id: `${prefix}6`, name: 'Gated scoped mutation allowed', pass: Boolean(probe.gatedAllowed), hint: 'Inspect plan gate and scope handling' },
    { id: `${prefix}7`, name: 'Successful PostToolUse event recorded', pass: Boolean(probe.postRecorded), hint: 'Inspect record-successful-edit.mjs' },
    { id: `${prefix}8`, name: 'Completion without verification denied', pass: Boolean(probe.unverifiedDenied), hint: 'Inspect Stop hook registration and evidence checks' },
    { id: `${prefix}9`, name: 'Completion after passed verification allowed', pass: Boolean(probe.verifiedAllowed), hint: 'Inspect evidence binding and freshness' },
  ];
}

function selectedDoctorTarget(flags) {
  const targets = flags.targetsExplicit ? [...flags.targets] : [];
  const fail = message => { throw Object.assign(new Error(message), { code: 'E_USAGE', exit: 2 }); };
  if (flags.targetsExplicit && targets.length !== 1) fail('doctor requires one target: vscode, cli, or intellij');
  if (targets.length && flags.host && targets[0] !== flags.host) fail('doctor --target conflicts with --host');
  const target = targets[0] || flags.host || null;
  return target;
}

// Knowledge-layer health (design §2, §3, §12). All three are optional/advisory
// and each independently try/catch-guarded — a store or event-read failure
// degrades to "skip that check", never to a doctor crash. K2's consolidateStatus
// call is only made once storeDir already exists (like orient.mjs) — doctor
// must never materialize a store — and copilotHome is threaded through so
// its episode/debt computation uses the same roots as every other caller.
function knowledgeChecks({ workspace, copilotHome }) {
  const checks = [];

  try {
    const events = loadReportEvents({ workspace });
    const hasConsolidateEvent = events.some(
      (e) => e.type === 'consolidate' && e.decision === 'apply' && e.result === 'pass'
    );
    const storeExists = fs.existsSync(storeDir(workspace));
    checks.push({
      id: 'K1',
      name: 'Knowledge store present for consolidated history',
      pass: !hasConsolidateEvent || storeExists,
      hint: 'knowledge store missing — restore from backup or run: ae consolidate --rebuild --yes after re-arming',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  try {
    const storeExists = fs.existsSync(storeDir(workspace));
    const quarantined = storeExists ? consolidateStatus({ workspace, copilotHome }).quarantined.length : 0;
    checks.push({
      id: 'K2',
      name: 'No quarantined episode clusters',
      pass: quarantined === 0,
      hint: 'quarantined episode cluster(s) — inspect with ae consolidate --status',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  try {
    const slos = knowledgeSlos(loadReportEvents({ workspace }));
    const noisy = slos.utilizationWeighted !== null && slos.utilizationWeighted < 0.15 && slos.surfacedOccurrences >= 20;
    checks.push({
      id: 'K3',
      name: 'Knowledge utilization above noise threshold',
      pass: !noisy,
      hint: 'knowledge layer is noise (<15% utilization) — consider: ae knowledge off',
      optional: true,
    });
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  // Both legacy-only and split-store states require recovery after an ID change.
  try {
    const currentId = repoId(workspace);
    const hasRemote = !currentId.startsWith('local-');
    let stranded = false;
    let hint = 'ae knowledge migrate-store';
    if (!hasRemote) {
      const selected = workspaceStorageId(workspace);
      const currentHome = harnessGlobalHome();
      const bound = storageIdForRepo(currentId, { home: currentHome });
      const pending = selected !== bound
        ? [selected]
        : matchingLocalStoreIds(workspace, { home: currentHome }).ids.filter((id) => id !== bound && carriedBytesDiffer(currentHome, id, bound));
      if (pending.length) {
        stranded = true;
        hint = `saved knowledge or plans use the old path ID ${pending[0]}; ae knowledge migrate-store copies them into ${bound} and leaves the source in place`;
      }
    } else {
      const legacyDir = storeDirForId(localRepoId(workspace));
      const currentDir = storeDirForId(currentId);
      const legacyFiles = readSavedLearningFiles(legacyDir);
      const currentFiles = readSavedLearningFiles(currentDir);
      let missing = 0;
      let conflict = 0;
      for (const [rel, text] of legacyFiles) {
        if (!currentFiles.has(rel)) missing += 1;
        else if (currentFiles.get(rel) !== text) conflict += 1;
      }
      if (legacyDir !== currentDir && (missing || conflict)) {
        stranded = true;
        hint = conflict
          ? `saved learnings at ${legacyDir} differ from ${currentDir}; the source stays in place. ae knowledge migrate-store copies missing files and does not overwrite either copy`
          : `saved learnings at ${legacyDir} are missing from ${currentDir} — run: ae knowledge migrate-store`;
      }
    }
    checks.push({
      id: 'K4',
      name: 'Saved storage remains bound after a repository ID change',
      pass: !stranded,
      hint,
      optional: true,
    });
  } catch (error) {
    checks.push({ id: 'K4', name: 'Saved storage remains bound after a repository ID change', pass: false, hint: error.message, optional: true });
  }

  // K5 (blueprint P6): a bucket whose branch no longer exists locally or on
  // any remote is an orphan — its work was merged, deleted, or abandoned;
  // the bucket sits as store growth until a human prunes it. Detached
  // buckets carry no branch to check and are aged out via prune --stale
  // instead. `branchExists` returning null means git state was unverifiable
  // — never reported as an orphan.
  try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const orphans = [];
      for (const bucket of listBuckets(dir)) {
        const branch = bucket.meta?.branch;
        if (!branch) continue;
        if (branchExists(workspace, branch) === false) orphans.push(bucket.key);
      }
      checks.push({
        id: 'K5',
        name: 'No orphan branch buckets (branch gone locally and on remotes)',
        pass: orphans.length === 0,
        hint: orphans.length
          ? `orphan bucket(s): ${orphans.join(', ')} — run: ae knowledge prune --branch <key> (or --merged/--stale)`
          : 'ae knowledge prune',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  // K6 (blueprint P6): layer misroute — bucket contents whose `branch:`
  // provenance disagrees with the bucket's own meta.json branch. A learning
    try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const misrouted = [];
      for (const bucket of listBuckets(dir)) {
        const metaBranch = bucket.meta?.branch;
        if (!metaBranch) continue;
        for (const l of listLearnings(bucket.dir)) {
          if (l.fm.branch && l.fm.branch !== metaBranch) misrouted.push(`${bucket.key}:${l.id}`);
        }
      }
      checks.push({
        id: 'K6',
        name: 'Bucket contents match their bucket branch (no layer misroute)',
        pass: misrouted.length === 0,
        hint: misrouted.length
          ? `misrouted learning(s): ${misrouted.slice(0, 5).join(', ')} — inspect the bucket, then knowledge prune or re-consolidate on the right branch`
          : 'inspect with ae knowledge status',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

    try {
    const dir = storeDir(workspace);
    if (fs.existsSync(dir)) {
      const context = deriveGitContext({ workspace });
      const unresolved = Boolean(context.branch) && !resolveDefaultBranch(workspace, {});
      checks.push({
        id: 'K7',
        name: 'Default branch resolvable for knowledge layer routing',
        pass: !unresolved,
        hint: 'set defaultBranch in the store config.json or run: git remote set-head origin -a — until then writes fail closed to branch-local',
        optional: true,
      });
    }
  } catch {
    // Advisory; never fail doctor on a knowledge-check error.
  }

  return checks;
}

export function structuralChecks({ workspace, grammarRoots = packageGrammarRoots(), lockPath } = {}) {
  const checks = [];
  try {
        const disk = grammarStatus({ grammarRoots, lockPath });
    const index = readStructuralIndex(workspace);
    const recorded = index?.meta?.integrityFailures || [];
        const stale = recorded.filter((f) => disk.grammars?.[f.language]?.ok === true);
    const live = recorded.filter((f) => !stale.includes(f));
    const mismatches = [...disk.integrityFailures, ...live];
    if (mismatches.length) {
      const languages = [...new Set(mismatches.map((f) => f.language))].join(', ');
      const lockGone = mismatches.some((f) => f.language === 'lock');
      checks.push({
        id: 'S1',
        name: 'Structural index grammar integrity',
        pass: false,
        hint: lockGone
          ? `grammars.lock missing or unreadable — wasm integrity cannot be verified and the treesitter tier is refused; reinstall the harness package, then re-run: ae index --structural`
          : `grammar wasm sha256 mismatch vs grammars.lock (${languages}) — the index fell back to lexical loudly; reinstall the AE package to restore shipped parser assets, then re-run: ae index --structural`,
      });
      return checks;
    }
    if (!index) {
      checks.push({
        id: 'S1',
        name: 'Structural index (optional tier)',
        pass: true,
        optional: true,
        hint: 'not built — run: ae index --structural',
      });
      return checks;
    }
    const issues = [];
    if (stale.length) {
      const languages = [...new Set(stale.map((f) => f.language))].join(', ');
      issues.push(`index meta still records a grammar integrity mismatch (${languages}) that the current wasm no longer has — re-run: ae index --structural`);
    }
        if (index.unreadable?.length) issues.push(`${index.unreadable.join('; ')} — delete the index directory and re-run: ae index --structural`);
    const head = spawnGitSync(['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
    const headSha = head.status === 0 ? head.stdout.trim() : null;
    if (index.meta.sha && headSha && index.meta.sha !== headSha) {
      issues.push('meta.sha behind HEAD — re-run: ae index --structural');
    }
    const filesIndexed = Math.max(index.meta.filesIndexed || Object.keys(index.files).length, 1);
    const failRate = (index.meta.parseFailures || 0) / filesIndexed;
    if (failRate > 0.2) issues.push(`parse-failure rate ${(failRate * 100).toFixed(0)}% — inspect grammar installation`);
        let orphans = 0;
    for (const rel of Object.keys(index.files).slice(0, 500)) {
      const full = assertNoSymlinkAncestors(workspace, rel);
      if (!full || !fs.existsSync(full)) orphans += 1;
    }
    if (orphans) issues.push(`${orphans} orphaned cache entries — pruned on the next ae index --structural`);
    checks.push({
      id: 'S1',
      name: 'Structural index health',
      pass: issues.length === 0,
      optional: true,
      hint: issues.length ? issues.join(' · ') : 'current with HEAD; grammars verified',
    });
  } catch {
    // Advisory; never fail doctor on a structural-check error.
  }

  return checks;
}

function routingPolicyCheck(workspace) {
  const loaded = workspace ? loadRoutingPolicy(workspace) : { missing: true, errors: [] };
  const invalid = !loaded.missing && loaded.errors.length > 0;
  return {
    id: 'H-route',
    name: 'Delivery routing policy',
    pass: !invalid,
    optional: true,
    hint: loaded.missing
      ? 'No routing.yaml in the selected project configuration — new plans record a skipped snapshot'
      : invalid
        ? loaded.errors.join('; ')
        : 'routing.yaml parsed',
  };
}

export function prerequisiteChecks({ resolveGit = gitExecutable } = {}) {
  const major = Number(String(process.versions.node).split('.')[0]);
  const nodeOk = Number.isInteger(major) && major >= 20;
  let git;
  try { git = spawnSync(resolveGit(), ['--version'], { encoding: 'utf8', timeout: 5_000 }); }
  catch (error) { git = { error }; }
  const gitOk = !git.error && git.status === 0 && Boolean(String(git.stdout || '').trim());
  return [
    {
      id: 'R1',
      name: 'Node.js',
      pass: nodeOk,
      hint: nodeOk ? `Node ${process.versions.node}` : `Node ${process.versions.node} is older than 20`,
    },
    {
      id: 'R2',
      name: 'git',
      pass: gitOk,
      hint: gitOk ? String(git.stdout).trim() : git.error?.code === 'E_GIT_EXECUTABLE' ? git.error.message : 'git is not installed or not on PATH',
    },
  ];
}

export async function runDoctor({ copilotHome, assetsRoot, pkgRoot, flags, vscodeSettingsPaths = null, workspace = flags.workspace }) {
  const target = selectedDoctorTarget(flags);
  const customizationOnly = target === 'intellij';
  if (customizationOnly) copilotHome = resolveIntelliJHome();
  const checks = [...prerequisiteChecks()];
  if (['vscode', 'cli', 'intellij'].includes(target)) checks.push({
    id: 'T0', name: `Selected ${target} customization home`, pass: true, target, home: copilotHome,
    capabilities: { customizations: 'declared', nativeHooks: customizationOnly ? 'unsupported' : 'supported', liveHost: 'unverified' },
    hint: customizationOnly ? 'Customization files can be inspected; JetBrains native lifecycle hooks are unavailable' : 'Installed hook probes are mechanical checks; native host activation is unverified',
  });

  const manifest = path.join(copilotHome, 'knowledge', 'manifest.yaml');
  checks.push({
    id: 'H1',
    name: 'Global knowledge manifest',
    pass: fs.existsSync(manifest),
    hint: 'Run: ae install',
  });

  const profile = path.join(copilotHome, 'knowledge', 'profile.md');
  checks.push({
    id: 'H2',
    name: 'Profile (autonomy)',
    pass: fs.existsSync(profile),
    hint: 'install seeds knowledge/profile.md from template',
  });

  const engineer = path.join(copilotHome, 'agents', 'engineer.agent.md');
  checks.push({
    id: 'H3',
    name: 'Engineer agent',
    pass: fs.existsSync(engineer),
    hint: 'Run: ae install',
  });

  const captureGate = path.join(
    copilotHome,
    'skills',
    'references',
    'capture-gate.md'
  );
  checks.push({
    id: 'H4',
    name: 'Capture gate reference',
    pass: fs.existsSync(captureGate),
    hint: 'Re-run install',
  });

  try {
    checks.push({
      id: 'H5',
      name: 'Product plans directory',
      pass: planReadDirs(workspace, { home: flags.harnessHome || flags.home }).length > 0,
      hint: 'ae init-repo',
    });
  } catch (error) {
    checks.push({ id: 'H5', name: 'Product plans directory', pass: false, hint: error.message });
  }

  const entReg = path.join(copilotHome, 'enterprise', 'capability-registry.enterprise.yaml');
  checks.push({
    id: 'H6',
    name: 'Enterprise overlay (optional)',
    pass: fs.existsSync(entReg),
    hint: 'Optional: add enterprise pack or install base harness',
    optional: true,
  });

  for (const skill of ['ensure-plan', 'auto-compound', 'ensure-capability', 'auto-skill-draft']) {
    const p = path.join(copilotHome, 'skills', skill, 'SKILL.md');
    checks.push({
      id: 'H7',
      name: `Autopilot skill /${skill}`,
      pass: fs.existsSync(p),
      hint: 'Run: ae upgrade',
    });
  }

  checks.push({
    id: 'H8',
    name: 'Corpus in package',
    pass: fs.existsSync(path.join(assetsRoot, 'skills', 'engineer', 'SKILL.md')),
    hint: 'Reinstall the packaged CLI',
  });

    const lock = readLock(copilotHome);
  let installedVersion = null;
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch {
    // Unreadable package.json — fall back to presence-only, the pre-existing check.
  }
  const lockCurrent = Boolean(lock) && (installedVersion === null || lock.version === installedVersion);
  checks.push({
    id: 'H9',
    name: 'Harness lock file matches the installed version',
    pass: lockCurrent,
    hint: !lock
      ? 'Run install or upgrade'
      : lockCurrent
        ? `hydrated from ${lock.package}@${lock.version}`
        : `ae ${installedVersion} is installed but the Copilot home was hydrated from ${lock.version} — run: ae upgrade`,
    optional: true,
  });

  const { entries: manifestEntries, updated: manifestUpdatedRaw, sha256: manifestSha256, error: manifestError } = loadManifest(copilotHome, flags.workspace, { home: flags.harnessHome || flags.home });
  const manifestUpdated = manifestStamp(manifestUpdatedRaw);
  if (manifestError) {
    checks.push({
      id: 'H10',
      name: 'Manifest enriched fields (symptom/module)',
      pass: false,
      hint: 'Run: ae index — rebuilds symptom, module, trigger, summary, and excerpt from solution files',
    });
    checks.push({
      id: 'H11',
      name: 'BM25 postings index fresh',
      pass: false,
      hint: 'Run: ae index — rebuild the knowledge postings index',
    });
  } else if (manifestEntries.length === 0) {
    checks.push({
      id: 'H10',
      name: 'Manifest enriched fields (symptom/module)',
      pass: true,
      status: 'n/a',
      optional: true,
      hint: 'n/a — no learnings to enrich',
    });
    checks.push({
      id: 'H11',
      name: 'BM25 postings index fresh',
      pass: true,
      status: 'n/a',
      optional: true,
      hint: 'n/a — no learnings to index',
    });
  } else {
    const enrichedCount = manifestEntries.filter(isEntryEnriched).length;
    checks.push({
      id: 'H10',
      name: 'Manifest enriched fields (symptom/module)',
      pass: enrichedCount / manifestEntries.length >= MIN_ENRICHED_RATIO,
      hint: 'Run: ae index — rebuilds symptom, module, trigger, summary, and excerpt from solution files',
    });
    let indexFresh = false;
    let indexError = null;
    try {
      const indexDir = resolveIndexDir(copilotHome, flags.workspace, flags.harnessHome || flags.home);
      indexFresh = fs.existsSync(path.join(indexDir, 'meta.json')) && !isIndexStale(indexDir, manifestUpdated, manifestSha256);
    } catch (error) { indexError = error.message; }
    checks.push({
      id: 'H11',
      name: 'BM25 postings index fresh',
      pass: indexFresh,
      hint: indexError || 'Run: ae index — rebuild the knowledge postings index',
    });
  }

  const resolved = resolveHarnessBin({ workspace: flags.workspace, copilotHome });
  checks.push({
    id: 'H12',
    name: 'Harness CLI resolvable',
    pass: customizationOnly || Boolean(resolved.bin),
    ...(customizationOnly ? { status: 'n/a', optional: true } : {}),
    hint: customizationOnly ? 'n/a — IntelliJ installation provides customizations; use a separately installed CLI for Harness commands' : resolved.bin
      ? `Resolved via ${resolved.source}: ${resolved.bin}`
      : 'Run: ae install, then init-repo (creates .harness/run.mjs)',
  });
  const runnerStatus = workspaceRunnerStatus(flags.workspace);
  const runnerExists = runnerStatus.state !== 'missing';
  const runnerCurrent = runnerStatus.state === 'current';
  checks.push({
    id: 'H13',
    name: 'Workspace harness runner',
    pass: runnerExists && runnerCurrent,
    hint: !runnerExists
      ? 'Run: ae init-repo'
      : runnerCurrent
        ? `.harness/run.mjs is current (v${RUNNER_VERSION})`
        : runnerStatus.state === 'stale'
          ? `.harness/run.mjs predates runner v${RUNNER_VERSION} or differs from its generated content — regenerate with: ae init-repo (or run ae upgrade from this workspace)`
          : runnerStatus.state === 'newer'
            ? '.harness/run.mjs requires a newer AE installation; upgrade the selected CLI before regenerating'
            : '.harness/run.mjs is custom, unsafe or unreadable; preserve and inspect it, or use the installed ae command directly',
    optional: true,
  });

  const hooksJson = path.join(copilotHome, 'hooks', 'hooks.json');
  checks.push({
    id: 'H14',
    name: 'Lifecycle hooks bundle',
    pass: customizationOnly || fs.existsSync(hooksJson),
    ...(customizationOnly ? { status: 'n/a' } : {}),
    hint: customizationOnly ? 'n/a — copied scripts do not establish native IntelliJ hook support' : 'Re-run ae install to sync hooks/',
    optional: true,
  });

  const shim = globalHarnessShimPath(copilotHome);
  const cliResolvable = Boolean(resolved.bin);
  checks.push({
    id: 'H15',
    name: 'Global ae shim (~/.copilot/bin/ae)',
    pass: customizationOnly || fs.existsSync(shim),
    ...(customizationOnly ? { status: 'n/a' } : {}),
    hint: customizationOnly ? 'n/a — IntelliJ customization installation does not install a CLI shim' : 'Run: ae install (creates ~/.copilot/bin/ae)',
    optional: customizationOnly || cliResolvable && !fs.existsSync(shim),
  });

  const onPath = Boolean(findHarnessOnPath());
  checks.push({
    id: 'H16',
    name: 'ae on PATH',
    pass: customizationOnly || onPath,
    ...(customizationOnly ? { status: 'n/a' } : {}),
    hint: customizationOnly ? 'n/a — the native IntelliJ customization path does not require the CLI on PATH' : 'Run: ae install --configure-path  (or add ~/.copilot/bin to PATH)',
    optional: true,
  });

    const assetsAvailable = fs.existsSync(path.join(assetsRoot, 'skills', 'engineer', 'SKILL.md'));
    const lockFiles = Array.isArray(lock?.files) && lock.files.length ? new Set(lock.files) : null;
  const orphans =
    pkgRoot && assetsAvailable ? findStaleOrphans(copilotHome, assetsRoot, loadRetired(pkgRoot), lockFiles) : [];
  checks.push({
    id: 'H17',
    name: 'No stale orphaned primitives',
    pass: assetsAvailable && orphans.length === 0,
    hint: !assetsAvailable
      ? 'cannot verify — this runtime has no asset bundle; re-run: ae install (refreshes ~/.copilot/.ae-bin with assets), then ae doctor'
      : orphans.length
        ? `Hydrated but no longer shipped and not retired (${orphans.length}): ${orphans.join(', ')}. Add each to packages/ae/retired.json so upgrade purges it, or delete it from ${copilotHome}.`
        : 'No orphaned agents/skills/instructions/prompts/hooks in the Copilot home',
    optional: true,
  });

  try {
    const leftovers = leftoverWorkspaceArtifacts(flags.workspace);
    checks.push({
      id: 'H18',
      name: 'Gitignored docs artifacts migrated',
      pass: leftovers.length === 0,
      hint: leftovers.length
        ? `ae migrate  # ${leftovers.map((item) => item.from).join(', ')}`
        : 'No leftover gitignored docs/plans or docs/solutions in the product tree',
      optional: true,
    });
  } catch (error) {
    checks.push({ id: 'H18', name: 'Gitignored docs artifacts migrated', pass: false, hint: error.message, optional: true });
  }

  checks.push(routingPolicyCheck(workspace));
  let effectivePolicy = null;
  let policyError = null;
  try {
    effectivePolicy = loadPolicy(workspace, flags.enforcement, { copilotHome });
  } catch (error) {
    policyError = error.message;
  }
  const enforced = effectivePolicy?.enforcement === 'enforce';
  checks.push({
    id: 'P0',
    name: effectivePolicy ? `${customizationOnly ? 'Configured CLI' : 'Installed effective'} policy: ${effectivePolicy.enforcement}` : 'Installed effective policy',
    pass: !policyError && enforced,
    hint: policyError
      ? policyError
      : enforced
        ? `${effectivePolicy.enforcementSource}; critical=${effectivePolicy.rules.critical}; destructive=${effectivePolicy.rules.destructive}`
        : `Effective enforcement is ${effectivePolicy.enforcement} (${effectivePolicy.enforcementSource}). Doctor fails until enforcement is enforce.`,
    ...(effectivePolicy ? { policy: effectivePolicy } : {}),
    ...(customizationOnly ? { optional: true } : {}),
  });
  checks.push(...knowledgeChecks({ workspace, copilotHome }));
  checks.push(...structuralChecks({ workspace }));

  if (target === 'vscode' || target === 'cli') {
    checks.push(
      ...(await installedHookChecks({
        copilotHome,
        target,
        settingsPaths: target === 'vscode' ? vscodeSettingsPaths || resolveVSCodeSettingsPaths() : [],
      }))
    );
  } else if (customizationOnly) {
    checks.push({ id: 'T1', name: 'IntelliJ native lifecycle enforcement', pass: false, status: 'unavailable', optional: true,
      hint: 'JetBrains custom agents and skills do not supply native lifecycle hooks. Use the supported CLI or VS Code surface when hook enforcement is required.' });
    checks.push({ id: 'T2', name: 'IntelliJ global instructions installed', pass: fs.existsSync(path.join(copilotHome, 'global-copilot-instructions.md')),
      hint: 'Run: ae install --target intellij; enable global customizations in the selected IDE' });
  } else if (target) {
    checks.push({ id: 'V0', name: `Unsupported doctor host: ${target}`, pass: false, hint: 'Supported hosts: vscode, cli, intellij' });
  }

  if (typeof flags.adapter === 'string' && flags.adapter) {
    const safe = /^[a-z0-9-]+$/.test(flags.adapter);
    const adapterFile = safe ? path.join(copilotHome, 'hooks', `${flags.adapter}.mjs`) : '';
    checks.push({
      id: 'A1',
      name: `Host adapter ${flags.adapter}`,
      pass: Boolean(adapterFile) && fs.existsSync(adapterFile),
      hint: 'Run: ae install',
    });
  }

  const required = checks.filter((c) => !c.optional);
  const pass = required.every((c) => c.pass);
  return { checks, pass, diagnostics: recoveryDiagnostics({ source: 'doctor', checks, workspace, copilotHome, target, home: flags.harnessHome || flags.home || harnessGlobalHome() }) };
}
