import { EXIT } from './style.mjs';
import path from 'node:path';
import { validStorageSourceId } from './storage-aliases.mjs';

function invalidFlag(name, value, hint) {
  throw Object.assign(new Error(`invalid ${name}: ${JSON.stringify(value)} — ${hint}`), {
    code: 'E_USAGE',
    hint: 'ae help',
    exit: EXIT.usage,
  });
}

function parseMinScore(raw, flagName) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    invalidFlag(flagName, raw, 'must be a number between 0 and 1');
  }
  return n;
}

function parsePositiveInt(raw, flagName) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    invalidFlag(flagName, raw, 'must be an integer >= 1');
  }
  const n = parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    invalidFlag(flagName, raw, 'must be an integer >= 1');
  }
  return n;
}

function parsePhase(raw) {
  if (!['implement', 'verify'].includes(raw)) {
    invalidFlag('--phase', raw, 'must be implement or verify');
  }
  return raw;
}

function parseContextVersion(raw) {
  if (!['1', '2'].includes(raw)) invalidFlag('--context-version', raw, 'must be 1 or 2');
  return Number(raw);
}

function parseQuestionKind(raw) {
  if (!['lookup', 'dependency-path', 'change-impact', 'prior-lesson'].includes(raw)) {
    invalidFlag('--question-kind', raw, 'must be lookup, dependency-path, change-impact or prior-lesson');
  }
  return raw;
}

function parseLayer(raw) {
  if (!['golden', 'branch'].includes(raw)) {
    invalidFlag('--layer', raw, 'must be golden or branch');
  }
  return raw;
}

export const INSTALLED_TARGETS = Object.freeze(['vscode', 'cli', 'intellij']);
export const RECOGNIZED_UNINSTALLED_TARGETS = Object.freeze(['cursor', 'codex', 'grok']);

function assignTargets(flags, value) {
  const names = String(value ?? '').split(',').map((target) => target.trim());
  if (!names.length || names.some((name) => !name)) {
    invalidFlag('--target', value, 'requires a comma-separated target list');
  }
  const installed = new Set(INSTALLED_TARGETS);
  const recognized = new Set(RECOGNIZED_UNINSTALLED_TARGETS);
  const unknown = names.filter((name) => !installed.has(name) && !recognized.has(name));
  const skipped = names.filter((name) => recognized.has(name));
  if (unknown.length || skipped.length) {
    const parts = [];
    if (unknown.length) parts.push(`unknown target: ${unknown.join(', ')}`);
    if (skipped.length) {
      parts.push(`recognized but not installed: ${skipped.join(', ')} (ae install writes no host config for ${skipped.join(', ')})`);
    }
    parts.push(`installed targets: ${INSTALLED_TARGETS.join(', ')}`);
    invalidFlag('--target', value, parts.join('; '));
  }
  flags.targets = new Set(names);
  flags.targetsExplicit = true;
}

export function hasFlag(argv, name) {
  for (const a of argv) {
    if (a === '--') return false;
    if (a === name) return true;
  }
  return false;
}

