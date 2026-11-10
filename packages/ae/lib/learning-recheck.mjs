import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileNoFollow, readFileTailNoFollow, assertNoSymlinkAncestors } from './fs-safe.mjs';
import { redactSecrets, secretSpans, maskSpans } from './secret-scan.mjs';
import { createRedactor } from './redact.mjs';
import { foldRuns, RUNS_FILE } from './run-journal.mjs';
import { readRecheckConfig, readStoreConfig, repoId, inertLine } from './knowledge/store.mjs';
import { learningApplicability, APPLICABILITY_VERSION } from './knowledge/applicability.mjs';

// Consolidation re-check (agent memory plan, Phase 2). Every signal here is
// evidence for judgment built only from Harness-owned records in the
// checkout (exposure records, verification evidence, the run journal, review
// observations) and the learning store. Nothing in this module writes, and no
// state of `knowledge.recheck` grants authority. Host transcripts are never
// read: they are not authenticated.

export const RECHECK_PLAN_THRESHOLD = 2;
export const RECHECK_SECTION_CAP = 10;
export const RECHECK_DUE_STALE_EXPOSED = 3;
export const RECHECK_DUE_CLUSTER_PLANS = 3;
export const RECHECK_EXCERPT_CAP = 400;
const RECHECK_MASK_WINDOW = 8 * RECHECK_EXCERPT_CAP;
const RECHECK_LONG_TOKEN = 1024;
// Complete escape sequences only: CSI (7- and 8-bit, any parameter bytes), and OSC, DCS, SOS, PM and APC
// strings closed by BEL or ST (7- and 8-bit). A string body stops at the next introducer, so stripping stays
// linear. Any other ESC, 8-bit introducer or ST (a bare ESC, `\x1b(B`, an unterminated string) is not
// stripped with the bytes after it: `BARE_ESCAPE` turns it into a `SEP`, so `\x1bBearer` keeps its `B`.
const ANSI_ESCAPE = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b[P\]X^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x90\x98\x9b-\x9f]*(?:\x07|\x1b\\|\x9c)/g;
const BARE_ESCAPE = /[\x1b\x90\x98\x9b-\x9f]/g;
// C0 and C1 controls and DEL, other than \t \n \v \f \r, render as nothing: like invisible characters
// they are read both removed and as a word break (`api\x00_key` is `api_key`), never only as a space.
const EXCERPT_CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;
// Characters that render as nothing: format characters (zero-width, soft hyphen, bidi controls and the rest)
// and default-ignorable code points (variation selectors, Hangul fillers). The excerpt's private-use
// sentinel is listed too, so input cannot forge one.
const EXCERPT_INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\ue000]+/gu;
// Stands in for a run of invisible characters (or controls, or a bare escape) until both readings (removed, and split) are taken.
const SEP = '\ue000';
const WITHHELD_LINE = '[withheld: credential-like]';
// Fail-closed line rule. Pattern masking alone kept leaking through new input shapes (a bare ESC eating a
// keyword's first letter, a control or a homoglyph inside it, a keyword wrapped onto the previous line), so a
// line is withheld whole when its skeleton (escapes stripped, NFKC, lowercased, every character outside
// [a-z0-9] deleted) holds any of these. Short ones (`npm`, `ghp`, `basic`, `eyj`) and the skeleton's joined
// words over-withhold ordinary lines such as "npm test failed": accepted, since an excerpt or a title is
// only a hint for judgment and the record it came from stays readable.
const CREDENTIAL_WORDS = ['bearer', 'authorization', 'basic', 'token', 'secret', 'password', 'passwd', 'apikey', 'accesskey', 'privatekey', 'credential', 'ghp', 'gho', 'ghs', 'ghu', 'ghr', 'githubpat', 'npm', 'akia', 'asia', 'aiza', 'xox', 'glpat', 'eyj'];
const CREDENTIAL_WORD = new RegExp(CREDENTIAL_WORDS.join('|'));
// How much of the previous line's skeleton is carried into the next, so a keyword split across lines is seen.
const CARRY = Math.max(...CREDENTIAL_WORDS.map(word => word.length)) - 1;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const TOKEN_RUN = /[A-Za-z0-9+\/_=-]{20,}/g;
// A letter outside ASCII touching an ASCII letter (`Веаrer` with Cyrillic В, е and а).
const MIXED_SCRIPT = /[A-Za-z][^\P{L}A-Za-z]|[^\P{L}A-Za-z][A-Za-z]/u;
const UNSEEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\ue000]+/gu;
const redactText = createRedactor({ env: {} }).redactText;
const PRIVATE_KEY = /PRIVATE\s*KEY/;
// Fields dropped from the front of a cut masking window. The widest keyword context ahead of a value
// in secret-scan's patterns is three fields (basic-auth: `Authorization"`, `:`, `"Basic`), and the cut
// can split one more, so a value whose keyword fell outside the window sits in the first four fields.
const RECHECK_CUT_FIELDS = 4;
/** `derived_from` reference to a failure cluster. The ID is a stable digest of the cluster key. */
export const FAILURE_CLUSTER_REF = /^failure-cluster:[a-f0-9]{16}$/;
const SCAN_CAP = 512;
const PLAN_LIST_CAP = 5;
const REF_LIST_CAP = 8;
const FINDING_TITLE_CAP = 120;
// A title is cut to this before it is screened (the generic-api-key pattern is superlinear on long input).
// Only the first 120 characters are shown. A secret that reaches into them needs well under 512 characters
// for its pattern to match, so it is still redacted; text past the cap is never shown, so a secret the cap
// cuts cannot expose its tail.
const FINDING_TITLE_SCAN_CAP = 512;
const HASH_FILE = /^[a-f0-9]{64}\.json$/;
const JOURNAL_BYTE_CAP = 8 * 1024 * 1024;

