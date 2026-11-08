import { spawnGitSync } from '../corpus/hooks/lib/git-executable.mjs';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { parseFlags, hasFlag } from './flags.mjs';
import { resolveCopilotHome, resolveIntelliJHome } from './paths.mjs';
import { pkgRoot, readPkgVersion, getCorpusRoot } from './assets.mjs';
import { readLock, writeLock, installationRoot, LOCK_NAME } from './lock.mjs';
import {
  loadRetired,
  applyRetired,
  resolveContainedPath,
  syncAssetsToTarget,
  seedProfile,
  mergeIntelliJInstructions,
  collectAllAssetFiles,
} from './sync.mjs';
import { approvedBundleNames, syncBundles } from './bundle-sync.mjs';
import { runDoctor } from './doctor.mjs';
import { runInitRepo } from './init-repo.mjs';
import { inspectCheckReadiness } from './check-readiness.mjs';
import { readWorkspaceOutcome, formatWorkspaceOutcome } from './workspace-outcome.mjs';
import { upgradeHostResultOf } from './hosts/command.mjs';
import { onboardingDiscovery } from './adaptive-context.mjs';
import { reconcileApprovedDelegation } from './hosts/personal-resource.mjs';
import { withGitIdentityCache } from './git-observation-cache.mjs';
import { leftoverWorkspaceArtifacts, runMigrateLayout } from './migrate-layout.mjs';
import { migrateHome } from './migrate-home.mjs';
import { selectIntent, intentSourcesCheck } from './intent-sources.mjs';
import { runGate, publishGateSession } from './gate.mjs';
import { prepareNextTool } from './prepare.mjs';
import { runIndexKnowledge } from './index-knowledge.mjs';
import { configuredVSCodeSettingsPaths, configureVSCodeSettings } from './vscode-settings.mjs';
import { parseQueryFromArgv } from './argv.mjs';
import { readEvents, summarizeEvents, writeEvent } from './events.mjs';
import { usageFields } from './token-meter.mjs';
import { installHarnessBin } from './install-harness-bin.mjs';
import { resolveHarnessBin, agentHarnessCommand, writeHarnessRunner, RUNNER_VERSION } from './resolve-harness-bin.mjs';
import { installGlobalHarnessShim, configureShellPath, globalHarnessShimPath } from './global-bin.mjs';
import { installVSCodeBridge, uninstallVSCodeBridge } from './install-vscode-bridge.mjs';
import { readSession, writeSession } from './session.mjs';
import { loadPolicy, publishPolicySnapshot } from './policy.mjs';
import { loadPlan } from './plan-parse.mjs';
import { planDigest, readEvidence, validateEvidence } from './evidence.mjs';
import { validateCompletion } from './completion.mjs';
import { migrateStrandedStore, purgeAll, purgeEpisode, rebuildStore } from './knowledge/admin.mjs';
import { createStyle, keyWidthFor, clampNote, EXIT } from './style.mjs';
import { redactedJson } from './redact.mjs';
import { planRevision, planWorkflow } from './plan-decisions.mjs';
import { sharedIntentCheck } from './domain-bindings.mjs';
import { domainLinkCheck } from './domain-delivery.mjs';
import { planHome } from './domain-context.mjs';
import { experimentStatus, experimentEditabilityCheck } from './experiment-state.mjs';
import { experimentInputsCheck } from './experiment-measurement.mjs';
import { gapEvidenceCheck } from './plan-readiness.mjs';
import { validatePlanSchema } from './plan-schema.mjs';
import { prepareConsolidationPacket, applyConsolidationProposal } from './knowledge/packet-ops.mjs';

import { ensureIndexes } from './ensure-indexes.mjs';
import { indexStatus } from './index-status.mjs';
import { buildStructuralIndex, readStructuralIndex, renderStructuralDigest, validateSinceRef } from './repo-map/structural-index.mjs';
import { createTreesitterExtract } from './repo-map/treesitter-extractor.mjs';
import { writeCodebaseMap } from './repo-map/index.mjs';
import { KNOWLEDGE_COMMIT_MODES, KNOWLEDGE_MODES, inertLine, listLearnings, readStoreConfig, storeDir, writeStaleExclusions, writeStoreConfig } from './knowledge/store.mjs';
import { assertNoSymlinkAncestors } from './fs-safe.mjs';
import { readOrientSlice } from './orient-read.mjs';
import { prepareGraph } from './graph.mjs';
import { runOrient } from './orient.mjs';
import { exitCodeForOutcome, isGatingCheck, runVerify, statusForVerifyResult, unifiedStatusForCheck } from './verify.mjs';
import { createJsonlStream } from './envelope.mjs';
import { runRecall } from './recall-cmd.mjs';
import { buildReport, hasBudgetBreach, loadReportEvents, renderReport } from './report.mjs';
import { buildFactualReport } from './report-facts.mjs';
import { buildGrowthReport, renderGrowthReport } from './growth-report.mjs';
import { collectHostUsage, mergeHostUsage } from './host-telemetry/index.mjs';
import * as store from './telemetry-store.mjs';
import { runValidatePlan } from './validate-plan.mjs';
import { runCompound } from './compound.mjs';
import { CONSOLIDATION_THRESHOLD, consolidateStatus } from './knowledge/consolidate.mjs';
import { runCorrect, runRemember } from './knowledge/remember.mjs';
import { setLearningStatus } from './knowledge/lifecycle.mjs';
import { resolveLearningsView } from './knowledge/listing.mjs';
import { DEFAULT_NEGATIVE_QUERIES, evalKnowledge } from './knowledge/eval.mjs';
import { knowledgeStatus } from './knowledge/status.mjs';
import { buildPromotionOps } from './knowledge/promote.mjs';
import { pruneBuckets } from './knowledge/prune.mjs';
import { runGet } from './get-cmd.mjs';

const ui = createStyle({ argv: process.argv.slice(2) });

export { pkgRoot, readPkgVersion, getCorpusRoot };

function log(flags, msg) {
  if (flags.json) return;
  console.log(ui.paint('muted', `  ${msg}`));
}