export function parseFlags(argv) {
    const boundary = argv.indexOf('--');
  const scan = boundary === -1 ? argv : argv.slice(0, boundary);
  const flags = {
    effectivePolicy: false,
    dryRun: false,
    verbose: false,
    json: false,
    preserveKnowledge: true,
    forceProfile: false,
    configureVsCode: false,
    configurePath: false,
    autonomy: null,
    copilotHome: null,
    skillsHome: null,
    harnessHome: null,
    fromId: null,
    targets: new Set(['vscode', 'cli', 'intellij']),
    targetsExplicit: false,
    workspace: process.cwd(),
    query: null,
    files: null,
    contextVersion: 1,
    questionKind: null,
    generation: null,
    explain: false,
    read: false,
    phase: 'implement',
    limit: null,
    refresh: false,
    semantic: false,
    includePlans: false,
    strictIntent: false,
    allowInplace: false,
    noEvents: false,
    plan: null,
    base: null,
    enforcement: null,
    learnings: null,
    collection: null,
    minScore: 0.15,
    docid: null,
    path: null,
    reference: null,
    lines: 40,
    maxBytes: 2048,
    host: null,
    session: null,
    summary: false,
    failures: false,
    sync: false,
    global: false,
    check: false,
    growth: false,
    facts: false,
    insight: false,
    title: null,
    category: null,
    tags: null,
    trigger: null,
    claim: null,
    body: null,
    bodyFile: null,
    ops: null,
    domain: null,
    reason: null,
    to: null,
    why: null,
    applies: null,
    doesNotApply: null,
    shows: null,
    authority: null,
    yes: false,
    layer: null,
    branch: null,
    ids: null,
    all: false,
    merged: false,
    stale: null,
    since: null,
  };

  for (let i = 0; i < scan.length; i++) {
    const a = scan[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--shared') flags.shared = true;
    else if (a === '--verbose' || a === '-v') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--effective-policy') flags.effectivePolicy = true;
    else if (a === '--contract-digest') flags.contractDigest = true;
    else if (a === '--validate-evidence') flags.validateEvidence = true;
    else if (a === '--validate-completion') flags.validateCompletion = true;
    else if (a === '--packet') flags.packet = scan[++i];
    else if (a === '--reviewer') (flags.reviewers ||= []).push(scan[++i]);
    else if (a === '--learning-decision') flags.learningDecision = scan[++i];
    else if (a === '--explain') flags.explain = true;
    else if (a === '--read') flags.read = true;
    else if (a === '--context-version') flags.contextVersion = parseContextVersion(scan[++i]);
    else if (a.startsWith('--context-version=')) flags.contextVersion = parseContextVersion(a.slice('--context-version='.length));
    else if (a === '--question-kind') flags.questionKind = parseQuestionKind(scan[++i]);
    else if (a.startsWith('--question-kind=')) flags.questionKind = parseQuestionKind(a.slice('--question-kind='.length));
    else if (a === '--generation' || a.startsWith('--generation=')) {
      const value = a === '--generation' ? scan[++i] : a.slice('--generation='.length);
      if (!/^[a-f0-9]{32}$/.test(value || '')) invalidFlag('--generation', value, 'must be a 32-character generation identifier');
      flags.generation = value;
    }
    else if (a === '--refresh') flags.refresh = true;
    else if (a === '--semantic') flags.semantic = true;
    else if (a === '--include-plans') flags.includePlans = true;
    else if (a === '--strict-intent') flags.strictIntent = true;
    else if (a === '--allow-inplace') flags.allowInplace = true;
    else if (a === '--no-events') flags.noEvents = true;
    else if (a === '--summary') flags.summary = true;
    else if (a === '--failures') flags.failures = true;
    else if (a === '--sync') flags.sync = true;
    else if (a === '--global') flags.global = true;
    else if (a === '--check') flags.check = true;
    else if (a === '--facts') flags.facts = true;
    else if (a.startsWith('--query=')) flags.query = a.split('=').slice(1).join('=');
    else if (a === '--query') flags.query = scan[++i];
    else if (a.startsWith('--file=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--file', value, 'requires a path');
      if (!flags.files) flags.files = [];
      flags.files.push(value);
    } else if (a === '--file') {
      const next = scan[++i];
      if (next === undefined || next === '' || next.startsWith('--')) invalidFlag('--file', next, 'requires a path');
      if (!flags.files) flags.files = [];
      flags.files.push(next);
    }
    else if (a.startsWith('--phase=')) flags.phase = parsePhase(a.split('=')[1]);
    else if (a === '--phase') flags.phase = parsePhase(scan[++i]);
    else if (a === '--intent-page' || a.startsWith('--intent-page=')) flags.intentPage = parsePositiveInt(a === '--intent-page' ? scan[++i] : a.slice('--intent-page='.length), '--intent-page');
    else if (a === '--intent-page-size' || a.startsWith('--intent-page-size=')) {
      flags.intentPageSize = parsePositiveInt(a === '--intent-page-size' ? scan[++i] : a.slice('--intent-page-size='.length), '--intent-page-size');
      if (flags.intentPageSize > 32) invalidFlag('--intent-page-size', flags.intentPageSize, 'must be at most 32');
    }
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--limit') flags.limit = parseInt(scan[++i], 10);
    else if (a === '--preserve-knowledge') flags.preserveKnowledge = true;
    else if (a === '--force-knowledge-reset') flags.preserveKnowledge = false;
    else if (a === '--force-profile') flags.forceProfile = true;
    else if (a === '--configure-vscode') flags.configureVsCode = true;
    else if (a === '--configure-path') flags.configurePath = true;
    else if (a.startsWith('--autonomy=')) flags.autonomy = a.split('=')[1];
    else if (a === '--autonomy') flags.autonomy = scan[++i];
    else if (a.startsWith('--copilot-home=')) flags.copilotHome = a.split('=')[1];
    else if (a === '--copilot-home') flags.copilotHome = scan[++i];
    else if (a === '--skills-home' || a.startsWith('--skills-home=')) {
      const value = a === '--skills-home' ? scan[++i] : a.slice('--skills-home='.length);
      if (!value || value.startsWith('--')) invalidFlag('--skills-home', value, 'requires a directory path');
      flags.skillsHome = path.resolve(value);
    }
    else if (a.startsWith('--from-home=') || a === '--from-home') {
      const value = a === '--from-home' ? scan[++i] : a.slice('--from-home='.length);
      if (!value || value.startsWith('--')) invalidFlag('--from-home', value, 'requires a directory path');
      flags.fromHome = value;
    }
    else if (a.startsWith('--from-id=') || a === '--from-id') {
      const value = a === '--from-id' ? scan[++i] : a.slice('--from-id='.length);
      if (!validStorageSourceId(value)) invalidFlag('--from-id', value, 'requires local-<12 hex digits> or a canonical remote storage ID');
      flags.fromId = value;
    }
    else if (a.startsWith('--ae-home=') || a.startsWith('--harness-home=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--harness-home', value, 'requires a directory path');
      flags.harnessHome = value;
      flags.home = value;
    } else if (a === '--ae-home' || a === '--harness-home') {
      const next = scan[++i];
      if (next === undefined || next === '' || next.startsWith('--')) invalidFlag('--harness-home', next, 'requires a directory path');
      flags.harnessHome = next;
      flags.home = next;
    }
        else if (a.startsWith('--target=')) {
      const value = a.slice('--target='.length);
      if (!value) invalidFlag('--target', value, 'requires a comma-separated target list');
      assignTargets(flags, value);
    } else if (a === '--target') {
      const next = scan[++i];
            if (next === undefined || next === '' || next.startsWith('--')) invalidFlag('--target', next, 'requires a comma-separated target list');
      assignTargets(flags, next);
    } else if (a.startsWith('--plan=')) flags.plan = a.split('=').slice(1).join('=');
    else if (a === '--plan') flags.plan = scan[++i];
    else if (a.startsWith('--base=')) flags.base = a.split('=').slice(1).join('=');
    else if (a === '--base') flags.base = scan[++i];
    else if (a.startsWith('--enforcement=')) flags.enforcement = a.split('=').slice(1).join('=');
    else if (a === '--enforcement') flags.enforcement = scan[++i];
    else if (a.startsWith('--learnings=')) flags.learnings = a.split('=').slice(1).join('=');
    else if (a === '--learnings') flags.learnings = scan[++i];
        else if (a.startsWith('--workspace=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--workspace', value, 'requires a workspace path');
      flags.workspace = value;
    } else if (a === '--workspace') {
      const next = scan[++i];
            if (next === undefined || next === '' || next.startsWith('--')) invalidFlag('--workspace', next, 'requires a workspace path');
      flags.workspace = next;
    }
    else if (a === '-c' || a === '--collection') flags.collection = scan[++i];
    else if (a.startsWith('--collection=')) flags.collection = a.split('=')[1];
    else if (a.startsWith('--min-score=')) flags.minScore = parseMinScore(a.split('=')[1], '--min-score');
    else if (a === '--min-score') flags.minScore = parseMinScore(scan[++i], '--min-score');
    else if (a.startsWith('--reference=')) flags.reference = a.split('=').slice(1).join('=');
    else if (a === '--reference') flags.reference = scan[++i];
    else if (a.startsWith('--docid=')) flags.docid = a.split('=').slice(1).join('=');
    else if (a === '--docid') flags.docid = scan[++i];
    else if (a.startsWith('--path=')) flags.path = a.split('=').slice(1).join('=');
    else if (a === '--path') flags.path = scan[++i];
    else if (a.startsWith('--lines=')) flags.lines = parsePositiveInt(a.split('=')[1], '--lines');
    else if (a === '--lines') flags.lines = parsePositiveInt(scan[++i], '--lines');
    else if (a.startsWith('--offset=')) flags.offset = parsePositiveInt(a.split('=')[1], '--offset');
    else if (a === '--offset') flags.offset = parsePositiveInt(scan[++i], '--offset');
    else if (a.startsWith('--max-bytes=')) flags.maxBytes = parsePositiveInt(a.split('=')[1], '--max-bytes');
    else if (a === '--max-bytes') flags.maxBytes = parsePositiveInt(scan[++i], '--max-bytes');
    else if (a.startsWith('--host=')) flags.host = a.split('=').slice(1).join('=');
    else if (a === '--host') flags.host = scan[++i];
    else if (a.startsWith('--adapter=')) flags.adapter = a.split('=').slice(1).join('=');
    else if (a === '--adapter') flags.adapter = scan[++i];
    else if (a.startsWith('--session=')) flags.session = a.split('=').slice(1).join('=');
    else if (a === '--session') flags.session = scan[++i];
    else if (a === '--insight') flags.insight = true;
    else if (a === '--growth') flags.growth = true;
    else if (a === '--corpus') flags.corpus = true;
    else if (a.startsWith('--title=')) flags.title = a.split('=').slice(1).join('=');
    else if (a === '--title') flags.title = scan[++i];
    else if (a.startsWith('--category=')) flags.category = a.split('=').slice(1).join('=');
    else if (a === '--category') flags.category = scan[++i];
    else if (a.startsWith('--tags=')) flags.tags = a.split('=').slice(1).join('=');
    else if (a === '--tags') flags.tags = scan[++i];
    else if (a.startsWith('--trigger=')) flags.trigger = a.split('=').slice(1).join('=');
    else if (a === '--trigger') flags.trigger = scan[++i];
    else if (a.startsWith('--claim=')) flags.claim = a.split('=').slice(1).join('=');
    else if (a === '--claim') flags.claim = scan[++i];
    else if (a.startsWith('--body=')) flags.body = a.split('=').slice(1).join('=');
    else if (a === '--body') flags.body = scan[++i];
    else if (a.startsWith('--body-file=')) flags.bodyFile = a.split('=').slice(1).join('=');
    else if (a === '--body-file') flags.bodyFile = scan[++i];
    else if (a.startsWith('--ops=')) flags.ops = a.split('=').slice(1).join('=');
    else if (a === '--ops') flags.ops = scan[++i];
    else if (a.startsWith('--domain=')) flags.domain = a.split('=').slice(1).join('=');
    else if (a === '--domain') flags.domain = scan[++i];
    else if (a.startsWith('--reason=')) flags.reason = a.split('=').slice(1).join('=');
    else if (a === '--reason') flags.reason = scan[++i];
    else if (a.startsWith('--to=')) flags.to = a.split('=').slice(1).join('=');
    else if (a === '--to') flags.to = scan[++i];
    else if (a.startsWith('--why=')) flags.why = a.split('=').slice(1).join('=');
    else if (a === '--why') {
            const next = scan[i + 1];
      if (next !== undefined && !next.startsWith('--')) flags.why = scan[++i];
    }
    else if (a.startsWith('--applies=')) flags.applies = a.split('=').slice(1).join('=');
    else if (a === '--applies') {
      const next = scan[i + 1];
      if (next !== undefined && !next.startsWith('--')) flags.applies = scan[++i];
    }
    else if (a.startsWith('--does-not-apply=')) flags.doesNotApply = a.split('=').slice(1).join('=');
    else if (a === '--does-not-apply') {
      const next = scan[i + 1];
      if (next !== undefined && !next.startsWith('--')) flags.doesNotApply = scan[++i];
    }
    else if (a.startsWith('--shows=')) flags.shows = a.split('=').slice(1).join('=');
    else if (a === '--shows') {
      const next = scan[i + 1];
      if (next !== undefined && !next.startsWith('--')) flags.shows = scan[++i];
    }
    else if (a.startsWith('--authority=')) flags.authority = a.split('=').slice(1).join('=');
    else if (a === '--authority') {
      const next = scan[i + 1];
      if (next !== undefined && !next.startsWith('--')) flags.authority = scan[++i];
    }
    else if (a.startsWith('--since=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--since', value, 'requires a git ref value');
      flags.since = value;
    } else if (a === '--since') {
      const next = scan[++i];
      if (next === undefined || next.startsWith('--')) invalidFlag('--since', next, 'requires a git ref value');
      flags.since = next;
    }
    else if (a === '--yes') flags.yes = true;
    else if (a.startsWith('--layer=')) flags.layer = parseLayer(a.split('=')[1]);
    else if (a === '--layer') flags.layer = parseLayer(scan[++i]);
        else if (a.startsWith('--branch=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--branch', value, 'requires a bucket key value');
      flags.branch = value;
    } else if (a === '--branch') {
      const next = scan[++i];
      if (next === undefined || next.startsWith('--')) invalidFlag('--branch', next, 'requires a bucket key value');
      flags.branch = next;
    } else if (a.startsWith('--ids=')) {
      const value = a.split('=').slice(1).join('=');
      if (!value) invalidFlag('--ids', value, 'requires a comma-separated learning id list');
      flags.ids = value;
    } else if (a === '--ids') {
      const next = scan[++i];
      if (next === undefined || next.startsWith('--')) invalidFlag('--ids', next, 'requires a comma-separated learning id list');
      flags.ids = next;
    }
    else if (a === '--all') flags.all = true;
    else if (a === '--merged') flags.merged = true;
    else if (a.startsWith('--stale=')) flags.stale = parsePositiveInt(a.split('=')[1], '--stale');
    else if (a === '--stale') flags.stale = parsePositiveInt(scan[++i], '--stale');
  }

  if (flags.reference) {
    const linesSet = scan.some((token) => token === '--lines' || token.startsWith('--lines='));
    const bytesSet = scan.some((token) => token === '--max-bytes' || token.startsWith('--max-bytes='));
    if (!linesSet) flags.lines = 100_000;
    if (!bytesSet) flags.maxBytes = 200_000;
  }

  return flags;
}