/** Cluster IDs are digests of the cluster key, so they can be recomputed from the same evidence at any time. */
export const failureClusterId = key => crypto.createHash('sha256').update(`failure-cluster\0${key}`).digest('hex').slice(0, 16);
const findingClusterId = key => crypto.createHash('sha256').update(`finding-cluster\0${key}`).digest('hex').slice(0, 16);

/**
 * Effective read state. Knowledge modes keep priority: `off`, `freeze` and
 * `capture-only` read re-check as `off` whatever the key says.
 */
export function recheckState({ workspace, home }) {
  const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) return 'off';
  return readRecheckConfig(workspace, { home });
}

/**
 * Record names, newest first by modification time. Modification time only
 * preselects (twice the cap): callers that can order by the record's own
 * timestamp re-rank and cap with `newestRecords`, since copies and restores
 * reset mtime.
 */
function listRecordNames(root, rel, pattern, limit = SCAN_CAP * 2) {
  const dir = assertNoSymlinkAncestors(root, rel);
  if (!dir) return { names: [], omitted: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => {
      let mtime = 0;
      try { mtime = fs.lstatSync(path.join(dir, entry.name)).mtimeMs; } catch { mtime = 0; }
      return { name: entry.name, mtime };
    });
  } catch { return { names: [], omitted: 0 }; }
  entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  return { names: entries.slice(0, limit).map(entry => entry.name), omitted: Math.max(0, entries.length - limit) };
}

/** Keep the `SCAN_CAP` records with the newest own timestamp; the rest add to `omitted`. */
function newestRecords(records, timestamp, omitted) {
  const ranked = records.toSorted((a, b) => String(timestamp(b) || '').localeCompare(String(timestamp(a) || '')));
  return { records: ranked.slice(0, SCAN_CAP), omitted: omitted + Math.max(0, ranked.length - SCAN_CAP) };
}

const digestOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A history or observation record whose name is not the digest of its content was not written by Harness. */
function readDigestRecord(root, rel, name) {
  const value = readJson(root, rel);
  return value && digestOf(value) === name.slice(0, -'.json'.length) ? value : null;
}