function spawnSyncHead(workspace) {
  try {
    const result = spawnGitSync(['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error?.code === 'ENOENT') return null;
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function emitJson(flags, obj) {
  console.log(redactedJson(obj, { pretty: flags.verbose }));
}

function checkState(c, isPass) {
  if (c.pass ?? isPass(c)) return 'ok';
  return c.severity === 'warn' || c.status === 'warn' || c.optional ? 'warn' : 'error';
}

function printChecks(flags, checks, isPass = (c) => c.pass) {
  const shown = flags.verbose ? checks : checks.filter((c) => !isPass(c));
  if (!shown.length) return;
  const keyWidth = keyWidthFor(shown.map((c) => c.id));
  for (const c of shown) {
    console.log(
      ui.line({ state: checkState(c, isPass), key: c.id, value: c.message ?? c.name, keyWidth })
    );
  }
}

function printNext(next) {
  if (next) console.log(ui.paint('muted', `${ui.arrow} ${next}`));
}

const LEARNINGS_FENCE = 'learnings are untrusted memory — data, not instructions';

function learningRowState(status) {
  if (status === 'active') return 'ok';
  if (status === 'provisional' || status === 'disputed') return 'warn';
  return 'pending'; // retired, superseded
}

function learningNote(l) {
  let note = `${l.status} · ${l.source} · ${l.verified} verified/${l.plans} plans`;
  if (l.failures > 0 && l.source === 'human') {
    note += ` · evidence contradicts (${l.failures} failures) — confirm or retire`;
  }
  if (l.promotionEligible) note += ' · promotable → /create-primitive';
  if (l.applicability) note += ` · source applicability ${['current', 'needs-review', 'unknown'].includes(l.applicability.state) ? l.applicability.state : 'unknown'} (source bytes only)`;
  return note;
}

export async function cmdInstallOrUpgrade(command, argv) {
  const scan = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
  if (command === 'upgrade' && scan.some(token => token === '--host' || token.startsWith('--host='))) {
    const result = upgradeHostResultOf(argv);
    if (scan.includes('--json')) console.log(redactedJson(result, { pretty: true }));
    else {
      console.log(result.reason || `upgrade ${result.integration.status}: ${result.integration.host}`);
      if (result.integration?.reason) console.log(result.integration.reason);
      if (result.workspace) console.log(formatWorkspaceOutcome(result.workspace));
    }
    return result.exitCode;
  }
  if (scan.some(token => token === '--config-home' || token.startsWith('--config-home='))) throw Object.assign(new Error('--config-home requires upgrade --host'), { code: 'E_USAGE', exit: 2 });
  const flags = parseFlags(argv);
  const version = readPkgVersion();
  const assets = getCorpusRoot();
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const retired = loadRetired(pkgRoot);
  const logger = (m) => log(flags, m);
  const allStats = { vscode: null, intellij: null, vscodeBridge: null };
  const ownershipWarnings = [];
  const selectedHomes = new Map();
  const homeKey = home => process.platform === 'win32' ? installationRoot(home).toLowerCase() : installationRoot(home);
  const copilotSelected = flags.targets.has('vscode') || flags.targets.has('cli');
  const intellijHome = flags.targets.has('intellij') ? resolveIntelliJHome() : null;
  const configuredProfiles = copilotSelected && command === 'upgrade' && !flags.configureVsCode ? configuredVSCodeSettingsPaths({ copilotHome }) : [];
  const refreshVSCode = copilotSelected && (flags.configureVsCode || configuredProfiles.length > 0);
  const vscodeOptions = flags.configureVsCode ? {} : { settingsPaths: configuredProfiles };
  if (refreshVSCode) configureVSCodeSettings({ ...flags, dryRun: true }, () => {}, vscodeOptions);
  // Validate every selected path before deduplicating physical home ownership.
  for (const target of flags.targets) {
    const home = target === 'intellij' ? intellijHome : copilotHome;
    const previous = readLock(home, { strict: true });
    const key = homeKey(home);
    if (!selectedHomes.has(key)) selectedHomes.set(key, { home, previous, targets: new Set() });
    selectedHomes.get(key).targets.add(target);
  }
  for (const entry of selectedHomes.values()) {
    const oldTargets = entry.previous?.targets || [];
    const atCopilotHome = homeKey(entry.home) === homeKey(copilotHome);
    const bound = entry.previous?.lockVersion === 2;
    const legacyCopilot = atCopilotHome && oldTargets.length > 0 && oldTargets.every(target => ['cli', 'vscode'].includes(target));
    const files = bound || legacyCopilot ? entry.previous.files : atCopilotHome
      ? (entry.previous?.files || []).filter(file => file.startsWith('.ae-bin/') || file.startsWith('.harness-bin/') || ['bin/ae', 'bin/harness'].includes(file))
      : [];
    entry.owned = { ...entry.previous, files };
    const previousTargets = bound ? oldTargets : atCopilotHome ? oldTargets.filter(target => ['cli', 'vscode'].includes(target)) : [];
    entry.installedTargets = [...new Set([...previousTargets, ...entry.targets])].sort();
    if (entry.previous && !bound && !legacyCopilot && entry.previous.files.length > files.length) {
      const warning = `preserved legacy files with unproven target-home ownership: ${entry.home}`;
      ownershipWarnings.push(warning);
      logger(warning);
    }
  }
  const copilotEntry = copilotSelected ? selectedHomes.get(homeKey(copilotHome)) : null;
  const previousLock = copilotEntry?.previous || null;
  // Installation inventories selected homes without granting product-task authority.
  // Validate every ownership boundary first; task/configuration paths retain their external-home rule.
  const discovery = onboardingDiscovery({ copilotHome: copilotSelected ? copilotHome : intellijHome || copilotHome, home: flags.harnessHome });

  if (copilotSelected) installGlobalHarnessShim(copilotHome, { ...flags, dryRun: true }, () => {});
  for (const entry of selectedHomes.values()) applyRetired(entry.home, retired, entry.owned, flags, logger);

  if (copilotSelected) {
    allStats.vscode = syncAssetsToTarget(assets, copilotHome, flags, logger);
    seedProfile(assets, copilotHome, flags, logger);
        allStats.bundles = syncBundles({
      copilotHome,
      shippedFiles: new Set(collectAllAssetFiles(assets)),
      trustedNames: approvedBundleNames(copilotHome),
      dryRun: flags.dryRun,
    });
    for (const r of allStats.bundles.refused) log(flags, `bundle ${r.bundle}: refused ${r.target} — ${r.reason}`);
    for (const w of allStats.bundles.withdrawn) log(flags, `withdrew ${w} (no longer contributed)`);
    const binStats = installHarnessBin(pkgRoot, copilotHome, flags, logger);
    allStats.harnessBin = binStats;
    allStats.globalShim = installGlobalHarnessShim(copilotHome, flags, logger);
    if (flags.targets.has('vscode')) {
      allStats.vscodeBridge = installVSCodeBridge({
        packageRoot: pkgRoot,
        dryRun: flags.dryRun,
        log: logger,
      });
    }
    if (flags.configurePath) {
      allStats.pathConfig = configureShellPath(copilotHome, flags, logger);
    }
    if (refreshVSCode) {
      configureVSCodeSettings(flags, logger, vscodeOptions);
    }
  }

  if (flags.targets.has('intellij')) {
    const ij = intellijHome;
    if (!flags.dryRun) fs.mkdirSync(ij, { recursive: true });
    allStats.intellij = syncAssetsToTarget(assets, ij, flags, logger);
    seedProfile(assets, ij, flags, logger);
    mergeIntelliJInstructions(assets, ij, flags, logger);
  }

    const runnerWorkspace = path.resolve(flags.workspace);
  if (fs.existsSync(path.join(runnerWorkspace, '.harness', 'run.mjs'))) {
    try { allStats.runner = writeHarnessRunner(runnerWorkspace, flags.dryRun); }
    catch (error) {
      if (command !== 'upgrade') throw error;
      allStats.runner = { path: path.join(runnerWorkspace, '.harness/run.mjs'), error: { code: error.code || null, message: error.message, hint: error.hint || null } };
    }
  }

  const files = new Set([...(allStats.vscode?.files || []), ...(allStats.harnessBin?.files || [])]);
  if (allStats.globalShim?.path) {
    files.add('bin/ae');
  }
  if (allStats.globalShim?.legacyPath) {
    files.add('bin/harness');
    for (const rel of previousLock?.files || []) {
      if (rel.startsWith('.harness-bin/')) files.add(rel);
    }
  }
  const vscodeBridge = allStats.vscodeBridge || previousLock?.vscodeBridge || null;

  for (const entry of selectedHomes.values()) {
    const ownedFiles = new Set();
    for (const rel of entry.owned.files) {
      const full = resolveContainedPath(entry.home, rel);
      if (full && fs.lstatSync(full, { throwIfNoEntry: false })?.isFile()) ownedFiles.add(rel);
    }
    const atCopilot = homeKey(entry.home) === homeKey(copilotHome);
    if (atCopilot && copilotSelected) for (const rel of files) ownedFiles.add(rel);
    if (intellijHome && homeKey(entry.home) === homeKey(intellijHome)) {
      for (const rel of allStats.intellij?.files || []) ownedFiles.add(rel);
      if (allStats.intellij?.files.some(rel => rel.startsWith('instructions/') && rel.endsWith('.instructions.md'))) ownedFiles.add('global-copilot-instructions.md');
    }
    const bridge = atCopilot ? vscodeBridge || entry.previous?.vscodeBridge : null;
    writeLock(entry.home, {
      lockVersion: 2,
      installationRoot: installationRoot(entry.home),
      package: 'ae-harness', version, installedAt: new Date().toISOString(), command,
      targets: entry.installedTargets, files: [...ownedFiles].sort(), retiredApplied: retired,
      ...(bridge ? { vscodeBridge: bridge } : {}),
    }, flags.dryRun);
  }

  const delegation = [...selectedHomes.values()].map(entry => ({ configHome: entry.home, ...reconcileApprovedDelegation({ configHome: entry.home, home: flags.harnessHome, host: 'copilot', dryRun: flags.dryRun }) }));
  const workspace = readWorkspaceOutcome({ workspace: runnerWorkspace, copilotHome, home: flags.harnessHome });
  const checkReadiness = workspace.checkReadiness || inspectCheckReadiness({ workspace: runnerWorkspace, copilotHome, home: flags.harnessHome });
  const installation = { status: flags.dryRun ? 'planned' : 'completed', runtime: path.join(copilotSelected ? path.join(copilotHome, '.ae-bin') : pkgRoot, 'bin/ae.mjs') };
  if (flags.json) {
        console.log(
      redactedJson(
        {
          command,
          version,
          copilotHome,
          dryRun: flags.dryRun,
          vscode: allStats.vscode,
          vscodeBridge: allStats.vscodeBridge,
          intellij: allStats.intellij,
          runner: allStats.runner ?? null,
          checkReadiness,
          installation,
          discovery,
          delegation,
          workspace,
          ...(ownershipWarnings.length ? { ownershipWarnings } : {}),
        },
        { pretty: true }
      )
    );
  } else {
    console.log('');
    const keyWidth = keyWidthFor([command, 'vscode/cli', 'VS Code bridge', 'intellij', 'global cli']);
    console.log(
      ui.line({ state: 'ok', key: command, value: version, note: copilotHome, keyWidth })
    );
    if (allStats.vscode) {
      console.log(
        ui.line({
          key: 'vscode/cli',
          value: `+${allStats.vscode.created} ~${allStats.vscode.updated} =${allStats.vscode.unchanged}`,
          note: `skip ${allStats.vscode.skipped}`,
          keyWidth,
        })
      );
    }
    if (allStats.intellij) {
      console.log(
        ui.line({
          key: 'intellij',
          value: `+${allStats.intellij.created} ~${allStats.intellij.updated} =${allStats.intellij.unchanged}`,
          keyWidth,
        })
      );
    }
    if (allStats.vscodeBridge) {
      console.log(
        ui.line({
          key: 'VS Code bridge',
          value: `${allStats.vscodeBridge.id}@${allStats.vscodeBridge.version}`,
          note: 'reload VS Code to activate',
          keyWidth,
        })
      );
    }
    if (allStats.runner?.updated) {
      console.log(
        ui.line({ key: 'runner', value: allStats.runner.path, note: `refreshed to v${RUNNER_VERSION}`, keyWidth })
      );
    }
    const shim = globalHarnessShimPath(copilotHome);
    if (!flags.dryRun && fs.existsSync(shim)) {
      console.log(
        ui.line({ key: 'global cli', value: shim, note: 'PATH: ae install --configure-path', keyWidth })
      );
    }
    if (flags.dryRun) console.log(ui.paint('muted', '  dry-run — no files written'));
    else {
      if (discovery.questions?.length) {
        for (const question of discovery.questions) console.log(question.prompt);
        printNext('ae resources discover --json  # inspect existing resources and record discovery consent');
      }
      console.log(formatWorkspaceOutcome(workspace));
      printNext('ae doctor');
            if (command === 'upgrade') {
        const workspace = path.resolve(flags.workspace);
        const leftovers = leftoverWorkspaceArtifacts(workspace);
        if (leftovers.length) {
          printNext('ae migrate  # move gitignored docs/plans and docs/solutions out of the product tree');
        } else if (fs.existsSync(path.join(workspace, 'docs', 'solutions'))) {
          printNext('ae init-repo  # arm existing docs/solutions as consolidation debt');
        }
      }
    }
  }

  return 0;
}

export async function cmdDoctor(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  let assets = pkgRoot;
  try {
    assets = getCorpusRoot();
  } catch {
    /* doctor still runs */
  }
  const { checks, pass, diagnostics } = await runDoctor({
    copilotHome,
    assetsRoot: assets,
    pkgRoot,
    flags,
    workspace: path.resolve(flags.workspace),
  });

  const exitCode = pass ? EXIT.ok : EXIT.doctorFailed;
  if (flags.json) {
    emitJson(flags, { pass, exit: exitCode, checks, diagnostics });
  } else {
    const okCount = checks.filter((c) => c.pass).length;
    const warnCount = checks.filter((c) => !c.pass && c.optional).length;
    const errCount = checks.filter((c) => !c.pass && !c.optional).length;
    const shown = checks.filter((c) => flags.verbose || !c.pass);
    if (shown.length) {
      const keyWidth = keyWidthFor(shown.map((c) => c.id));
      for (const c of shown) {
                const hint = c.pass ? undefined : String(c.hint ?? '').replace(/^Run:\s*/i, '');
        console.log(
          ui.line({
            state: c.pass ? 'ok' : c.optional ? 'warn' : 'error',
            key: c.id,
            value: c.name,
            next: hint && !flags.verbose ? clampNote(hint) : hint,
            keyWidth,
          })
        );
      }
    }
    console.log(ui.summary({ ok: okCount, warn: warnCount, err: errCount, exit: exitCode }));
  }
  return exitCode;
}

export function computeStatusResult(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  const version = readPkgVersion();
  return { flags, copilotHome, lock, version };
}

export function statusDomainResult(flags, copilotHome) {
  if (flags.effectivePolicy) {
    return publishPolicySnapshot(path.resolve(flags.workspace), { copilotHome, override: flags.enforcement });
  }
  return withGitIdentityCache(() => readStatusDomainResult(flags, copilotHome));
}

function readStatusDomainResult(flags, copilotHome) {
  if (flags.contractDigest || flags.validateEvidence || flags.validateCompletion) {
    const workspace = path.resolve(flags.workspace);
    const plan = loadPlan(workspace, flags.plan, { home: flags.harnessHome });
    if (!plan) return { pass: false, version: null, digest: null, revision: null, schema: { pass: false, version: null }, message: 'Plan is missing, has an unsupported schema or extension, or is outside the selected project authority' };
    const home = planHome(workspace, plan);
    const evidence = readEvidence(workspace, plan.path);
    const intent = intentSourcesCheck(plan, workspace);
    const gaps = gapEvidenceCheck(workspace, plan);
    const shared = sharedIntentCheck(workspace, plan, { home });
    const domainLink = domainLinkCheck({ workspace, plan, copilotHome, home });
    const schema = plan.fm.plan_schema !== undefined || plan.fm.plan_format !== undefined ? validatePlanSchema(plan) : { pass: true, version: null };
    let experiment = null;
    if (flags.contractDigest && plan.fm.experiment) {
      experiment = experimentEditabilityCheck({ workspace, plan, home });
      const state = experimentStatus({ workspace, plan, home });
      if (experiment.pass && !experimentInputsCheck({ workspace, plan, accepted: state.series?.acceptedInputs, copilotHome, home }).pass) experiment = { pass: false, files: [], message: 'Frozen experiment inputs changed' };
    }
    const result = flags.validateCompletion ? validateCompletion({ workspace, plan, copilotHome }) : flags.contractDigest ? { version: Number(plan.fm.plan_schema) >= 4 ? 4 : Number(plan.fm.plan_schema) >= 3 ? 3 : plan.fm.intent_source_policy === 'content-v1' ? 2 : 1, digest: intent.pass && gaps.pass && schema.pass && shared.pass && domainLink.pass ? planDigest(plan.text) : null, revision: planRevision(plan.text), intent, gaps, shared, domainLink, schema, ...(experiment ? { experiment } : {}) }
      : { ...validateEvidence({ workspace, plan, evidence, maxAgeHours: loadPolicy(workspace, null, { copilotHome, home }).evidenceTtlHours, copilotHome }), evidenceIdentity: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
    return flags.contractDigest ? { ...result, workflow: planWorkflow(plan, { workspace }) } : result;
  }

  return null;
}

export async function cmdStatus(argv) {
  const { flags, copilotHome, lock, version } = computeStatusResult(argv);
  const domain = statusDomainResult(flags, copilotHome);
  if (domain) { emitJson(flags, domain); return 0; }

  if (flags.json) {
    emitJson(flags, { packageVersion: version, copilotHome, lock });
  } else {
    const keyWidth = keyWidthFor(['harness', 'home', 'installed', 'files']);
    console.log(ui.line({ key: 'harness', value: version, keyWidth }));
    console.log(ui.line({ key: 'home', value: copilotHome, keyWidth }));
    if (lock) {
      console.log(
        ui.line({ key: 'installed', value: `${lock.package}@${lock.version}`, note: lock.installedAt, keyWidth })
      );
      console.log(ui.line({ key: 'files', value: `${lock.files?.length ?? 0} tracked`, keyWidth }));
    } else {
      console.log(ui.line({ state: 'warn', key: 'installed', value: 'none', next: 'ae install', keyWidth }));
    }
  }
  return 0;
}

export async function cmdMigrate(argv) {
  const flags = parseFlags(argv);
  if (flags.fromHome) {
    if (!flags.home) throw Object.assign(new Error('home migration requires an explicit --ae-home destination'), { code: 'E_USAGE', exit: 2 });
    const result = migrateHome({ from: flags.fromHome, to: flags.home, dryRun: flags.dryRun });
    if (flags.json) emitJson(flags, result);
    else {
      console.log(ui.line({ state: 'ok', key: 'migrate', value: `${result.unchanged ? 'already copied' : result.dryRun ? 'would copy' : 'copied'} ${result.files} files; original backup: ${result.backup}` }));
      for (const next of result.next) printNext(next);
    }
    return 0;
  }
  const workspace = path.resolve(flags.workspace);
  const logger = (m) => log(flags, m);
  const result = runMigrateLayout({
    workspace,
    dryRun: flags.dryRun,
    log: logger,
    home: flags.home,
  });
  writeEvent(workspace, flags, {
    type: 'migrate_layout',
    command: 'migrate',
    result: result.conflicts.length ? 'fail' : 'pass',
    exitCode: result.conflicts.length ? EXIT.syncConflict : 0,
  });
  if (flags.json) {
    emitJson(flags, result);
  } else {
    const moved = result.moved.length;
    const value = flags.dryRun
      ? `would move ${moved} file${moved === 1 ? '' : 's'}`
      : moved
        ? `moved ${moved} file${moved === 1 ? '' : 's'}`
        : result.kept.length
          ? 'nothing to migrate (committed docs/ paths kept)'
          : 'nothing to migrate';
    console.log(
      ui.line({
        state: result.conflicts.length ? 'warn' : 'ok',
        key: 'migrate',
        value,
      })
    );
    if (result.conflicts.length) printNext('resolve destination conflicts, then re-run ae migrate');
  }
  return result.conflicts.length ? EXIT.syncConflict : 0;
}

export async function cmdInitRepo(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  flags.home = flags.home || process.env.HARNESS_HOME;
  const stats = runInitRepo({ workspace, flags, log: logger, copilotHome });
  try {
    stats.indexes = await ensureIndexes({
      workspace,
      copilotHome,
      mode: 'missing-or-stale',
      dryRun: Boolean(flags.dryRun),
      log: logger,
    });
  } catch (error) {
    stats.indexes = { error: error.message };
  }
  const migrateConflicts = stats.migrate?.conflicts?.length || 0;
  const exitCode = migrateConflicts ? EXIT.syncConflict : 0;
  writeEvent(workspace, flags, {
    type: 'init_repo',
    command: 'init-repo',
    result: exitCode ? 'fail' : 'pass',
    exitCode,
  });
  if (flags.json) {
    emitJson(flags, { ...stats, exitCode });
  } else {
    console.log(
      ui.line({
        state: exitCode ? 'warn' : 'ok',
        key: 'init-repo',
        value: exitCode ? `seeded with ${migrateConflicts} migrate conflict(s)` : 'done',
      })
    );
    console.log(
      ui.paint(
        'muted',
        '  index status: ae index --status'
      )
    );
    if (exitCode) printNext('ae migrate  # resolve leftover docs/ conflicts');
    else if (!selectIntent(workspace, '').length) printNext(prepareNextTool(workspace));
    else printNext('ae index --status');
  }
  return exitCode;
}

export async function cmdIndex(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const knowledgeRoot = path.join(copilotHome, 'knowledge');
  const workspace = path.resolve(flags.workspace);
  if (!flags.dryRun) fs.mkdirSync(knowledgeRoot, { recursive: true });
  const logger = (m) => log(flags, m);

    if (flags.since && !hasFlag(argv, '--structural')) {
    throw Object.assign(new Error('--since requires --structural'), {
      code: 'E_USAGE',
      hint: 'run: ae index --structural --since <ref>',
      exit: EXIT.usage,
    });
  }

  // Read-only freshness report — never rebuilds, zero model cost.
  // Reports both planes: knowledge BM25 (`ae index`) and structural code
  // (`ae index --structural`). Historical top-level fields are knowledge-only.
  if (hasFlag(argv, '--status')) {
    const status = indexStatus({
      workspace,
      copilotHome,
      home: flags.harnessHome || flags.home || process.env.HARNESS_HOME,
    });
    if (flags.json) emitJson(flags, status);
    else {
      const k = status.knowledge || status;
      const s = status.structural;
      const kState = !k.indexed ? 'pending' : (k.stale || k.empty) ? 'warn' : 'ok';
      const kValue = !k.indexed
        ? 'not built'
        : k.empty
          ? (k.stale ? 'empty · stale' : 'empty')
          : (k.stale ? 'stale' : 'current');
      console.log(ui.line({
        state: kState,
        key: 'knowledge',
        value: kValue,
        note: k.recommendation,
        next: k.next || undefined,
      }));
      if (s) {
        const unreadable = Array.isArray(s.unreadable) && s.unreadable.length > 0;
        const sState = !s.indexed ? 'pending' : (s.stale || unreadable) ? 'warn' : 'ok';
        const sValue = !s.indexed
          ? 'not built'
          : unreadable
            ? 'unreadable'
            : s.stale
              ? 'stale'
              : `current${s.filesIndexed != null ? ` · ${s.filesIndexed} files` : ''}${s.tier ? ` · ${s.tier}` : ''}`;
        console.log(ui.line({
          state: sState,
          key: 'code',
          value: sValue,
          note: s.recommendation,
          next: s.next || undefined,
        }));
      }
    }
    return 0;
  }

    if (hasFlag(argv, '--structural')) {
    const since = flags.since ? validateSinceRef(workspace, flags.since) : null;
    const extractor = await createTreesitterExtract();
    const result = await buildStructuralIndex({ workspace, extractor, since, dryRun: flags.dryRun, log: logger });
    const integrity = (result.meta.integrityFailures || []).length > 0;
        const persistFailed = !flags.dryRun && !result.written;
    writeEvent(workspace, flags, {
      type: 'index',
      command: 'index',
      result: persistFailed ? 'fail' : integrity ? 'warn' : 'pass',
      exitCode: persistFailed ? 1 : 0,
    });
    if (flags.json) {
      // Program lane (§9): a bounded summary envelope — never the raw tables.
      emitJson(flags, {
        pass: !persistFailed,
        exitCode: persistFailed ? 1 : 0,
        dir: result.dir,
        written: result.written,
        sha: result.meta.sha,
        baseSha: result.meta.baseSha,
        tier: result.meta.extractorTier,
        filesIndexed: result.meta.filesIndexed,
        reparsed: result.reparsed,
        reused: result.reused,
        removedFiles: result.removedFiles,
        parseFailures: result.meta.parseFailures,
        grammarVersions: result.meta.grammarVersions,
        missingGrammars: result.meta.missingGrammars,
        integrityFailures: result.meta.integrityFailures,
                truncated: {
          files: result.meta.truncated,
          symbols: result.meta.symbolsTruncated,
          symbolDetail: result.meta.symbolDetailTruncated,
          moduleEdges: result.meta.moduleEdgesTruncated,
          callEdges: result.meta.callEdgesTruncated,
          unresolved: result.meta.unresolvedTruncated,
        },
        sinceIgnored: result.sinceIgnored,
        priorUnreadable: result.priorUnreadable,
        delta: result.delta,
      });
    } else {
      const truncatedTables = [
        result.meta.symbolsTruncated ? 'symbols' : null,
        result.meta.symbolDetailTruncated ? 'per-symbol lists' : null,
        result.meta.moduleEdgesTruncated ? 'module edges' : null,
        result.meta.callEdgesTruncated ? 'call edges' : null,
        result.meta.unresolvedTruncated ? 'unresolved' : null,
      ].filter(Boolean);
            const deltaNote =
        `symbols +${result.delta.added.count} −${result.delta.removed.count} ~${result.delta.changed.count}` +
        (result.basedOn ? ' vs prior index' : ' (no prior index)') +
        (truncatedTables.length ? ` · TRUNCATED at build caps (${truncatedTables.join(', ')})` : '') +
        (result.sinceIgnored ? ` · ${result.sinceIgnored} — full pass` : '') +
        (result.priorUnreadable?.length ? ` · prior index unreadable (${result.priorUnreadable.length})` : '');
      console.log(
        ui.line({
          state: persistFailed ? 'error' : integrity ? 'warn' : 'ok',
          key: 'structural',
          value: `${result.meta.filesIndexed} files · ${result.reparsed} parsed · ${result.reused} reused · tier ${result.meta.extractorTier}`,
          note: persistFailed
            ? 'index could not be persisted — structural data is NOT current'
            : integrity
              ? `grammar integrity mismatch (${result.meta.integrityFailures.length}) — loud lexical fallback; run ae doctor`
              : deltaNote,
        })
      );
      // Agent lane (§9): the budgeted inert digest, never raw index JSON.
      if (result.written) {
        const index = readStructuralIndex(workspace);
        if (index) {
          for (const line of renderStructuralDigest(index).body.split('\n')) {
            console.log(ui.paint('muted', `  ${line}`));
          }
        }
      }
    }
    return persistFailed ? 1 : 0;
  }

  // Stamp the current git HEAD so `index --status` can measure drift later.
  const head = spawnSyncHead(workspace);
  const home = flags.harnessHome || flags.home || process.env.HARNESS_HOME;
  const result = runIndexKnowledge({
    knowledgeRoot,
    workspace,
    copilotHome,
    flags: { ...flags, headSha: head, home },
    log: logger,
    home,
  });
  // Refresh the committed codebase map alongside the knowledge index.
  try {
    const map = writeCodebaseMap({ workspace, dryRun: flags.dryRun });
    if (map) {
      result.codebaseMap = map;
      logger(`wrote ${map.path} (~${map.tokens} tokens)`);
    }
  } catch {
    // Advisory: never fail index on map generation.
  }
    if (!flags.dryRun) {
    try {
      const dir = storeDir(workspace);
      if (fs.existsSync(dir)) {
        const excluded = {};
        for (const l of listLearnings(dir)) {
          const anchors = l.fm.anchors || [];
          if (!anchors.length) continue;
                    const missing = anchors.filter((a) => {
            const full = assertNoSymlinkAncestors(workspace, a);
            return !full || !fs.existsSync(full);
          });
          if (missing.length) excluded[l.id] = missing;
        }
        writeStaleExclusions(dir, { excluded });
        result.staleLearnings = Object.keys(excluded).length;
      }
    } catch {
      // Advisory: never fail index because the knowledge store is unreadable.
    }
  }
  let code = null;
  let codeError = null;
  try {
    const extractor = await createTreesitterExtract();
    code = await buildStructuralIndex({
      workspace,
      home,
      extractor,
      dryRun: flags.dryRun,
      log: logger,
    });
  } catch (error) {
    codeError = error.message;
  }
  const integrityFailures = code?.meta?.integrityFailures || [];
  const codeFailed = Boolean(head) && !flags.dryRun && (Boolean(codeError) || !code?.written);
  writeEvent(workspace, flags, {
    type: 'index',
    command: 'index',
    result: codeFailed ? 'fail' : integrityFailures.length ? 'warn' : 'pass',
    exitCode: codeFailed ? 1 : 0,
  });
  result.code = {
    written: Boolean(code?.written),
    filesIndexed: code?.meta?.filesIndexed ?? null,
    tier: code?.meta?.extractorTier ?? null,
    error: codeError,
    integrityFailures,
  };
  if (flags.json) {
    emitJson(flags, result);
  } else {
    const empty = result.entries === 0;
    const noteParts = [];
    if (empty) {
      noteParts.push(
        flags.dryRun
          ? 'knowledge index dry run · 0 solutions in the harness project store or the Copilot knowledge home'
          : 'knowledge index recorded (meta written) · 0 solutions in the harness project store or the Copilot knowledge home',
      );
    }
    if (result.staleLearnings) noteParts.push(`learnings excluded ${result.staleLearnings} (stale anchors)`);
    console.log(
      ui.line({
        // Empty corpus is a successful rebuild, but not a healthy recall index —
        // warn so the ledger does not look fully green after "not built" → index.
        state: empty ? 'warn' : 'ok',
        key: 'knowledge',
        value: `${result.entries} entries · ${result.indexEntries ?? result.entries} postings`,
        note: noteParts.length ? noteParts.join(' · ') : undefined,
        next: empty ? 'ae compound or ae remember, then index again' : undefined,
      })
    );
    const codeValue = code?.written
      ? `${code.meta.filesIndexed} files${code.meta.extractorTier ? ` · ${code.meta.extractorTier}` : ''}`
      : head
        ? (codeError || 'not published')
        : 'skipped · no git HEAD';
    console.log(ui.line({
      state: codeFailed ? 'error' : integrityFailures.length ? 'warn' : code?.written ? 'ok' : 'warn',
      key: 'code',
      value: integrityFailures.length
        ? `${codeValue} · grammar integrity mismatch (${integrityFailures.length})`
        : codeValue,
    }));
  }
  return codeFailed ? 1 : 0;
}

export async function computeOrientResult(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const query = parseQueryFromArgv(argv, flags);
  let graphPreparation;
  if (flags.questionKind) {
    if (!flags.read || flags.contextVersion !== 2) throw Object.assign(new Error('--question-kind requires --read --context-version 2'), { code: 'E_USAGE', exit: 2 });
    if (['dependency-path', 'change-impact'].includes(flags.questionKind)) {
      graphPreparation = await prepareGraph({ workspace, home: flags.harnessHome || flags.home, dryRun: flags.dryRun });
    }
  }
  if (flags.read) {
    const result = readOrientSlice({ workspace, copilotHome, flags, query, files: flags.files, graphPreparation });
    return { flags, workspace, copilotHome, query, result, read: true };
  }
  const result = runOrient({ workspace, copilotHome, flags, query });
  return { flags, workspace, copilotHome, query, result, read: false };
}

export async function cmdOrient(argv) {
  const computed = await computeOrientResult(argv);
  if (computed.read) {
    emitJson(computed.flags, computed.result);
    return 0;
  }
  const { flags, workspace, query, result } = computed;
  const orientPack = (() => {
    try {
      return fs.readFileSync(path.join(workspace, result.contextPack), 'utf8');
    } catch {
      return '';
    }
  })();
  writeEvent(workspace, flags, {
    type: 'orient',
    command: 'orient',
    plan: result.activePlan?.path || null,
    result: result.gateStatus === 'pass' ? 'pass' : 'fail',
    exitCode: 0,
    blockedReason: result.blockedReason,
    usage: usageFields({ input: query, output: orientPack }),
        learnings: result.deliveredLearnings || (result.learnings || []).map((l) => l.id),
    learningsBytes: result.learningsBytes,
    contextAccounting: result.contextAccounting,
        ...((result.learnings || []).some((l) => l.layer)
      ? { learningLayers: (result.learnings || []).map((l) => ({ id: l.id, layer: l.layer === 'branch' ? 'branch' : 'golden' })) }
      : {}),
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(
      ui.line({
        state: result.gateStatus === 'pass' ? 'ok' : 'warn',
        key: 'orient',
        value: result.contextPack,
        note: `recall ${result.recall.length} · learnings ${result.learnings?.length ?? 0} · plans ${result.plans.length} of ${result.planTotal ?? result.plans.length} · gate ${result.gateStatus}`,
      })
    );
    if (result.explain) {
      const qt = result.explain.queryTokens.length;
      for (const c of result.explain.candidates) {
        const decomposition = c.excluded
          ? `excluded: ${c.excluded}`
          : `hits ${c.hits}/${qt} × damping ${c.damping} = ${c.score}`;
        console.log(ui.paint('muted', `  ${c.id} ${decomposition}`));
      }
    }
    if (result.blockedReason) {
      console.log(ui.line({ state: 'error', key: 'blocked', value: result.blockedReason }));
    }
    printNext(result.nextTools?.[0]);
  }
  return 0;
}

export async function cmdGate(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const query = parseQueryFromArgv(argv, flags);
  const result = runGate({ workspace, flags, query });
  const policy = loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome) });
  const policyExitCode = policy.enforcement === 'enforce' ? result.exitCode : 0;
  result.enforcement = policy.enforcement;
  result.projectPolicyIgnored = policy.projectPolicyIgnored;
  result.projectPolicyError = policy.projectPolicyError ?? null;
  result.policyExitCode = policyExitCode;
  publishGateSession({ workspace, result, policy, dryRun: flags.dryRun });
  writeEvent(workspace, flags, {
    type: 'gate',
    command: 'gate',
    plan: result.plan?.path || null,
    phase: result.phase,
    exitCode: policyExitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
    usage: usageFields({ input: query, output: result.checks.map((c) => c.message).join('\n') }),
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    const failed = result.checks.filter((c) => !c.pass).length;
    console.log(
      ui.line({
        state: result.pass ? 'ok' : 'error',
        key: 'gate',
        value: result.pass
          ? `pass · ${result.checks.length} checks`
          : `blocked · ${failed} of ${result.checks.length} checks`,
        note: result.pass ? result.phase : 'stop before editFiles',
      })
    );
    printChecks(flags, result.checks);
    printNext(result.nextTools?.[0]);
  }
  return policyExitCode;
}

export async function cmdVerify(argv, ctx = {}) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const signal = ctx.signal;
  const streaming = ctx.output === 'jsonl';

  let jsonl = null;
  let onEvent;
  if (streaming) {
    jsonl = createJsonlStream(process.stdout);
    jsonl.start({ command: 'verify', plan: flags.plan || null });
    onEvent = (event, fields = {}) => {
      if (event === 'progress') jsonl.progress(fields);
      else if (event === 'row') jsonl.row(fields);
      else jsonl.write(event, fields);
    };
  }

    let result;
  try {
    result = await runVerify({ workspace, flags, signal, onEvent, events: ctx.events });
  } catch (error) {
    if (streaming) {
      jsonl.result({ status: 'failed', outcome: 'inconclusive', message: error?.message || String(error) });
      await jsonl.drained();
    }
    throw error;
  }
  const diffFingerprint = result.diffFingerprint;
  delete result.diffFingerprint;
  const cancelled = result.outcome === 'cancelled';
    const runStatus = statusForVerifyResult(result);
  const exitCode = cancelled
    ? EXIT.cancelled
    : runStatus === 'timed-out'
      ? EXIT.timedOut
      : exitCodeForOutcome(result.outcome, result.enforcement);

  const previous = readSession(workspace) || {};
  writeSession(
    workspace,
    {
      ...previous,
      activePlan: result.plan || previous.activePlan || null,
      lastVerifyAt: new Date().toISOString(),
      lastVerifyOutcome: result.outcome,
      lastEvidencePath: result.evidencePath,
      ...(typeof diffFingerprint === 'string' ? { diffFingerprint } : {}),
    },
    flags.dryRun
  );
  writeEvent(workspace, flags, {
    type: 'verify',
    command: 'verify',
    repeatEvidence: result.repeatEvidence,
    plan: result.plan,
    exitCode,
    result: cancelled ? 'warn' : result.outcome === 'passed' ? 'pass' : result.outcome === 'failed' ? 'fail' : 'warn',
    checks: result.checks,
    blockedReason: cancelled ? 'verification cancelled (SIGINT)' : result.outcome === 'passed' ? null : `${result.outcome} verification`,
    usage: usageFields({ input: result.plan || '', output: result.checks.map((c) => c.message).join('\n') }),
    learnings: flags.learnings ? flags.learnings.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });

  if (streaming) {
    jsonl.result({
      status: runStatus,
      outcome: result.outcome,
      exitCode,
      evidencePath: result.evidencePath,
      checks: result.checks.map((c) => ({ id: c.id, status: c.status, unifiedStatus: unifiedStatusForCheck(c) })),
    });
        await jsonl.drained();
    return exitCode;
  }

  if (flags.json) emitJson(flags, result);
  else {
        const gating = isGatingCheck;
    const failed = result.checks.filter(gating).length;
    const passed = result.outcome === 'passed';
    console.log(
      ui.line({
        state: cancelled ? 'warn' : passed ? 'ok' : exitCode === 0 ? 'warn' : 'error',
        key: 'verify',
        value: cancelled
          ? 'cancelled · verification interrupted'
          : passed
            ? `passed · ${result.checks.length} checks`
            : `${result.outcome} · ${failed} of ${result.checks.length} checks`,
        note: result.evidencePath,
      })
    );
        if (result.projectPolicyIgnored) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'policy',
          value: 'project policy.yaml ignored — this project is not trusted',
          note: `running as ${result.enforcement} · ae trust approve`,
        })
      );
    }
        if (result.projectPolicyError) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'policy',
          value: 'and it would not parse',
          note: clampNote(result.projectPolicyError),
        })
      );
    }
        for (const refused of result.refusedSeverityDowngrades || []) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'policy',
          value: `checks.${refused.id}.severity: advisory ignored`,
          note: `the active plan requires ${refused.id}; running as ${refused.effective}`,
        })
      );
    }
    printChecks(flags, result.checks, (c) => c.status === 'passed' || c.status === 'skipped');
    if (passed) {
      printNext('ae compound (or /auto-compound), then stop');
    } else if (!cancelled) {
            const firstFail = result.checks.find(gating);

      if (firstFail) {
        const detail = String(firstFail.message ?? firstFail.name ?? '').slice(0, 100);
        printNext(`fix ${firstFail.id} (${detail})`);
      }
    }
  }
  return exitCode;
}

