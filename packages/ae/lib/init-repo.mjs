import fs from 'fs';
import path from 'path';
import { ensureHarnessDir } from './session.mjs';
import { writeHarnessRunner } from './resolve-harness-bin.mjs';
import { writeCodebaseMap } from './repo-map/index.mjs';
import { ensureStore, storeDir, readLedger } from './knowledge/store.mjs';
import { collectEpisodes, consolidateStatus, splitLedger } from './knowledge/consolidate.mjs';
import { fileURLToPath } from 'node:url';
import { plansWriteTarget, projectStoreDir } from './project-layout.mjs';
import { harnessGlobalHome } from './paths.mjs';
import { runMigrateLayout } from './migrate-layout.mjs';
import { loadConfiguredChecks } from './plan-readiness.mjs';
import { validateCommand } from './checks.mjs';
import { inspectCheckReadiness } from './check-readiness.mjs';
import { resolveProjectAuthority, promoteProjectAuthority, PROJECT_AUTHORITY_FILES, assertExternalStateHome } from './project-authority.mjs';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';

const AGENT_CONTEXT_STUB = `# Agent Context

Repository-specific conventions for AI agents. Keep this file thin. Cross-repo learnings compound into \`~/.copilot/knowledge/solutions/\`.

## Conventions

_Add project-specific notes here._

## Related

- Plans and private context: the project store returned by \`ae init-repo --json\`
- Run \`ae doctor\` after global ae install.
`;

const CHECKS_STUB = `version: 1
checks: {}
# Add trusted argv arrays, for example:
#   unit-tests:
#     command: ["npm", "test"]
#     timeout_seconds: 600
`;

const POLICY_STUB = `version: 1
enforcement: enforce
gate_ttl_minutes: 30
evidence_ttl_hours: 24
exemptions: []
waivers: []
`;