function readJson(root, rel) {
  const text = readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Normalize retained output for masking. ANSI escapes (CSI, OSC and the short
 * forms, in 7- and 8-bit encodings) are stripped, so a colour code or
 * hyperlink cannot sit between a keyword and its value. NFKC folds fullwidth
 * and compatibility forms (`＝`, `ｋｅｙ`) to the ASCII the patterns match.
 * A bare ESC and C0 and C1 controls other than whitespace become `SEP`, as
 * invisible characters do. Every run of invisible characters
 * becomes one `SEP`, and whitespace runs
 * (with any `SEP` touching them) collapse to one space, so padding cannot push
 * a keyword such as `client_secret=` or `Authorization: Bearer` out of the
 * masking window while its value stays in the tail. Every step is linear.
 */
function normalizeExcerpt(raw) {
  return raw.replace(ANSI_ESCAPE, '').replace(BARE_ESCAPE, SEP).normalize('NFKC').replace(EXCERPT_CONTROLS, SEP).replace(EXCERPT_INVISIBLE, SEP)
    .replace(/\ue000?\s[\s\ue000]*/g, ' ').replace(/^[ \ue000]+|[ \ue000]+$/g, '');
}

// `://` with an `@` after it (URL credentials), by index so a line of many `://` stays linear.
const hasUserinfo = text => { const at = text.indexOf('://'); return at !== -1 && text.indexOf('@', at + 3) !== -1; };
const hasMixedRun = text => {
  for (const [run] of text.matchAll(TOKEN_RUN)) if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return true;
  return false;
};

/**
 * The fail-closed line rule. Lines split on \n, \r, U+2028 and U+2029, after
 * complete escape sequences are stripped. A line is withheld when its
 * skeleton, with the tail of the previous non-empty line's skeleton in front
 * (so `Authorization: Bearer` wrapped before its value still counts), holds a
 * credential word; when it holds `://` and later `@`; when it holds a run of
 * 20 or more token characters mixing letters and digits; or when a non-ASCII
 * letter touches an ASCII one. The last three are read on the line as given
 * and with controls and invisible characters removed. Every check is linear.
 * Returns each line with `withheld` set; withheld lines must never be shown.
 */
function screenLines(raw) {
  let carry = '';
  return raw.replace(ANSI_ESCAPE, '').replace(BARE_ESCAPE, SEP).split(LINE_BREAK).map(line => {
    const folded = line.normalize('NFKC');
    const flat = folded.replace(UNSEEN, '');
    const skeleton = folded.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const withheld = CREDENTIAL_WORD.test(carry + skeleton) || hasUserinfo(line) || hasUserinfo(flat)
      || hasMixedRun(line) || hasMixedRun(flat) || MIXED_SCRIPT.test(flat);
    if (skeleton) carry = skeleton.slice(-CARRY);
    return { line, withheld };
  });
}

/** `raw` with every withheld line replaced by the marker (a run of them by one), lines rejoined with \n. */
function withholdLines(raw) {
  const out = [];
  for (const { line, withheld } of screenLines(raw)) {
    if (!withheld) out.push(line);
    else if (out.at(-1) !== WITHHELD_LINE) out.push(WITHHELD_LINE);
  }
  return out.join('\n');
}

// A private-key header, read with controls and invisible characters removed, before and after escapes are stripped.
const hasPrivateKey = raw => [raw, raw.replace(ANSI_ESCAPE, '')].some(text => PRIVATE_KEY.test(text.replace(UNSEEN, '').normalize('NFKC')));
// Anything visible once escapes, controls and invisible characters are set aside.
const VISIBLE = /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\ue000]/u;