export async function cmdRecall(argv) {
  const flags = parseFlags(argv);
  if (hasFlag(argv, '--include-plans')) flags.includePlans = true;
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = runRecall({ workspace, copilotHome, flags, argv });
  writeEvent(workspace, flags, {
    type: 'recall',
    command: 'recall',
    result: 'pass',
    exitCode: 0,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(
      ui.line({
        state: result.recall.length ? 'ok' : 'warn',
        key: 'recall',
        value: `"${result.query}"`,
        note: `${result.recall.length} hit${result.recall.length === 1 ? '' : 's'}`,
      })
    );
    for (const r of result.recall) {
      const label = r.kind === 'insight' ? ' [insight]' : '';
      console.log(ui.line({ key: String(r.score), value: r.path, note: `${r.title}${label}`, keyWidth: 6 }));
    }
    for (const p of result.plans ?? []) {
      console.log(ui.line({ key: 'plan', value: p.path, note: p.status, keyWidth: 6 }));
    }
  }
  return 0;
}

export async function cmdEvents(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const events = readEvents(workspace, {
    limit: Number.isFinite(flags.limit) ? flags.limit : 20,
    session: flags.session,
    failures: flags.failures,
  });
  const summary = summarizeEvents(events);
  const totalMatched = events.totalMatched ?? events.length;

  if (flags.json) {
    const body = { count: events.length, totalMatched, summary };
    if (!flags.summary) body.events = [...events];
    emitJson(flags, body);
  } else {
    const keyWidth = keyWidthFor(['events', 'tokens', 'last plan']);
    console.log(
      ui.line({
        key: 'events',
        value: `${events.length}${totalMatched > events.length ? ` of ${totalMatched}` : ''}`,
        note: `${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail`,
        keyWidth,
      })
    );
    if (totalMatched > events.length) {
      console.log(
        ui.paint('muted', `  showing latest ${events.length} · narrow with --session/--failures or raise --limit`)
      );
    }
    const u = summary.usage;
    if (u && u.totalTokens) {
      console.log(
        ui.line({
          key: 'tokens',
          value: `in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens}`,
          note: 'est',
          keyWidth,
        })
      );
      if (flags.summary) {
        const typeWidth = keyWidthFor(Object.keys(u.byType));
        for (const [type, bucket] of Object.entries(u.byType).sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
          console.log(ui.paint('muted', `  ${type.padEnd(typeWidth)}  ${bucket.totalTokens}`));
        }
      }
    }
    if (summary.lastActivePlan) {
      console.log(ui.line({ key: 'last plan', value: summary.lastActivePlan, keyWidth }));
    }
    if (summary.latestBlockedReason) {
      console.log(ui.line({ state: 'warn', key: 'blocked', value: summary.latestBlockedReason, keyWidth }));
    }
  }
  return 0;
}

export async function cmdReport(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);

  if (flags.facts) {
    if (flags.growth || flags.sync || flags.global || flags.check) throw Object.assign(new Error('--facts cannot combine with event report modes'), { code: 'E_USAGE', exit: 2 });
    const maxBytes = argv.some(a => a === '--max-bytes' || a.startsWith('--max-bytes=')) ? flags.maxBytes : 16384;
    const facts = buildFactualReport({ workspace, copilotHome, planPath: flags.plan, maxBytes });
    if (flags.json) emitJson(flags, facts);
    else console.log(JSON.stringify(facts));
    return 0;
  }

  // Adaptive Engineering session-end growth report (kernel-only; no LLM).
  if (flags.growth) {
    const events = loadReportEvents({ workspace });
    const growth = buildGrowthReport({
      workspace,
      copilotHome,
      events,
      plan: flags.plan || null,
    });
    if (flags.json) emitJson(flags, growth);
    else console.log(renderGrowthReport(growth, ui));
    return 0;
  }


  let base = null;
  if (flags.sync || flags.global) {
    if (flags.sync) {
      const synced = store.syncWorkspaceEvents({ workspace });
      if (!flags.json) {
        console.log(ui.line({ state: 'ok', key: 'sync', value: `${synced.added} new event(s)`, note: synced.file }));
      }
    }
    if (flags.global) base = store.readGlobalEvents();
  }
  if (base === null) base = loadReportEvents({ workspace });

  // Overlay real host usage (if any adapter has it) on top of harness estimates.
  const merged = mergeHostUsage(base, collectHostUsage({
    workspace: flags.global ? undefined : workspace,
    host: flags.host,
    copilotHome,
  }));
  const report = buildReport({ workspace, copilotHome, events: merged });

  if (flags.check) {
    if (hasBudgetBreach(report)) {
      if (flags.json) emitJson(flags, { pass: false, breaches: report.flags.budgetBreaches });
      else {
        const breaches = report.flags.budgetBreaches;
        console.log(
          ui.line({ state: 'error', key: 'report', value: `budget breach · ${breaches.length}` })
        );
        for (const b of breaches) {
          console.log(ui.line({ key: b.kind, value: `${b.target} = ${b.value}`, note: `cap ${b.cap}` }));
        }
      }
      return 1;
    }
    if (flags.json) emitJson(flags, { pass: true, breaches: [] });
    else console.log(ui.line({ state: 'ok', key: 'report', value: 'no budget breaches' }));
    return 0;
  }

  if (flags.json) emitJson(flags, report);
  else console.log(renderReport(report));
  return 0;
}