export function runInitRepo({ workspace, flags, log, copilotHome }) {
  const stateHome = flags.home || harnessGlobalHome();
  assertExternalStateHome(workspace, stateHome);
  assertExternalStateHome(workspace, stateHome, projectStoreDir(workspace, { home: stateHome }));
  const stats = { created: [] };
  if (flags.shared) stats.promotion = promoteProjectAuthority(workspace, { home: flags.home || harnessGlobalHome(), dryRun: Boolean(flags.dryRun) });
  let authority;
  if (flags.shared && flags.dryRun) {
    const directory = path.join(workspace, '.github', 'harness');
    authority = { mode: 'shared', root: workspace, directory, files: Object.fromEntries(PROJECT_AUTHORITY_FILES.map(name => [name, path.join(directory, name)])) };
  } else {
    authority = resolveProjectAuthority(workspace, { home: stateHome, mode: flags.shared ? 'shared' : undefined });
  }
  const migrated = runMigrateLayout({
    workspace,
    dryRun: flags.dryRun,
    log,
    home: flags?.home,
  });
  stats.migrate = migrated;
  if (migrated.moved.length) {
    stats.migrated = migrated.moved;
  }
  if (migrated.conflicts.length) {
    log(`migrate left ${migrated.conflicts.length} conflict(s) — new plans go to the external project store`);
  }
  const plansTarget = plansWriteTarget(workspace, { home: flags?.home || harnessGlobalHome() });
  const plansDir = path.join(plansTarget.base, plansTarget.dirRel);
  const plansRel = plansDir;
  const agentCtx = path.join(projectStoreDir(workspace, { home: flags?.home || harnessGlobalHome() }), 'agent-context.md');
  const agentRel = agentCtx;
  const harnessConfigDir = authority.directory;
  for (const file of Object.values(authority.files)) {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) && readFileNoFollow(file, { root: authority.root, maxBytes: 1024 * 1024 }) === null) {
      throw Object.assign(new Error(`Unsafe or unreadable project configuration: ${file}`), { code: 'E_PROJECT_AUTHORITY', exit: 1 });
    }
  }
  const inventory = PROJECT_AUTHORITY_FILES.filter(name => name !== 'config.yaml' || fs.lstatSync(authority.files[name], { throwIfNoEntry: false }) || stats.promotion?.files.includes(name));
  stats.authority = { mode: authority.mode, directory: authority.directory, commit: authority.mode === 'shared', files: inventory.map(name => authority.mode === 'shared' ? `.github/harness/${name}` : authority.files[name]) };
  log(`${authority.mode} configuration: ${authority.directory}; ${authority.mode === 'shared' ? 'review and commit these project files before locking product work' : 'private to this AE home; no product configuration needs committing'}`);

  if (!flags.dryRun) {
    if (!ensureHarnessDir(workspace, false)) throw Object.assign(new Error('Unsafe or unavailable local runtime state or Git exclude metadata'), { code: 'E_INIT_REPO', exit: 1 });
    fs.mkdirSync(plansDir, { recursive: true });
  } else {
    ensureHarnessDir(workspace, true);
  }
  const gitkeep = path.join(plansDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    if (!flags.dryRun) fs.writeFileSync(gitkeep, '', 'utf8');
    stats.created.push(`${plansRel}/.gitkeep`);
    log(`created ${plansRel}/`);
  }

  if (!fs.existsSync(agentCtx)) {
    if (!flags.dryRun) {
      fs.mkdirSync(path.dirname(agentCtx), { recursive: true });
      fs.writeFileSync(agentCtx, AGENT_CONTEXT_STUB, 'utf8');
    }
    stats.created.push(agentRel);
    log(`created ${agentRel}`);
  } else {
    log(`skip ${agentRel} (exists)`);
  }

  stats.ignoreMetadata = 'Git-local excludes for .harness/; non-Git workspaces use .harness/.gitignore';
  log('ensured private .harness/ runtime state');

  const runner = writeHarnessRunner(workspace, flags.dryRun);
  if (runner.created) {
    stats.created.push('.harness/run.mjs');
    log('created .harness/run.mjs (local harness runner)');
  } else if (runner.updated) {
    stats.created.push('.harness/run.mjs');
    log('updated .harness/run.mjs (refreshed stale runner)');
  } else {
    log('skip .harness/run.mjs (exists)');
  }

  for (const [name, content] of [
    ['checks.yaml', CHECKS_STUB],
    ['policy.yaml', POLICY_STUB],
  ]) {
    const configPath = path.join(harnessConfigDir, name);
    if (!fs.existsSync(configPath)) {
      if (!flags.dryRun) {
        if (!writeFileContained(authority.root, path.relative(authority.root, configPath), content, { exclusive: true })) throw Object.assign(new Error(`Could not create project configuration: ${configPath}`), { code: 'E_INIT_REPO', exit: 1 });
      }
      stats.created.push(authority.mode === 'shared' ? `.github/harness/${name}` : configPath);
      log(`created ${configPath}`);
    }
  }

  const routingPath = path.join(harnessConfigDir, 'routing.yaml');
  if (!fs.existsSync(routingPath)) {
    const seed = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'routing.seed.yaml');
    if (fs.existsSync(seed)) {
      if (!flags.dryRun) {
        if (!writeFileContained(authority.root, path.relative(authority.root, routingPath), fs.readFileSync(seed), { exclusive: true })) throw Object.assign(new Error(`Could not create project routing: ${routingPath}`), { code: 'E_INIT_REPO', exit: 1 });
      }
      stats.created.push(authority.mode === 'shared' ? '.github/harness/routing.yaml' : routingPath);
      log(`created ${routingPath}`);
    }
  }

  // Committed cold-start orientation — advisory: never fail init on it.
  try {
    const map = writeCodebaseMap({ workspace, dryRun: flags.dryRun, local: true });
    if (map) {
      stats.created.push(map.path);
      log(`wrote ${map.path} (private orientation map, ~${map.tokens} tokens)`);
    }
  } catch {
    log('skip codebase map (map generation failed)');
  }

    try {
    const episodes = collectEpisodes({ workspace, copilotHome, home: flags?.home });
    if (episodes.length > 0) {
      if (flags.dryRun) {
        const { consumed } = splitLedger(readLedger(storeDir(workspace, { home: flags?.home })));
        const debt = episodes.filter((e) => !consumed.has(`${e.path}@${e.sha256}`)).length;
        if (debt > 0) {
          log(`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start`);
        }
      } else {
        const store = ensureStore(workspace, { home: flags?.home });
        const { debt } = consolidateStatus({ workspace, copilotHome, home: flags?.home });
        if (debt > 0) {
          if (store.created) stats.created.push('knowledge store');
          log(`armed ${debt} existing solution doc(s) as consolidation debt — drains at first session start`);
        }
      }
    }
  } catch {
    log('skip knowledge store arming (failed)');
  }

  if (flags.shared && flags.dryRun && stats.promotion.files.length > 0) {
    const message = 'Apply the reviewed shared-authority promotion, then inspect check readiness in this workspace. This dry run does not assess delivery readiness.';
    stats.checkReadiness = {
      status: 'deferred', ready: false, reason: 'authority-promotion-preview',
      source: authority.files['checks.yaml'], sourceMode: 'shared', sourceDigest: null,
      inspectionCommand: null, remediation: null, message,
    };
    log(message);
    return stats;
  }

  const configured = loadConfiguredChecks(workspace, { home: flags.home });
  if (!Object.entries(configured.checks || {}).some(([name, check]) => !validateCommand(name, check) && check.proof !== 'type-check')) {
    const message = `Engineer prepares real behavioral checks in ${authority.files['checks.yaml']} through ae checks configure --file -, then presents the exact commands for a person's trust approval before delivery.`;
    stats.prerequisites = [{ id: 'named-checks', message }];
    log(message);
  }
  stats.checkReadiness = inspectCheckReadiness({ workspace, copilotHome, home: flags.home });
  return stats;
}