/**
 * Bounded, secret-screened tail of a failing check's retained output.
 *
 * Fail closed first: any line the line rule (`screenLines`) flags is withheld
 * whole as `[withheld: credential-like]` before anything else reads it. The
 * pattern masking below is a second layer over what is left, and redact.mjs's
 * patterns a third over the kept tail.
 *
 * Any private-key header withholds it, checked with controls and invisible
 * characters removed, before and after escapes are stripped, and before
 * any token is withheld or window taken, so neither a colour code nor a
 * zero-width character inside `PRIVATE KEY` hides the key body.
 *
 * An invisible character inside a word is read two ways, and a secret either
 * reading finds is masked: removed (so `api<ZWSP>_key` reads `api_key`, and
 * that joined text is what the excerpt shows) and as a space (so
 * `x<ZWSP>Bearer` still has a word boundary before `Bearer`).
 *
 * Any unbroken run of `RECHECK_LONG_TOKEN` or more non-space characters is
 * withheld whole, so the tail of a secret longer than the window cannot
 * survive without its keyword. Masking runs over a bounded window of the
 * output's end (some patterns are superlinear on long output). Masking can
 * shrink that window enough for the kept tail to reach its start, where the
 * cut may have separated a value from its keyword, so when the window is cut
 * its first `RECHECK_CUT_FIELDS` fields are never shown. The last characters
 * are then kept and screened once more.
 */
export function failureExcerpt(check) {
  // Normalize each candidate before choosing, so stderr holding only escapes or controls does not hide stdout.
  const raw = [check?.stderr, check?.stdout, check?.message].find(value => typeof value === 'string' && VISIBLE.test(value.replace(ANSI_ESCAPE, '')));
  if (!raw) return null;
  if (hasPrivateKey(raw)) return '[withheld: private-key]';
  const text = normalizeExcerpt(withholdLines(raw));
  // Split rather than match `\S{1024,}`: that regex rescans every run just under the threshold.
  const flat = text.split(' ').map(run => (run.length >= RECHECK_LONG_TOKEN ? '[withheld: long-token]' : run)).join(' ');
  const cut = flat.length > RECHECK_MASK_WINDOW;
  const window = cut ? flat.slice(-RECHECK_MASK_WINDOW) : flat;
  // `joined` drops each SEP; `split` turns it into a space. `toJoined` maps a `split` offset to `joined`.
  const toJoined = new Array(window.length + 1);
  let joined = '', split = '';
  for (let i = 0; i < window.length; i += 1) {
    toJoined[i] = joined.length;
    if (window[i] === SEP) split += ' ';
    else { joined += window[i]; split += window[i]; }
  }
  toJoined[window.length] = joined.length;
  const spans = [...secretSpans(joined), ...secretSpans(split).map(span => ({ ...span, start: toJoined[span.start], end: toJoined[span.end] }))];
  let from = 0;
  for (let field = 0; cut && field < RECHECK_CUT_FIELDS; field += 1) {
    const space = joined.indexOf(' ', from);
    from = space === -1 ? joined.length : space + 1;
  }
  return redactText(redactSecrets(maskSpans(joined, spans, from).slice(-RECHECK_EXCERPT_CAP))).slice(-RECHECK_EXCERPT_CAP) || null;
}

/**
 * A finding title as shown: capped at `FINDING_TITLE_SCAN_CAP` before it is
 * screened, withheld whole as `[withheld: credential-like]` when any line
 * trips the line rule or it holds a private-key header, otherwise normalized
 * like an excerpt (invisible characters removed), pattern-screened in both
 * readings, made inert and cut to `FINDING_TITLE_CAP`.
 */
function findingTitle(value) {
  const capped = value.trim().slice(0, FINDING_TITLE_SCAN_CAP);
  if (!capped) return '';
  if (hasPrivateKey(capped) || screenLines(capped).some(line => line.withheld)) return WITHHELD_LINE;
  const normalized = normalizeExcerpt(capped);
  const joined = normalized.replaceAll(SEP, ''), split = normalized.replaceAll(SEP, ' ');
  const screened = redactSecrets(joined) !== joined ? redactSecrets(joined) : redactSecrets(split) !== split ? redactSecrets(split) : joined;
  return inertLine(redactText(screened)).slice(0, FINDING_TITLE_CAP);
}