export async function cmdValidatePlan(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const result = runValidatePlan({ workspace, flags, planPath: flags.plan });
  const policy = loadPolicy(workspace, flags.enforcement, { copilotHome: resolveCopilotHome(flags.copilotHome) });
  const policyExitCode = policy.enforcement === 'enforce' ? result.exitCode : 0;
  result.enforcement = policy.enforcement;
  result.projectPolicyIgnored = policy.projectPolicyIgnored;
  result.projectPolicyError = policy.projectPolicyError ?? null;
  result.policyExitCode = policyExitCode;
  writeEvent(workspace, flags, {
    type: 'validate_plan',
    command: 'validate-plan',
    plan: result.plan?.path || null,
    exitCode: policyExitCode,
    checks: result.checks,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    const failed = result.checks.filter((c) => !c.pass && c.severity !== 'warn').length;
    console.log(
      ui.line({
        state: result.pass ? 'ok' : 'error',
        key: 'validate-plan',
        value: result.pass
          ? `pass · ${result.checks.length} checks`
          : `fail · ${failed} of ${result.checks.length} checks`,
        keyWidth: 13,
      })
    );
    printChecks(flags, result.checks);
  }
  return policyExitCode;
}

export async function cmdCompound(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  const result = await runCompound({ workspace, copilotHome, flags, log: logger });
  writeEvent(workspace, flags, {
    type: 'compound',
    command: 'compound',
    exitCode: result.exitCode,
    result: result.pass ? (result.exitCode === 2 ? 'warn' : 'pass') : 'fail',
    blockedReason: result.blockedReason,
    // Growth-loop fields (additive): session-end report reads these.
    compoundStatus: result.pass ? 'completed' : 'skipped',
    plan: result.plan || null,
    path: result.path || null,
    insight: result.kind === 'insight' || Boolean(flags.insight),
  });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    if (result.pass && result.kind === 'insight') {
      console.log(
        ui.line({
          state: 'ok',
          key: 'insight',
          value: result.path,
          note: `indexed ${result.indexed?.entries ?? 0} entries`,
        })
      );
      printNext(result.nextTools?.[0]);
    } else if (result.pass) {
      console.log(
        ui.line({
          state: result.exitCode === 2 ? 'warn' : 'ok',
          key: 'compound',
          value: `indexed ${result.indexed?.entries ?? 0} entries`,
          note: result.exitCode === 2 ? 'verify gate warned — review Activity' : undefined,
        })
      );
    } else {
      console.log(ui.line({ state: 'error', key: 'compound', value: `blocked · ${result.blockedReason}` }));
    }
  }
  return result.exitCode;
}

export async function cmdConsolidate(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);

  if (hasFlag(argv, '--apply')) {
    if (!flags.ops) {
      throw Object.assign(new Error('--apply requires --ops <path> (the skill-emitted operations JSON)'), {
        code: 'E_USAGE',
        hint: 'ae consolidate --apply --ops ops.json',
        exit: EXIT.usage,
      });
    }
    const result = applyConsolidationProposal({
      workspace,
      opsPath: path.resolve(workspace, flags.ops),
      dryRun: flags.dryRun,
      approve: flags.yes,
      log: logger,
      copilotHome,
      layer: flags.layer,
      home: flags.harnessHome || process.env.HARNESS_HOME,
    });
    writeEvent(workspace, flags, {
      type: 'consolidate',
      command: 'consolidate',
      decision: 'apply',
      result: result.exitCode === 0 ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.rejected?.[0]?.reason || null,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (result.exitCode === 0) {
      const noteParts = [];
      if (result.committed) noteParts.push('committed to knowledge store');
      if (result.governed?.length) noteParts.push(`${result.governed.length} re-governed`);
      if (result.staleLockRemoved) noteParts.push(result.staleLockRemoved);
      console.log(
        ui.line({
          state: 'ok',
          key: 'apply',
          value: result.applied.map((a) => `${a.op.toLowerCase()} ${a.id || ''}`.trim()).join(' · ') || 'no ops',
          note: noteParts.length ? noteParts.join(' · ') : undefined,
        })
      );
    } else {
      console.log(
        ui.line({
          state: 'error',
          key: 'apply',
          value: `rejected · ${result.rejected?.[0]?.reason || 'invalid ops'}`,
        })
      );
    }
    return result.exitCode;
  }

  if (hasFlag(argv, '--candidates')) {
    const packet = prepareConsolidationPacket({ workspace, copilotHome, home: flags.harnessHome || process.env.HARNESS_HOME, dryRun: flags.dryRun, layer: flags.layer });
    writeEvent(workspace, flags, { type: 'consolidate', command: 'consolidate', result: 'pass', exitCode: 0 });
    if (flags.json) {
      emitJson(flags, packet);
    } else {
      console.log(
        ui.line({
          state: 'ok',
          key: 'candidates',
          value: `${packet.clusters.length} clusters · ${packet.learnings.length} active learnings`,
          note: 'JSON packet is the contract — use --json for the skill',
        })
      );
      printNext('emit ops JSON, then ae consolidate --apply --ops <path>');
    }
    return 0;
  }

  if (hasFlag(argv, '--rebuild')) {
    const result = rebuildStore({ workspace, yes: flags.yes, copilotHome, log: logger });
    writeEvent(workspace, flags, {
      type: 'consolidate',
      command: 'consolidate',
      decision: 'rebuild',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(
        ui.line({
          state: 'warn',
          key: 'rebuild',
          value: `archived ${result.archived} · debt ${result.debt}/${CONSOLIDATION_THRESHOLD}`,
        })
      );
      printNext(result.nextTools?.[0]);
    }
    return result.exitCode;
  }

  // Default: --status (deterministic debt gauge, zero model cost).
  const status = consolidateStatus({ workspace, copilotHome, home: flags.home || process.env.HARNESS_HOME });
  writeEvent(workspace, flags, { type: 'consolidate', command: 'consolidate', result: 'pass', exitCode: 0 });
  if (flags.json) {
    emitJson(flags, status);
  } else {
    const atCapDomains = (status.domains || []).filter((d) => d.atCap).map((d) => d.domain);
    console.log(
      ui.line({
        state: status.due ? 'warn' : 'ok',
        key: 'consolidate',
        value: `debt ${status.debt}/${status.threshold}`,
        note: `${status.learnings.active} active learnings${status.promotionCandidates.length ? ` · ${status.promotionCandidates.length} promotion candidate${status.promotionCandidates.length === 1 ? '' : 's'}` : ''}${status.quarantined.length ? ` · ${status.quarantined.length} quarantined` : ''}${atCapDomains.length ? ` · ${atCapDomains.join(', ')} at cap` : ''}`,
      })
    );
    printNext(status.nextTools?.[0]);
  }
  return 0;
}

async function finishTeaching(argv, command, run) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const logger = (m) => log(flags, m);
  const result = run({
    workspace,
    copilotHome,
    flags,
    argv,
    log: logger,
    home: flags.harnessHome || flags.home || process.env.HARNESS_HOME,
  });
  writeEvent(workspace, flags, {
    type: 'remember',
    command,
    result: result.pass ? 'pass' : 'fail',
    exitCode: result.exitCode,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else if (result.pass) {
    console.log(
      ui.line({
        state: 'ok',
        key: command,
        value: result.learningId,
        note: result.dryRun
          ? `dry-run — nothing written (would-be episode ${result.episodePath})`
          : `source: human · episode ${result.episodePath}`,
      })
    );
    printNext(result.nextTools?.[0]);
  } else if (result.exitCode === EXIT.usage) {
    for (const l of ui.errorBlock({
      code: 'E_USAGE',
      message: result.blockedReason,
      fix: result.nextTools?.[0],
      exit: EXIT.usage,
    })) {
      console.error(l);
    }
  } else {
    console.log(ui.line({ state: 'error', key: command, value: `blocked · ${result.blockedReason}` }));
    printNext(result.nextTools?.[0]);
  }
  return result.exitCode;
}

export async function cmdRemember(argv) {
  return finishTeaching(argv, 'remember', runRemember);
}

export async function cmdCorrect(argv) {
  return finishTeaching(argv, 'correct', runCorrect);
}

export async function cmdLearning(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  const logger = (m) => log(flags, m);
  const result = setLearningStatus({ workspace, id, action, reason: flags.reason, to: flags.to, log: logger });
  writeEvent(workspace, flags, {
    type: 'learning',
    command: 'learning',
    decision: action,
    result: result.pass ? 'pass' : 'fail',
    exitCode: result.exitCode,
    blockedReason: result.blockedReason,
  });

  if (flags.json) {
    emitJson(flags, result);
  } else if (result.pass) {
    const value = action === 'promote' ? `${id} → promoted (${flags.to})` : `${id} → ${result.status}`;
    console.log(ui.line({ state: action === 'retire' ? 'warn' : 'ok', key: 'learning', value }));
  } else if (result.exitCode === EXIT.usage) {
    for (const l of ui.errorBlock({
      code: 'E_USAGE',
      message: result.blockedReason,
      fix: 'ae learning <retire|dispute|confirm|promote> <id> [--reason "<r>"] [--to <path>]',
      exit: EXIT.usage,
    })) {
      console.error(l);
    }
  } else {
    for (const l of ui.errorBlock({
      code: 'E_TARGET',
      message: result.blockedReason,
      exit: result.exitCode,
    })) {
      console.error(l);
    }
  }
  return result.exitCode;
}

export async function cmdLearnings(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);

    const view = resolveLearningsView({ argv, flags, workspace, copilotHome, home: flags.harnessHome || flags.home, hasFlag });

  if (view.outcome === 'usage') {
    const blockedReason = view.message;
    if (flags.json) {
      emitJson(flags, { pass: false, blockedReason });
    } else {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: blockedReason, exit: EXIT.usage })) {
        console.error(l);
      }
    }
    return EXIT.usage;
  }

  if (view.outcome === 'why' || view.outcome === 'not-found') {
    const result = view.outcome === 'why' ? view.result : null;
    if (!result) {
      const blockedReason = `E_TARGET: no learning ${flags.why}`;
      if (flags.json) {
        emitJson(flags, { pass: false, id: flags.why, blockedReason });
      } else {
        for (const l of ui.errorBlock({ code: 'E_TARGET', message: `no learning ${flags.why}`, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }

    if (flags.json) {
      emitJson(flags, result);
      return 0;
    }

    console.log(ui.paint('muted', LEARNINGS_FENCE));
    const keyWidth = keyWidthFor(['id', 'trigger', 'claim', 'status']);
    console.log(ui.line({ key: 'id', value: result.id, keyWidth }));
    console.log(ui.line({ key: 'trigger', value: result.trigger, keyWidth }));
    console.log(ui.line({ key: 'claim', value: result.claimLine, keyWidth }));
    for (const ep of result.episodes) {
      console.log(ui.paint('muted', `    · ${ep.kind} · ${ep.path}${ep.plan ? ` · ${ep.plan}` : ''}`));
    }
    console.log(
      ui.line({
        key: 'status',
        // Same note idiom as the listing view — carries failures/promotionEligible too.
        value: learningNote(result),
        keyWidth,
      })
    );
    return 0;
  }

  const result = view.result;

  if (flags.json) {
    emitJson(flags, result);
    return 0;
  }

  console.log(ui.paint('muted', LEARNINGS_FENCE));
  const rows = result.learnings.filter((l) => flags.verbose || !['retired', 'superseded'].includes(l.status));
  const keyWidth = keyWidthFor(rows.map((l) => l.id));
  for (const l of rows) {
    console.log(
      ui.line({ state: learningRowState(l.status), key: l.id, value: l.trigger, note: learningNote(l), keyWidth })
    );
  }
  if (result.quarantined.length > 0) {
    console.log(
      ui.paint(
        'muted',
        `${result.quarantined.length} quarantined episode(s) — inspect with ae consolidate --status, clear with knowledge purge <path>`
      )
    );
  }
  return 0;
}

export async function cmdEvalKnowledge(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const result = evalKnowledge({
    workspace,
    copilotHome,
    home: flags.home || process.env.HARNESS_HOME,
    negativeQueries: DEFAULT_NEGATIVE_QUERIES,
  });

  if (flags.json) {
    emitJson(flags, result);
    return result.exitCode;
  }

  if (!result.pass) {
    for (const l of ui.errorBlock({ code: 'E_TARGET', message: result.blockedReason, exit: result.exitCode })) {
      console.error(l);
    }
    return result.exitCode;
  }

  const armKeys = Object.keys(result.arms);
  const keyWidth = keyWidthFor(['eval-knowledge', ...armKeys, 'recommendation']);
  console.log(
    ui.line({
      state: 'ok',
      key: 'eval-knowledge',
      value: `${result.split.train} train · ${result.split.heldOut} held-out · cutoff ${result.split.cutoff}`,
      note: result.split.unscorable ? `${result.split.unscorable} held-out unscorable` : undefined,
      keyWidth,
    })
  );
  for (const arm of armKeys) {
    const stats = result.arms[arm];
    console.log(
      ui.line({
        key: arm,
        value: `hit ${Math.round(stats.hitRate * 100)}% · false ${Math.round(stats.falseSurfaceRate * 100)}% · ~${stats.injectedTokens} tok`,
        keyWidth,
      })
    );
  }
  console.log(ui.line({ key: 'recommendation', value: result.recommendation, keyWidth }));
  console.log(
    ui.paint(
      'muted',
      '  deterministic retrieval proxy — hit/false-surface/token cost per arm; model-graded net-benefit is deferred, not measured here'
    )
  );
  return 0;
}

export async function cmdKnowledge(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  // Single definition (store.mjs) — commands.mjs no longer keeps its own copy.

  if (subcommand === 'purge') {
    const rawTarget = argv[1];
    const isAll = rawTarget === '--all';
        const target = !isAll && rawTarget && !rawTarget.startsWith('--') ? rawTarget : null;
    const logger = (m) => log(flags, m);
        const result = isAll
      ? purgeAll({ workspace, log: logger, home: flags.home || process.env.HARNESS_HOME })
      : purgeEpisode({
          workspace,
          target,
          copilotHome,
          log: logger,
          home: flags.home || process.env.HARNESS_HOME,
        });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'purge',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else if (isAll) {
      console.log(
        ui.line({
          state: 'warn',
          key: 'purge',
          value: `--all · ${result.removed.learnings} learning${result.removed.learnings === 1 ? '' : 's'} removed`,
          note: 'episodes remain on disk — they will re-appear as debt',
        })
      );
    } else {
      console.log(
        ui.line({
          state: 'warn',
          key: 'purge',
          value: target,
          note: `${result.removed.learnings.length} learning(s) deleted · ${result.removed.links.length} link(s) unlinked`,
        })
      );
    }
    return result.exitCode;
  }

    if (subcommand === 'migrate-store') {
    const logger = (m) => log(flags, m);
    const result = migrateStrandedStore({ workspace, home: flags.harnessHome, fromId: flags.fromId, dryRun: flags.dryRun, log: logger });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'migrate-store',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(ui.line({ state: 'ok', key: 'migrate-store', value: `${result.from} -> ${result.to}` }));
    }
    return result.exitCode;
  }

    if (subcommand === 'status') {
    const report = knowledgeStatus({ workspace, copilotHome });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'status',
      result: 'pass',
      exitCode: 0,
    });
    if (flags.json) {
      emitJson(flags, report);
      return 0;
    }
    const keyWidth = keyWidthFor(['knowledge', 'golden', 'drift', ...report.golden.domains.map((d) => d.domain), ...report.buckets.map((b) => b.key)]);
    const contextNote = report.context
      ? report.context.detached
        ? 'detached HEAD'
        : `branch ${inertLine(report.context.branch).slice(0, 80)}`
      : 'no git context';
    console.log(
      ui.line({
        state: report.storeExists ? 'ok' : 'pending',
        key: 'knowledge',
        value: report.storeExists ? `mode ${report.mode} · commit ${report.commit}` : 'no store yet',
        note: contextNote,
        keyWidth,
      })
    );
    console.log(
      ui.line({ key: 'golden', value: `${report.golden.active} active · ${report.golden.total} total`, keyWidth })
    );
    for (const d of report.golden.domains) {
      console.log(ui.line({ key: d.domain, value: `${d.active} active · ${d.total} total`, keyWidth }));
    }
    for (const b of report.buckets) {
      const noteParts = [];
      if (b.branch) noteParts.push(inertLine(b.branch).slice(0, 80));
      if (b.ageDays !== null) noteParts.push(`${b.ageDays}d old`);
      if (b.baseSha) noteParts.push(`base ${b.baseSha.slice(0, 12)}`);
      noteParts.push(b.promotable ? 'promotable' : 'never promotable');
      if (b.prunable) noteParts.push('prunable — ae knowledge prune');
      if (b.ancestryOk === false) noteParts.push('base not an ancestor of HEAD — excluded from overlay');
      console.log(
        ui.line({
          state: b.ancestryOk === false ? 'warn' : 'ok',
          key: b.key,
          value: `${b.active} active · ${b.total} total${b.promoted ? ` · ${b.promoted} promoted` : ''}`,
          note: noteParts.join(' · '),
          keyWidth,
        })
      );
    }
    if (report.drift) {
      console.log(
        ui.line({
          state: report.drift.indexed ? (report.drift.stale ? 'warn' : 'ok') : 'pending',
          key: 'drift',
          value: report.drift.indexed ? (report.drift.stale ? 'recall index stale' : 'recall index current') : 'no recall index',
          note: report.drift.recommendation,
          keyWidth,
        })
      );
    }
    return 0;
  }

    if (subcommand === 'promote') {
    const logger = (m) => log(flags, m);
    const ids = flags.ids ? flags.ids.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const result = buildPromotionOps({ workspace, branchKey: flags.branch, ids, all: flags.all, log: logger });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'promote',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else if (!result.pass) {
      for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
        console.error(l);
      }
    } else {
      console.log(
        ui.line({
          state: 'ok',
          key: 'promote',
          value: `${result.ops} op(s) → ${result.opsPath}`,
          note: `${result.bucketKey}${result.remaining ? ` · remaining ${result.remaining}` : ''}${result.skipped.length ? ` · skipped ${result.skipped.length}` : ''}`,
        })
      );
      for (const s of result.skipped) console.log(ui.paint('muted', `  skip ${s.id} — ${s.reason}`));
      printNext(result.nextTools?.[0]);
    }
    return result.exitCode;
  }

    if (subcommand === 'prune') {
    const logger = (m) => log(flags, m);
    const result = pruneBuckets({
      workspace,
      branchKey: flags.branch,
      merged: flags.merged,
      staleDays: flags.stale,
            yes: flags.yes,
      log: logger,
    });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'prune',
      result: result.pass ? 'pass' : 'fail',
      exitCode: result.exitCode,
      blockedReason: result.blockedReason,
    });
    if (flags.json) {
      emitJson(flags, result);
    } else {
            for (const p of result.preview || []) {
        console.log(
          ui.paint(
            'muted',
            `  ${p.key}${p.branch ? ` (${p.branch})` : ''} — ${p.active ?? '?'} active · ${p.promoted ?? '?'} promoted · ${p.total ?? '?'} total`
          )
        );
      }
      if (!result.pass) {
        for (const l of ui.errorBlock({ code: 'E_USAGE', message: result.blockedReason, exit: result.exitCode })) {
          console.error(l);
        }
      } else {
        console.log(
          ui.line({
            state: 'warn',
            key: 'prune',
            value: `${result.removed.length} bucket(s) removed`,
            note: result.removed.join(' · '),
          })
        );
      }
    }
    return result.exitCode;
  }

    if (subcommand === 'commit') {
    const commitValue = argv[1];
    if (!KNOWLEDGE_COMMIT_MODES.has(commitValue)) {
      writeEvent(workspace, flags, {
        type: 'knowledge',
        command: 'knowledge',
        decision: 'commit',
        result: 'fail',
        exitCode: EXIT.usage,
      });
      for (const l of ui.errorBlock({
        code: 'E_USAGE',
        message: `unknown commit mode: ${commitValue || '(none)'}`,
        fix: 'ae knowledge commit <none|repo>',
        exit: EXIT.usage,
      })) {
        console.error(l);
      }
      return EXIT.usage;
    }
    const commitResult = writeStoreConfig(workspace, { commit: commitValue });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: `commit ${commitValue}`,
      result: commitResult.pass ? 'pass' : 'fail',
      exitCode: commitResult.pass ? 0 : 1,
      blockedReason: commitResult.blockedReason,
    });
    if (!commitResult.pass) {
      if (flags.json) {
        emitJson(flags, commitResult);
      } else {
        for (const l of ui.errorBlock({ code: commitResult.code || 'E_USAGE', message: commitResult.blockedReason, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }
    if (flags.json) {
      emitJson(flags, { pass: true, commit: commitValue });
    } else {
      console.log(
        ui.line({ state: commitValue === 'repo' ? 'ok' : 'warn', key: 'knowledge', value: `commit ${commitValue}` })
      );
    }
    return 0;
  }

  if (subcommand && KNOWLEDGE_MODES.has(subcommand)) {
    const modeResult = writeStoreConfig(workspace, { mode: subcommand });
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: subcommand,
      result: modeResult.pass ? 'pass' : 'fail',
      exitCode: modeResult.pass ? 0 : 1,
      blockedReason: modeResult.blockedReason,
    });
    if (!modeResult.pass) {
      if (flags.json) {
        emitJson(flags, modeResult);
      } else {
        for (const l of ui.errorBlock({ code: modeResult.code || 'E_USAGE', message: modeResult.blockedReason, exit: 1 })) {
          console.error(l);
        }
      }
      return 1;
    }
    if (flags.json) {
      emitJson(flags, { pass: true, mode: subcommand });
    } else {
      console.log(
        ui.line({ state: subcommand === 'on' ? 'ok' : 'warn', key: 'knowledge', value: `mode ${subcommand}` })
      );
    }
    return 0;
  }

  if (!subcommand) {
    const { mode, commit } = readStoreConfig(workspace);
    writeEvent(workspace, flags, {
      type: 'knowledge',
      command: 'knowledge',
      decision: 'status',
      result: 'pass',
      exitCode: 0,
    });
    if (flags.json) {
      emitJson(flags, { mode, commit });
    } else {
      console.log(
        ui.line({ state: mode === 'on' ? 'ok' : 'warn', key: 'knowledge', value: `mode ${mode} · commit ${commit}` })
      );
    }
    return 0;
  }

  writeEvent(workspace, flags, {
    type: 'knowledge',
    command: 'knowledge',
    decision: subcommand,
    result: 'fail',
    exitCode: EXIT.usage,
  });
  for (const l of ui.errorBlock({
    code: 'E_USAGE',
    message: `unknown knowledge mode: ${subcommand}`,
    fix: 'ae knowledge <on|suggest|off|freeze|capture-only> | --status | purge <file|--all> | commit <none|repo> | migrate-store',
    exit: EXIT.usage,
  })) {
    console.error(l);
  }
  return EXIT.usage;
}