/**
 * Only a named check (from checks.yaml) whose process failed is failure
 * evidence: a nonzero exit, or a timeout with retained output. Harness's
 * built-in gate rows (plan-state, phase-tasks, scope, required-reviews and the
 * rest) carry no process result: they say the work was unfinished, not that
 * something broke. A passing process whose row Harness later marked failed
 * (an artifact or domain manifest refusal) keeps exit 0 and is excluded too.
 */
const processFailed = check => (check.status === 'failed' && Number.isInteger(check.exitCode) && check.exitCode !== 0)
  || (check.status === 'timeout' && ['stdout', 'stderr'].some(key => Object.hasOwn(check, key)));

const byStrength = (a, b) => b.plan_count - a.plan_count || String(b.last_seen || '').localeCompare(String(a.last_seen || '')) || a.id.localeCompare(b.id);

function finishCluster(row) {
  const plans = [...row.plans].sort();
  return { ...row, plans: plans.slice(0, PLAN_LIST_CAP), plan_count: plans.length };
}

/**
 * A failure counts toward a cluster only when it is timestamped after the
 * latest learning-writing consolidation that consumed an episode answering the
 * cluster (`derived_from`), so answering a cluster clears it until the failure
 * recurs, the same day or later.
 */
const unresolved = (resolved, id, at) => !resolved.has(id) || (typeof at === 'string' && at > resolved.get(id));

/**
 * Failed named `ae verify` checks, grouped by check ID across plans, from the
 * digest-named evidence history Harness writes on every verification.
 */
function evidenceClusters(workspace, resolved) {
  const history = listRecordNames(workspace, '.harness/evidence/history', HASH_FILE);
  const read = history.names.map(name => ({ rel: `.harness/evidence/history/${name}`, value: readDigestRecord(workspace, `.harness/evidence/history/${name}`, name) })).filter(record => record.value);
  const { records, omitted } = newestRecords(read, record => record.value.verifiedAt, history.omitted);
  const clusters = new Map();
  for (const { rel, value } of records) {
    if (typeof value.plan !== 'string' || !value.plan || !Array.isArray(value.checks)) continue;
    const at = typeof value.verifiedAt === 'string' ? value.verifiedAt : null;
    for (const check of value.checks) {
      if (!check || typeof check.id !== 'string' || !check.id || !processFailed(check)) continue;
      const checkId = inertLine(check.id).slice(0, 200);
      const key = `check:${checkId}`;
      if (!unresolved(resolved, failureClusterId(key), at)) continue;
      const row = clusters.get(key) || { id: failureClusterId(key), source: 'evidence', check: checkId, plans: new Set(), failures: 0, first_seen: null, last_seen: null, excerpt: null, evidence: [] };
      row.plans.add(value.plan);
      row.failures += 1;
      if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
      if (at && (!row.last_seen || at >= row.last_seen)) { row.last_seen = at; row.excerpt = failureExcerpt(check); }
      if (!row.evidence.includes(rel)) row.evidence.push(rel);
      clusters.set(key, row);
    }
  }
  return { clusters: [...clusters.values()], omitted };
}

/**
 * Bounded, no-follow read of the run journal's newest bytes. An unsafe or
 * symlinked journal contributes nothing; an oversized one contributes its
 * tail, without the first partial line, and says so.
 */
function readJournalBounded(workspace) {
  const rel = path.join('.harness', RUNS_FILE);
  const full = assertNoSymlinkAncestors(workspace, rel);
  const tail = full ? readFileTailNoFollow(full, { root: workspace, maxBytes: JOURNAL_BYTE_CAP }) : null;
  if (!tail) return { records: [], truncated: false };
  let text = tail.buffer.toString('utf8');
  if (tail.truncated) text = text.slice(text.indexOf('\n') + 1);
  return { records: text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean), truncated: tail.truncated };
}

/**
 * Failed runs per command across plans, from the run journal's `run.result`
 * records. Context only: a journal result cannot tell a gate refusal from a
 * broken check, so these clusters never make consolidation due.
 */