export async function cmdGet(argv) {
  const flags = parseFlags(argv);
  const workspace = path.resolve(flags.workspace);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  flags.home = flags.home || process.env.HARNESS_HOME;
  const result = runGet({ workspace, copilotHome, flags, home: flags.home });

  if (flags.json) {
    emitJson(flags, result);
  } else {
    console.log(ui.line({ key: 'get', value: result.docid || result.path, keyWidth: 3 }));
        console.log(result.excerpt.split('\n').map(inertLine).join('\n'));
  }
  return 0;
}

export async function cmdUninstall(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const lock = readLock(copilotHome);
  if (!lock?.files?.length) {
    const code = 'E_NOT_INSTALLED';
    const message = 'no lock file — nothing to uninstall';
    const hint = 'ae install';
    if (flags.json) {
      // Fix-wave C2: error envelopes are emission sinks too.
      console.error(redactedJson({ ok: false, error: { code, message, hint, exit: 1 } }));
    } else {
      for (const l of ui.errorBlock({ code, message, fix: hint, exit: 1 })) console.error(l);
    }
    return 1;
  }
  let removed = 0;
  for (const rel of lock.files) {
    const dest = resolveContainedPath(copilotHome, rel);
    if (!dest) {
      log(flags, `skip unsafe lock path: ${rel}`);
      continue;
    }
    if (!fs.existsSync(dest)) continue;
    if (flags.dryRun) {
      log(flags, `would remove ${rel}`);
      removed++;
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    removed++;
  }
  if (uninstallVSCodeBridge(lock.vscodeBridge, { dryRun: flags.dryRun, log: (message) => log(flags, message) })) {
    removed++;
  }
  if (!flags.dryRun) {
    fs.rmSync(path.join(copilotHome, LOCK_NAME), { force: true });
  }
  log(flags, `uninstall removed ${removed} paths`);
  return 0;
}

export async function cmdResolve(argv) {
  const flags = parseFlags(argv);
  const copilotHome = resolveCopilotHome(flags.copilotHome);
  const workspace = path.resolve(flags.workspace);
  const resolved = resolveHarnessBin({ workspace, copilotHome });
  const runner = path.join(workspace, '.harness', 'run.mjs');
  const shim = globalHarnessShimPath(copilotHome);

  const payload = {
    bin: resolved.bin,
    source: resolved.source,
    globalShim: fs.existsSync(shim) ? shim : null,
    onPath: resolved.onPath,
    runner: fs.existsSync(runner) ? runner : null,
    agentCommand: agentHarnessCommand(resolved),
    tried: resolved.tried,
  };

  if (flags.json) {
    emitJson(flags, payload);
  } else {
    if (payload.agentCommand) {
      const keyWidth = keyWidthFor(['resolve', 'agent']);
      console.log(ui.line({ state: 'ok', key: 'resolve', value: resolved.bin, note: resolved.source, keyWidth }));
      console.log(ui.line({ key: 'agent', value: payload.agentCommand, keyWidth }));
    } else {
      for (const l of ui.errorBlock({
        code: 'E_NO_HARNESS_BIN',
        message: 'could not resolve the harness CLI',
        fix: 'ae install',
        exit: 1,
      })) {
        console.error(l);
      }
      for (const t of resolved.tried) console.error(ui.paint('muted', `  tried ${t.source}  ${t.path}`));
    }
  }
  return resolved.bin ? 0 : 1;
}