function journalClusters(workspace, resolved) {
  const journal = readJournalBounded(workspace);
  let runs = [];
  try { runs = foldRuns(journal.records, { isAlive: () => false }); } catch { return { clusters: [], truncated: journal.truncated }; }
  const clusters = new Map();
  for (const run of runs) {
    if (run.status !== 'failed' || typeof run.plan !== 'string' || !run.plan || typeof run.command !== 'string' || !run.command) continue;
    const command = inertLine(run.command).slice(0, 80);
    const key = `command:${command}`;
    const at = run.finishedAt || run.startedAt || null;
    if (!unresolved(resolved, failureClusterId(key), at)) continue;
    const row = clusters.get(key) || { id: failureClusterId(key), source: 'run-journal', command, plans: new Set(), failures: 0, first_seen: null, last_seen: null };
    row.plans.add(run.plan);
    row.failures += 1;
    if (at && (!row.first_seen || at < row.first_seen)) row.first_seen = at;
    if (at && (!row.last_seen || at > row.last_seen)) row.last_seen = at;
    clusters.set(key, row);
  }
  return { clusters: [...clusters.values()], truncated: journal.truncated };
}

/** Recurring review findings grouped by perspective (the finding category) and file across plans. */
function findingClusters(workspace) {
  const { names, omitted } = listRecordNames(workspace, '.harness/reviews/observations', HASH_FILE, SCAN_CAP);
  const packetPlans = new Map(), clusters = new Map();
  for (const name of names) {
    const input = readDigestRecord(workspace, `.harness/reviews/observations/${name}`, name);
    if (!input || !/^[a-f0-9]{64}$/.test(input.packet || '') || !Array.isArray(input.results)) continue;
    if (!packetPlans.has(input.packet)) packetPlans.set(input.packet, readJson(workspace, `.harness/reviews/packets/${input.packet}.json`)?.plan ?? null);
    const plan = packetPlans.get(input.packet);
    if (typeof plan !== 'string' || !plan) continue; // standalone reviews belong to no plan
    for (const result of input.results) {
      if (typeof result?.reviewer !== 'string' || !Array.isArray(result.findings)) continue;
      for (const finding of result.findings) {
        const file = typeof finding?.file === 'string' ? path.posix.normalize(finding.file.replace(/\\/g, '/')) : '';
        if (!file || file.startsWith('../') || /[\0\r\n]/.test(file)) continue;
        const category = inertLine(result.reviewer).slice(0, 80);
        const key = `${category}\0${file}`;
        const row = clusters.get(key) || { id: findingClusterId(key), category, file: inertLine(file).slice(0, 512), plans: new Set(), findings: 0, titles: [] };
        row.plans.add(plan);
        row.findings += 1;
        const title = typeof finding.title === 'string' ? findingTitle(finding.title) : '';
        if (title && row.titles.length < 3 && !row.titles.includes(title)) row.titles.push(title);
        clusters.set(key, row);
      }
    }
  }
  return { clusters: [...clusters.values()], omitted };
}

/**
 * Exposure entries across the newest plan records: learning ID -> last
 * exposure, total count, plans. `omitted` counts the plan records left out by
 * the preselect and the cap.
 */
function exposureIndex(workspace) {
  const listed = listRecordNames(workspace, '.harness/learning/exposures', /^plan-[a-f0-9]{64}\.json$/);
  const valid = listed.names.map(name => readJson(workspace, `.harness/learning/exposures/${name}`))
    .filter(record => record?.version === 1 && typeof record.plan === 'string' && Array.isArray(record.entries));
  const latest = record => record.entries.reduce((max, entry) => (typeof entry?.lastExposedAt === 'string' && entry.lastExposedAt > max ? entry.lastExposedAt : max), '');
  const index = new Map();
  const kept = newestRecords(valid, latest, listed.omitted);
  for (const record of kept.records) {
    for (const entry of record.entries) {
      if (typeof entry?.id !== 'string') continue;
      const row = index.get(entry.id) || { last: null, count: 0, plans: new Set() };
      if (typeof entry.lastExposedAt === 'string' && (!row.last || entry.lastExposedAt > row.last)) row.last = entry.lastExposedAt;
      row.count += Number.isInteger(entry.count) ? entry.count : 0;
      row.plans.add(record.plan);
      index.set(entry.id, row);
    }
  }
  return { index, omitted: kept.omitted };
}

/** Exposed learnings whose recorded source bindings no longer match the checkout. */
function staleExposed(workspace, learnings) {
  const { index: exposed, omitted } = exposureIndex(workspace);
  if (!exposed.size) return { rows: [], omitted };
  const repository = learnings.some(l => String(l.fm.applicability_version) === String(APPLICABILITY_VERSION)) ? repoId(workspace) : null;
  const cache = new Map(), out = [];
  for (const learning of learnings) {
    const exposure = exposed.get(learning.id);
    if (!exposure) continue;
    const applicability = learningApplicability({ workspace, fm: learning.fm, repository, cache });
    if (applicability.state !== 'needs-review') continue;
    out.push({
      id: learning.id,
      changed_paths: applicability.bindings.filter(b => ['changed', 'missing', 'excluded'].includes(b.state)).map(b => ({ path: b.path, state: b.state })).slice(0, REF_LIST_CAP),
      last_exposed: exposure.last,
      exposures: exposure.count,
      plan_count: exposure.plans.size,
    });
  }
  return { rows: out.sort((a, b) => String(b.last_exposed || '').localeCompare(String(a.last_exposed || '')) || a.id.localeCompare(b.id)), omitted };
}

const CODE_SPAN = /`([^`\n]{1,300})`/g;
const LEARNING_REF = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*)$/;

const REF_PREFIX = /^(?:origin|upstream|refs|heads|tags|remotes)\//;

function pathLike(token) {
  return token.includes('/') && !/\s/.test(token) && !/[*?{}<>$~:|"'\\@]/.test(token)
    && !token.startsWith('/') && !token.startsWith('-') && !token.startsWith('.harness/') && !REF_PREFIX.test(token)
    && !token.split('/').includes('..') && path.posix.normalize(token).replace(/\/$/, '') === token.replace(/\/$/, '');
}

/** 'present', 'absent', or 'unknown' when the path is unsafe to inspect. */
function pathState(base, rel) {
  const full = assertNoSymlinkAncestors(base, rel.replace(/\/$/, ''));
  if (!full) return 'unknown';
  try { fs.lstatSync(full); return 'present'; } catch { return 'absent'; }
}

/** The workspace root plus each ancestor directory of the learning's anchors and source bindings. */
function referenceBases(workspace, fm) {
  const bases = new Set(['']);
  const anchors = [...(Array.isArray(fm?.anchors) ? fm.anchors : []), ...(Array.isArray(fm?.source_bindings) ? fm.source_bindings.map(b => b?.path) : [])];
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || !pathLike(anchor)) continue;
    for (let dir = path.posix.dirname(anchor); dir && dir !== '.'; dir = path.posix.dirname(dir)) bases.add(dir);
  }
  return [...bases].map(dir => (dir ? path.join(workspace, dir) : workspace));
}

/**
 * A path reference is reported missing only when some base (the root or an
 * anchor's ancestor) holds its first segment as a directory and no base holds
 * the whole path. Prose with slashes (`and/or`, `owner/repo`,
 * `application/json`), package names and Git refs never qualify.
 */
function missingPath(bases, token) {
  const first = token.split('/')[0];
  let checkable = false;
  for (const base of bases) {
    if (pathState(base, token) !== 'absent') return false;
    try { if (fs.lstatSync(path.join(base, first)).isDirectory()) checkable = true; } catch { /* absent */ }
  }
  return checkable;
}

/**
 * Inline code spans in a learning body that name another learning (`domain/slug`
 * with a known domain) or a repository path that no longer exists. Learning
 * references are checked against every golden and branch learning, active or not.
 */
function brokenReferences(workspace, learnings, allLearnings) {
  const ids = new Set(allLearnings.map(l => l.id));
  const domains = new Set(allLearnings.map(l => l.domain));
  const out = [];
  for (const learning of learnings) {
    const refs = [];
    const bases = referenceBases(workspace, learning.fm);
    for (const [, span] of String(learning.body || '').matchAll(CODE_SPAN)) {
      const token = span.trim();
      if (refs.some(ref => ref.ref === token)) continue;
      const asLearning = token.match(LEARNING_REF);
      if (asLearning && domains.has(asLearning[1]) && !/\.[a-z0-9]{1,8}$/i.test(token)) {
        if (!ids.has(token) && pathState(workspace, token) === 'absent') refs.push({ kind: 'learning', ref: token });
        continue;
      }
      if (pathLike(token) && missingPath(bases, token)) refs.push({ kind: 'path', ref: inertLine(token) });
    }
    if (refs.length) out.push({ id: learning.id, references: refs.slice(0, REF_LIST_CAP) });
  }
  return out;
}

const plansAtLeast = n => row => row.plans.size >= n;

/**
 * The `recheck` packet section. `reviewRequired` is the Phase 1 feedback list
 * of learnings judged `wrong` in their current version, shared with the
 * feedback section. Each list is capped with an omission count.
 */
export function recheckSummary({ workspace, learnings, allLearnings = learnings, reviewRequired = [], resolved = new Map() }) {
  const evidence = evidenceClusters(workspace, resolved);
  const journal = journalClusters(workspace, resolved);
  const failures = [...evidence.clusters, ...journal.clusters].filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const findings = findingClusters(workspace);
  const findingRows = findings.clusters.filter(plansAtLeast(RECHECK_PLAN_THRESHOLD)).map(finishCluster).sort(byStrength);
  const { rows: stale, omitted: exposureOmitted } = staleExposed(workspace, learnings);
  const broken = brokenReferences(workspace, learnings, allLearnings);
  const cap = list => list.slice(0, RECHECK_SECTION_CAP);
  const over = list => Math.max(0, list.length - RECHECK_SECTION_CAP);
  return {
    contract: { planThreshold: RECHECK_PLAN_THRESHOLD, cap: RECHECK_SECTION_CAP, dueStaleExposed: RECHECK_DUE_STALE_EXPOSED, dueClusterPlans: RECHECK_DUE_CLUSTER_PLANS },
    stale_exposed: cap(stale),
    review_required: cap(reviewRequired),
    failure_clusters: cap(failures),
    finding_clusters: cap(findingRows),
    broken_references: cap(broken),
    counts: { stale_exposed: stale.length, review_required: reviewRequired.length, failure_clusters: failures.length, finding_clusters: findingRows.length, broken_references: broken.length },
    omitted: {
      stale_exposed: over(stale), review_required: over(reviewRequired), failure_clusters: over(failures), finding_clusters: over(findingRows), broken_references: over(broken),
      ...(evidence.omitted || findings.omitted ? { scannedRecords: evidence.omitted + findings.omitted } : {}),
      ...(exposureOmitted ? { exposureRecords: exposureOmitted } : {}),
      ...(journal.truncated ? { journal: `only the newest ${JOURNAL_BYTE_CAP / (1024 * 1024)} MiB of the run journal was read` } : {}),
    },
    max_cluster_plans: failures.filter(row => row.source === 'evidence').reduce((n, row) => Math.max(n, row.plan_count), 0),
  };
}

/** Only with `knowledge.recheck=on`: three stale exposed learnings, or one named-check failure cluster across three plans. */
export function recheckDue(summary) {
  return summary.counts.stale_exposed >= RECHECK_DUE_STALE_EXPOSED || summary.max_cluster_plans >= RECHECK_DUE_CLUSTER_PLANS;
}
