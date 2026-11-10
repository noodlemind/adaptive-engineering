import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensureStore,
  withStoreTransaction,
  StoreTransactionAbort,
  appendLedger,
  readLedger,
  listLearnings,
  commitStore,
  normalizeSlug,
  repoId,
  parseLearningFrontmatter,
  readStoreConfig,
  episodeLines,
  readGovernance,
  appendGovernance,
  serializeLearning,
  inertLine,
  provenanceLines,
  provenanceBytes,
  correctionLines,
  statusForAuthority,
  scanSecretsFolded,
} from './store.mjs';
import { deriveGitContext, isDetachedKey } from '../git-context.mjs';
import { MAX_OPS_PER_RUN, LEARNING_BYTE_CAP, QUARANTINE_THRESHOLD, DOMAIN_ACTIVE_CAP, isActiveFm, collectEpisodes, splitLedger } from './consolidate.mjs';
import { absorbOrAbort, mirrorLearnings } from './admin.mjs';
import { parseMergedFrom } from './listing.mjs';
import { resolveWriteLayer, ensureBucket, migrateRenamedBucket, episodeEligibleForLayer, storeHasBuckets } from './layer.mjs';
import { bucketDirFor, readBucketMeta, bucketAncestryOk, isSafeBucketKey } from './overlay.mjs';
import { readFileNoFollow, assertNoSymlinkAncestors } from '../fs-safe.mjs';
import { readLearningFile, writeLearningFile, writeStoreFile, readStoreFile } from './store-io.mjs';
import { episodeResolveRoots } from '../project-layout.mjs';
import { APPLICABILITY_VERSION, MAX_SOURCE_BINDINGS, applicabilityLines, applicabilityBytes, captureSourceBindings } from './applicability.mjs';

const FILE_TOUCHING = new Set(['ADD', 'STRENGTHEN', 'SUPERSEDE', 'MERGE']);

const PROMOTION_OP_KINDS = new Set(['ADD', 'STRENGTHEN', 'SUPERSEDE']);
const DISPUTED_FIX_THRESHOLD = 3;
const CONTENT_FAILURE_CODES = new Set(['E_SCHEMA', 'E_SECRET', 'E_LINT', 'E_BYTE_CAP', 'E_EXISTS', 'E_TARGET']);

function opWeight(op) {
  if (op.op === 'MERGE') return 1 + (Array.isArray(op.targets) ? op.targets.length : 0);
  return FILE_TOUCHING.has(op.op) ? 1 : 0;
}

/** A target too well-evidenced or human-taught to demote without a human. */
function isDisputedTargetFm(fm) {
  return verifiedFixLinks(fm) >= DISPUTED_FIX_THRESHOLD || fm.source === 'human';
}

/** Count of active (not superseded/retired/disputed) learnings in a domain. */
function activeCountInDomain(existing, domain) {
  let n = 0;
  for (const l of existing.values()) {
    if (l.domain === domain && isActiveFm(l.fm)) n++;
  }
  return n;
}

/** The normalized `domain/slug` id an ADD/SUPERSEDE/MERGE op would write to. */
function newIdFor(op) {
  return `${normalizeSlug(op.domain)}/${normalizeSlug(op.slug)}`;
}
const ANCHOR_RE = /\b[\w][\w./-]*\.(?:mjs|js|ts|tsx|py|java|sql|md|ya?ml|json)\b/g;
const ANCHOR_CAP = MAX_SOURCE_BINDINGS;

function fail(code, reason) {
  return { code, reason };
}

function promotedTargetRejection(i, id, promotedTo) {
  return {
    kind: 'reject',
    applied: [],
    governed: [],
    rejected: [
      fail(
        'E_TARGET',
        `op ${i}: target ${id} is promoted — behavior supersedes knowledge; update the primitive (${promotedTo}) or choose a new slug`
      ),
    ],
    committed: false,
    exitCode: 1,
  };
}

function yamlQuote(v) {
  return `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

export function todayClamped() {
  // Today's date, ISO-truncated to the day. (Not actually clamped against
  // anything — a real clock-skew guard would need an external reference.)
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every containment-valid candidate full path for an episode's declared
 * relative path — workspace root FIRST, then (when a copilotHome is given)
 * `copilotHome/knowledge` SECOND, then the user-level project store
 * (`~/.harness/projects/<repo-id>/`). These are the same roots
 * consolidate.mjs's `collectEpisodes` scans (product-repo-private
 * `docs/solutions/`, the global `~/.copilot/knowledge/solutions/`, and the
 * off-repo overlay), so a global or overlay episode's candidates-emitted
 * path resolves the same way it was collected from — a model asserting the
 * path verbatim (as instructed) must not have its evidence rejected purely
 * because apply.mjs only ever checked the workspace root. Each root gets
 * its OWN PHYSICAL containment guard (`assertNoSymlinkAncestors`,
 * fs-safe.mjs — the same helper purgeEpisode uses, closing the asymmetry an
 * adversarial review found: a path escaping ONE root lexically (a `../`
 * climb) OR resolving through a symlinked intermediate directory (e.g.
 * `docs/solutions` itself being a symlink — probe A2) is simply excluded
 * from the candidate list for THAT root — it is never allowed to "borrow"
 * containment from the other root. A plain lexical resolve+startsWith check
 * here previously let a symlinked `docs/solutions` verify an OUTSIDE file as
 * genuine episode evidence, since only the leaf was ever checked for being
 * a symlink. Returns an empty array when `p` is falsy or escapes/is unsafe
 * under every configured root. Existence is NOT checked here — callers try
 * each candidate in order (workspace first) and decide what "exists" means
 * for their own read (readFileNoFollow, fs.existsSync, ...). Each candidate
 * carries the `root` it resolved under so the reader can hand that exact
 * root to readFileNoFollow for a canonicalize-after-acquire containment
 * verify — the read must be checked against the SAME root the candidate
 * came from.
 */
function resolveEpisodeFile(workspace, copilotHome, p, home) {
  if (!p) return [];
  const candidates = [];
  for (const root of episodeResolveRoots(workspace, { home, copilotHome })) {
    const full = assertNoSymlinkAncestors(root, p);
    if (full) candidates.push({ full, root });
  }
  return candidates;
}

/** The first candidate (workspace, then the global root, then overlay) that
 * actually exists on disk — as a `{ full, root }` pair so the caller can
 * containment-verify the read against the matched root — or null if the path
 * escapes every root or exists in none of them. */
function episodeHashMatches(full, root, sha256) {
  if (!sha256) return true;
  const text = readFileNoFollow(full, { root });
  if (text === null) return false;
  return crypto.createHash('sha256').update(text).digest('hex') === sha256;
}

function firstExistingEpisodeFile(workspace, copilotHome, p, home, sha256) {
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, p, home)) {
    if (!fs.existsSync(full)) continue;
    if (!episodeHashMatches(full, root, sha256)) continue;
    return { full, root };
  }
  return null;
}

/**
 * Deterministic anchor extraction: for every episode whose own file exists
 * under the workspace OR the global knowledge root, scan its text for
 * repo-relative paths and keep the ones that resolve to real WORKSPACE files
 * — excluding the episode's own path so a doc doesn't anchor itself. A
 * global episode's evidence can still anchor a learning to product code (the
 * outer read tries both roots), but the anchor TARGETS extracted from its
 * text are always resolved against the workspace only: an anchor is a
 * pointer into the product repo an agent can go read, never into another
 * machine's `~/.copilot`, so scanning a global episode's text for workspace
 * files is still workspace-anchored, not two-rooted. Dedupe, sort, cap at 8
 * (module-private; only `renderLearning` writes the result).
 */
function extractAnchors({ workspace, copilotHome, episodes, home }) {
  const found = new Set();
  const root = path.resolve(workspace);
  // Containment guard (same root/startsWith idiom this module uses
  // elsewhere, e.g. verifyEpisodeKind) — workspace-only, deliberately: see
  // the doc comment above on why anchor TARGETS never cross into the global
  // root even when the episode itself does.
  const containsWorkspace = (rel) => {
    const full = path.resolve(root, rel);
    return full === root || full.startsWith(root + path.sep) ? full : null;
  };
  for (const e of episodes || []) {
    if (!e.path) continue;
    const hit = firstExistingEpisodeFile(workspace, copilotHome, e.path, home, e.sha256);
    if (!hit) continue;
    // Never follow a symlinked episode file — its target's content must
    // never be scanned for anchor text either. `root: hit.root` runs the
    // canonicalize-after-acquire containment verify against the matched root.
    const text = readFileNoFollow(hit.full, { root: hit.root });
    if (text === null) continue;
    const matches = text.match(ANCHOR_RE) || [];
    for (const m of matches) {
      if (m === e.path) continue;
      const mFull = containsWorkspace(m);
      if (!mFull || !fs.existsSync(mFull)) continue;
      found.add(m);
    }
  }
  return [...found].sort().slice(0, ANCHOR_CAP);
}

export function renderLearning({
  trigger,
  body,
  episodes,
  anchors = [],
  origin,
  status,
  source,
  supersededBy,
  mergedFrom,
  promotedTo,
  promotedToGolden,
  authority,
  why,
  applies,
  does_not_apply,
  shows,
  provenance,
  sourceBindings,
  applicabilityVersion,
}) {
  const lines = [
    '---',
    'schema: 1',
    `trigger: ${yamlQuote(trigger)}`,
    `status: ${status}`,
    `source: ${source}`,
    ...correctionLines({ authority, why, applies, does_not_apply, shows }),
    'episodes:',
    // Shared with store.mjs's serializeLearning (episodeLines) — a pathless
    // episode is dropped and a missing/unrecognized kind defaults to 'fix',
    // so a STRENGTHEN re-render of a store file carrying a pre-existing
    // malformed episode entry (a hand edit, or stale on-disk record) never
    // regresses to emitting a literal `path: undefined` / `kind: undefined`.
    ...episodeLines(episodes),
  ];
  if (anchors.length) {
    lines.push('anchors:');
    for (const a of anchors) lines.push(`  - ${a}`);
  } else {
    lines.push('anchors: []');
  }
  lines.push(...applicabilityLines({ applicability_version: applicabilityVersion, source_bindings: sourceBindings }));
  lines.push(`superseded_by: ${supersededBy || 'null'}`);
  lines.push(`last_confirmed: ${todayClamped()}`);
  if (mergedFrom?.length) lines.push(`merged_from: [${mergedFrom.join(', ')}]`);
  if (promotedTo) lines.push(`promoted_to: ${promotedTo}`);
  // Same field, same position, same optionality as serializeLearning
  // (store.mjs). Without it here, ANY re-render through this function silently
  // dropped the branch→golden tombstone — the STRENGTHEN path re-rendered a
  // promoted bucket entry back into an ACTIVE claim that shadowed the golden
  // claim it had become, was re-offered by `knowledge promote`, and stopped
  // matching `prune --merged`'s fullyPromoted() check.
  if (promotedToGolden) lines.push(`promoted_to_golden: ${promotedToGolden}`);
  lines.push(`origin: ${origin}`);
  // Git provenance (blueprint P1/P9) — same shared rendering serializeLearning
  // (store.mjs) uses, so a fresh write and a round-trip re-render emit
  // byte-identical provenance lines. Optional: absent fields render nothing.
  lines.push(...provenanceLines(provenance || {}));
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

// PRIMARY injection control — command CONTENT, matched by invocation SHAPE, not
// by dialect name or fence label. A curated learning is read verbatim into the
// orient pack a model acts on, so a body carrying an executable command is a
// prompt-injection surface no matter what fence (or none) wraps it. Applied to
// trigger+body of EVERY learning regardless of episode kind. Each pattern
// targets an invocation shape, never a prose mention — "use rm carefully",
// "never eval untrusted input", "the powershell script handles retries" do not
// match, but the executable forms do. This is the durable half: new fence
// labels can't route around a `| sh` or `curl … | bash` payload.
const COMMAND_CONTENT_PATTERNS = [
  [/\b(curl|wget)\s/i, 'download command (curl/wget)'],
  // Pipe INTO a shell interpreter — the classic `curl … | sh`. Negative
  // lookahead for a trailing `|` so a markdown table cell (`| sh |`) is not
  // mistaken for a pipeline; a real pipe-to-shell never has a following pipe.
  [/\|\s*(sh|bash|zsh|ksh|csh|dash|ash|pwsh|powershell)\b(?!\s*\|)/i, 'pipe-to-shell'],
  [/\bsudo\s/i, 'sudo invocation'],
  [/\brm\s+-[a-z]*[rf]/i, 'rm -rf / -f'],
  [/\bchmod\s+(\+[rwxa]+|[0-7]{3,4})\b/i, 'chmod +x / octal'],
  [/\b(bash|sh|zsh|ksh)\s+-c\b/i, 'shell -c invocation'],
  // Interpreter inline-exec shapes (P1#2b) — a language runtime handed code to
  // run on the command line (`node -e "process.exit(1)"`, `python -c ...`).
  // BEST-EFFORT defense-in-depth, never a completeness claim: each requires
  // the exec flag as invocation syntax, so a prose mention of "node"/"python"
  // never matches. `<interp> -e|--eval` for the JS runtimes; `<interp> -c|-e`
  // for the -c/-e family (python/perl/ruby/php).
  [/\b(?:node|deno|bun)\s+(?:--eval\b|-e\b)/i, 'node -e / --eval'],
  [/\b(?:python3?|perl|ruby|php)\s+-[ce]\b/i, 'interpreter -c/-e exec'],
  // cmd /c (and cmd.exe /c) — the Windows shell handed an inline command.
  [/\bcmd(?:\.exe)?\s+\/c\b/i, 'cmd /c invocation'],
  // eval as an INVOCATION (followed by a quote/paren/dollar/backtick), never
  // the bare word — so "never eval untrusted input" prose is not rejected.
  [/\beval\s*[("'`$]/i, 'eval invocation'],
  [/\b(iex|Invoke-Expression)\b/i, 'PowerShell Invoke-Expression'],
];

const SHELL_FENCE_PATTERN =
  /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(sh|bash|shell|zsh|fish|ksh|csh|dash|ash|sh-session|shell-session|shellsession|console|terminal|powershell|pwsh|ps|ps1|cmd|bat|batch|dos)\b/i;

function lintImperative({ body, trigger, episodes }) {
  const text = `${trigger}\n${body}`;
  for (const [re, label] of COMMAND_CONTENT_PATTERNS) {
    if (re.test(text)) return `executable command content (${label}) in learning`;
  }
  if (SHELL_FENCE_PATTERN.test(text)) return 'shell command fence in learning';
  // BARE-URL check stays insight-gated: a fix learning legitimately citing a
  // doc URL must not be rejected, but an insight-only claim has no verified
  // evidence — the advisory fence is a labeling choice, not the injection
  // control, so a bare URL in an insight-only learning stays disallowed here.
  const allInsight = episodes.length > 0 && episodes.every((e) => e.kind === 'insight');
  if (allInsight && /https?:\/\//i.test(text)) return 'bare URL in insight-only learning';
  return null;
}

// C0 control chars (0x00-0x1F) plus DEL (0x7F) — the same set `inertLine`
// (store.mjs) collapses at render time. Admission rejects them outright
// rather than silently sanitizing, so a rejected op gets a clear E_SCHEMA
// instead of the model discovering its trigger/plan was silently mangled.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Episode `plan` values feed promotion eligibility (consolidate.mjs's
 * verifiedAndPlans: a distinct-plans count) as pure assertions — nothing on
 * the read path verifies a `plan` points at a real plan file; it remains an
 * assertion feeding only human-gated displays (`ae learnings --why`,
 * `consolidate --status`), never an automated decision on its own (P1-1).
 * Still admitted with a shape check:
 * when present, must be a short, single-line, workspace-relative-LOOKING
 * string — never a vehicle for a control-char injection (inertLine's doc
 * comment covers the render-side half of that same defense) or a `..`
 * traversal segment that could mislead a human reading it later. Absent,
 * null, or empty is fine — `plan` is optional.
 */
function validPlanField(plan) {
  if (plan === undefined || plan === null || plan === '') return true;
  if (typeof plan !== 'string') return false;
  if (plan.length > 200) return false;
  if (CONTROL_CHAR_RE.test(plan)) return false;
  if (path.isAbsolute(plan)) return false;
  if (plan.split(/[\\/]+/).some((seg) => seg === '..')) return false;
  return true;
}

function validateEpisodes(episodes, opIndex) {
  if (!Array.isArray(episodes) || !episodes.length) {
    return fail('E_SCHEMA', `op ${opIndex}: episodes must be a non-empty array`);
  }
  // One link per episode. An op listing the SAME `path@sha256` more than once
  // is not two pieces of evidence — but every count downstream reads the
  // rendered `episodes:` block as a flat list, so a duplicate inflates
  // `verifiedFixLinks` (the protected/disputed-target threshold) and
  // `verifiedAndPlans` (promotion eligibility) from a single episode file.
  // Rejected at admission rather than silently deduped, so the op-set's author
  // learns its evidence was double-counted instead of the store quietly
  // disagreeing with the ops JSON.
  const seenEpisodeKeys = new Set();
  for (const e of episodes) {
    if (
      !e ||
      typeof e !== 'object' ||
      typeof e.path !== 'string' ||
      !e.path ||
      typeof e.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(e.sha256)
    ) {
      return fail('E_SCHEMA', `op ${opIndex}: each episode needs path + sha256`);
    }
    const key = `${e.path}@${e.sha256}`;
    if (seenEpisodeKeys.has(key)) {
      return fail('E_SCHEMA', `op ${opIndex}: episode ${e.path} is listed more than once — one link per episode`);
    }
    seenEpisodeKeys.add(key);
    if (!validPlanField(e.plan)) {
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: episode plan must be a short (<=200 char), single-line, workspace-relative path with no ".." segments`
      );
    }
  }
  return null;
}

function verifiedFixLinks(fm) {
  return (fm.episodes || []).filter((e) => e.kind === 'fix').length;
}

/**
 * Verify an asserted episode kind against disk. Used for: the SUPERSEDE
 * disputed-demotion exemption and `source`/`status` derivation on ADD/
 * SUPERSEDE writes (human-teaching assertions), and — closing the symmetric
 * gap — admission of every `fix`/`insight`-kind episode an ADD/STRENGTHEN/
 * SUPERSEDE/MERGE op offers, before its kind is ever trusted downstream by
 * `gainedFix` (composeStrengthenedLearning), `verifiedFixLinks`, or promotion math
 * (consolidate.mjs's verifiedAndPlans). In every case the op JSON's
 * `episodes[].kind` field is just an assertion (model- or human-authored
 * text nothing else validates) — trusting it lets anyone claim evidence for
 * a fix that was never actually verified, or human-teaching for an episode
 * never taught by a human. An episode verifies when: its path resolves
 * inside the workspace (no `../` escape), its file exists there, the file's
 * CURRENT content hashes to the asserted sha256 (not stale/edited since),
 * and the file's OWN frontmatter agrees with the asserted category:
 *   - `human-teaching` / `insight` assertions require the file's own
 *     frontmatter `kind` to literally match — an elevated-standing claim
 *     proves nothing on its own.
 *   - `fix` (or an omitted kind — the same default every serializer uses)
 *     only requires the file NOT to be impersonating one of the elevated
 *     kinds — no frontmatter, or any kind other than insight/human-teaching,
 *     is a legitimate fix episode.
 * Resolved against BOTH knowledge roots (resolveEpisodeFile) — workspace
 * first, then `copilotHome/knowledge` — since `collectEpisodes` proposes
 * candidates from either one and the consolidation skill copies the offered
 * path/sha256 verbatim; a global-root episode must verify exactly as
 * readily as a workspace one. Succeeds if EITHER root fully verifies (exists
 * + sha256 match + kind agreement). Fails closed (false) only when every
 * candidate fails — never throws.
 */
function verifyEpisodeKind(workspace, copilotHome, e, home) {
  if (!e || !e.path || !e.sha256) return false;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path, home)) {
    // Never follow a symlinked candidate — a symlink's target content must
    // never verify (or hash-match) as this episode's evidence. `root` runs the
    // canonicalize-after-acquire containment verify against the matched root.
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    if (crypto.createHash('sha256').update(text).digest('hex') !== e.sha256) continue;
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const kindLine = m ? m[1].split('\n').find((l) => /^kind:\s*/.test(l)) : null;
    const fileKind = kindLine ? kindLine.replace(/^kind:\s*/, '').replace(/^["']|["']$/g, '').trim() : null;
    const asserted = e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix';
    const kindOk = asserted === 'fix' ? fileKind !== 'insight' && fileKind !== 'human-teaching' : fileKind === asserted;
    if (kindOk) return true;
  }
  return false;
}

/** Thin wrapper over verifyEpisodeKind: true only when the episode BOTH
 * asserts AND disk-verifies human-teaching — every existing call site
 * (the SUPERSEDE re-teach exemption, source/status derivation) needs this
 * specific question answered, not "does this episode verify as whatever it
 * claims", so a non-human-teaching assertion still short-circuits to false
 * without touching disk. */
function verifyHumanTeachingEpisode(workspace, copilotHome, e, home) {
  return Boolean(e) && e.kind === 'human-teaching' && verifyEpisodeKind(workspace, copilotHome, e, home);
}

/**
 * Admission-time evidence check (op validation, before anything is written):
 * EVERY episode an op offers — `fix`-kind (or kind-omitted, defaulting to
 * fix), `insight`-kind, AND `human-teaching`-kind — must verify against disk
 * via verifyEpisodeKind (tried against both the workspace and, when given,
 * the global copilotHome knowledge root): contained path, file exists,
 * current content hashes to the asserted sha256, and the file's own
 * frontmatter kind agrees with the asserted kind. A mismatch or
 * nonexistent-in-either-root file is an evidence defect (content-failure
 * class, routed through rejectOp so it strikes toward quarantine like any
 * other malformed episode). Evidence EXISTENCE is deliberately universal:
 * `human-teaching` used to be exempt here (its disk check ran only where
 * elevated standing was granted, with a tolerant fallback), but that let a
 * fabricated human-teaching assertion — a nonexistent file, or a real
 * insight file relabeled — admit a learning that bypassed the insight-only
 * imperative lint and rendered without the advisory fence. The ONLY
 * human-teaching-specific bypass that survives is `humanPresent`'s
 * governance-RECENCY bypass (overridesGovernanceRecency): the live human
 * acting now outranks a stored decision's timestamp, but never the
 * requirement that cited evidence actually exists on disk. The legitimate
 * `remember` lane is unaffected — runInsightCompound writes the
 * human-teaching episode to disk BEFORE applyOps runs, so it verifies here
 * like any other genuine episode.
 */
function verifyAdmittedEpisodeKinds(workspace, copilotHome, episodes, opIndex, home) {
  for (const e of episodes) {
    if (!verifyEpisodeKind(workspace, copilotHome, e, home)) {
      const asserted = e.kind === 'insight' ? 'insight' : e.kind === 'human-teaching' ? 'human-teaching' : 'fix';
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: episode ${e.path} does not verify as kind ${asserted} — file missing, sha256 mismatch, or its own frontmatter kind disagrees`
      );
    }
  }
  return null;
}

/**
 * Disk-verify an episode by EXISTENCE + sha256 only, ignoring kind — the
 * NOOP admission check (P1#3). A NOOP writes no learning, so an asserted kind
 * is moot, but it still CONSUMES the episode (a `learning: null` ledger entry
 * that clears the episode's consolidation debt), so it must never be able to
 * clear debt for a fabricated or mislabeled file. Tried against both
 * knowledge roots (resolveEpisodeFile) and never follows a symlinked
 * candidate — true only when some contained candidate exists and its CURRENT
 * content hashes to the asserted sha256. Fails closed (false); never throws.
 */
function episodeShaVerifies(workspace, copilotHome, e, home) {
  if (!e || !e.path || !e.sha256) return false;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path, home)) {
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    if (crypto.createHash('sha256').update(text).digest('hex') === e.sha256) return true;
  }
  return false;
}

function verifyNoopEpisodes(workspace, copilotHome, episodes, opIndex, home) {
  for (const e of episodes) {
    if (!episodeShaVerifies(workspace, copilotHome, e, home)) {
      return fail(
        'E_SCHEMA',
        `op ${opIndex}: NOOP episode ${e.path} does not exist on disk or its sha256 does not match — cannot clear debt for a fabricated or edited episode`
      );
    }
  }
  return null;
}

/**
 * The `date` recorded in an episode's OWN frontmatter — read the same way
 * `collectEpisodes` (consolidate.mjs) derives it (`fm.date`), from the
 * episode file's CURRENT on-disk content, never from anything the op JSON
 * asserts (an op's episode entries carry no date field of their own). Used
 * only by the recency gate below. Same two-root resolution and fail-closed
 * shape as verifyEpisodeKind (null when every candidate — workspace then
 * copilotHome/knowledge — is escaping/missing/unreadable/unparsable) — a
 * shared reader isn't worth factoring out for two short, independently-
 * failing checks.
 */
function episodeDate(workspace, copilotHome, e, home) {
  if (!e.path) return null;
  for (const { full, root } of resolveEpisodeFile(workspace, copilotHome, e.path, home)) {
    // Never follow a symlinked candidate here either — same reasoning as
    // verifyEpisodeKind above; `root` runs the containment verify.
    const text = readFileNoFollow(full, { root });
    if (text === null) continue;
    if (e.sha256 && crypto.createHash('sha256').update(text).digest('hex') !== e.sha256) continue;
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const dateLine = m[1].split('\n').find((l) => /^date:\s*/.test(l));
    const date = dateLine ? dateLine.replace(/^date:\s*/, '').replace(/^["']|["']$/g, '').trim() : null;
    if (date) return date;
  }
  return null;
}

/**
 * Recency gate on the human re-teach override (design correction, M4 whole-
 * milestone review, item 1; tightened again, P1-9): verifying an episode is
 * human-teaching proves AUTHENTICITY, never RECENCY — without this, a STALE
 * human-teaching episode (e.g. a `remember` from before a LATER
 * `learning retire`/`dispute`/`promote`) could resurrect a newer human
 * governance decision on the same id, including fabricating a `confirm`
 * record that makes it look like the human re-affirmed something they never
 * saw. Applied ONLY when a governance record exists for the id — nothing
 * stale to guard against otherwise, so an id with no standing decision is
 * unaffected.
 *
 * Two lanes, deliberately different:
 *   - LIVE human lane (`humanPresent: true`, set only by `runRemember` —
 *     remember.mjs): bypasses this gate ENTIRELY, same trust plane as
 *     `approve`. The human acting right now IS the authority; there is
 *     nothing to prove recent against — they are the live source of the
 *     decision. This does NOT touch the promoted-target block, which stays
 *     absolute regardless (checked unconditionally, before any reteach logic
 *     ever runs).
 *   - MODEL lane (an unattended `consolidate --apply` — a model copying a
 *     candidates-packet episode verbatim, or a human running the CLI
 *     directly against an ops JSON): episode `date` is day-granular
 *     (YYYY-MM-DD, an episode file's own frontmatter), but a governance
 *     record's `at` is now a full ISO-8601 timestamp (see
 *     lifecycle.mjs/apply.mjs/admin.mjs's appendGovernance call sites) — a
 *     day-granular episode can prove it happened on a LATER calendar day
 *     than the record, but can never prove it happened later WITHIN the same
 *     day the record was written (readGovernance also tolerates a legacy
 *     plain-date `at`, in which case the same day-string comparison still
 *     applies). So the model lane requires the episode's day to be STRICTLY
 *     newer than the record's day: `episode day > record day` passes,
 *     `episode day === record day` now FAILS (previously a same-day tie
 *     favored the override — that same-day allowance is what let a
 *     same-day, unattended re-application of stale-but-authentic evidence
 *     silently overturn a same-day veto). An episode with no parseable date
 *     fails closed either way — never counts as recent enough to override a
 *     recorded human decision.
 */
function overridesGovernanceRecency(workspace, copilotHome, episodes, record, { humanPresent = false, home } = {}) {
  if (humanPresent) return true;
  if (!record) return true;
  const recordAt = String(record.at ?? '');
  // Fail CLOSED on a malformed/missing/empty timestamp (minor #5,
  // adversarial review): governance.jsonl is a plain file outside applyOps'
  // own write path (see the promote-target reapplication's own re-validation
  // above for the same reasoning) — a corrupted or hand-poisoned entry with
  // `at: ''` (or any value that isn't a recognizable date) must never let the
  // override fire. Without this, `d > recordDay` for an empty recordDay is
  // true for virtually ANY real episode date (an empty string is a lexical
  // prefix of, and therefore "less than", almost every non-empty string) —
  // silently failing OPEN and letting stale evidence override a standing
  // decision the record was supposed to protect. The veto holds instead.
  if (!/^\d{4}-\d{2}-\d{2}/.test(recordAt)) return false;
  const recordDay = recordAt.slice(0, 10);
  return episodes.every((e) => {
    const d = episodeDate(workspace, copilotHome, e, home);
    return d != null && d > recordDay;
  });
}

export function applyOps({
  workspace,
  opsPath,
  operations,
  operationReceipt,
  operationRecovery = false,
  packetPreflight,
  dryRun = false,
  home,
  approve = false,
  log = () => {},
  copilotHome = null,
  // Internal only — set by runRemember (remember.mjs) for the LIVE human
  // lane. Never derived from anything in the ops JSON itself: a model can
  // never grant this to itself by asserting a field.
  humanPresent = false,
  // `--layer golden` override (blueprint P4): explicit, logged, and HUMAN-
  // GATED (see the admission check below). Routing is otherwise always
  // derived from write-time git context, never from a flag.
  layer = null,
}) {
  // Kill switch: consolidate is a write path gated to mode 'on' — checked
  // first, before the ops file is even parsed, and before any lock. This is a
  // cheap, no-lock pre-check (unchanged from before); the real (non-dryRun)
  // mutation path below ALSO re-checks mode fresh, under the lock, closing
  // the window where mode could change between this check and lock
  // acquisition. 'suggest' is a conditional exception: it only proceeds when
  // the caller passes approve (set by a human re-running with --yes after
  // reviewing the ops JSON) — every other non-'on' mode rejects regardless of
  // approve.
  const { mode } = readStoreConfig(workspace, { home });
  if (mode !== 'on' && !(mode === 'suggest' && approve)) {
    const reason =
      mode === 'suggest'
        ? 'knowledge mode is suggest — review the ops JSON, then re-run apply with --yes'
        : `knowledge mode is ${mode} — run: ae knowledge on`;
    return {
      applied: [],
      governed: [],
      rejected: [{ code: 'E_MODE', reason }],
      committed: false,
      exitCode: 2,
    };
  }

  // LAYER CONTAINMENT (P2 security finding). "Promotion is the only branch →
  // golden route" is a containment claim, so the one flag that bypasses
  // write-time routing has to sit on the SAME trust plane as every other
  // human-authority path in this module: a live human (`humanPresent`, set
  // only by runRemember) or an explicit human approval (`approve`, set only
  // by `--yes` after a person reviewed the ops JSON). Without this, `--layer
    if (layer === 'branch') {
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_LAYER', '--layer branch is not an override — branch routing is derived from write-time git context')],
      committed: false,
      exitCode: 2,
    };
  }
  if (layer === 'golden' && !humanPresent && !approve) {
    return {
      applied: [],
      governed: [],
      rejected: [
        fail(
          'E_LAYER',
          '--layer golden is a human-authority override — review the ops JSON and re-run with --yes, or promote the branch bucket: ae knowledge promote'
        ),
      ],
      committed: false,
      exitCode: 2,
    };
  }

  let parsed;
  try {
    parsed = operations || JSON.parse(readFileNoFollow(opsPath, { maxBytes: 1024 * 1024 }));
  } catch (err) {
    return { applied: [], governed: [], rejected: [fail('E_SCHEMA', `unreadable ops file: ${err.message}`)], committed: false, exitCode: 1 };
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.ops)) {
    return { applied: [], governed: [], rejected: [fail('E_SCHEMA', 'ops file must be { schema: 1, ops: [...] }')], committed: false, exitCode: 1 };
  }

    const promotion =
    parsed.promotion && typeof parsed.promotion === 'object' && !Array.isArray(parsed.promotion) ? parsed.promotion : null;
  const promotionMode = Boolean(promotion);
  if (promotionMode) {
    if (!isSafeBucketKey(promotion.branchKey)) {
      return {
        applied: [],
        governed: [],
        rejected: [fail('E_SCHEMA', 'promotion envelope needs a plain branchKey — a bucket directory name, never a path')],
        committed: false,
        exitCode: 1,
      };
    }
    if (isDetachedKey(promotion.branchKey)) {
      return {
        applied: [],
        governed: [],
        rejected: [
          fail('E_SCHEMA', `promotion source ${promotion.branchKey} is a detached-HEAD bucket — never promotable (derived from the key shape)`),
        ],
        committed: false,
        exitCode: 1,
      };
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify(parsed.ops)).digest('hex');
    if (digest !== promotion.digest) {
      return {
        applied: [],
        governed: [],
        rejected: [fail('E_SCHEMA', 'promotion op-set digest mismatch — regenerate with: ae knowledge promote')],
        committed: false,
        exitCode: 1,
      };
    }
  }
    for (let i = 0; i < parsed.ops.length; i++) {
    const op = parsed.ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      return { applied: [], governed: [], rejected: [fail('E_SCHEMA', `op ${i}: op must be an object`)], committed: false, exitCode: 1 };
    }
  }

  const fileTouchCount = parsed.ops.reduce((n, o) => n + opWeight(o), 0);
  if (fileTouchCount > MAX_OPS_PER_RUN) {
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_DELTA_CONTRACT', `run touches ${fileTouchCount} files — max ${MAX_OPS_PER_RUN} (anti-collapse contract)`)],
      committed: false,
      exitCode: 1,
    };
  }

  const origin = repoId(workspace);

    let routing = null;
  let writeProvenance = null;
  function deriveRouting() {
    routing = resolveWriteLayer({ workspace, home, layerOverride: layer === 'golden' ? 'golden' : null, log });
    writeProvenance = { commit: routing.context.headSha, branch: routing.context.branch, base: routing.context.baseSha };
  }

  function assertHeadUnmoved() {
    const now = deriveGitContext({ workspace, home });
    const before = routing.context;
    if (now.headSha === before.headSha && now.branch === before.branch && now.detached === before.detached) return null;
    const nameOf = (c) => c.branch || (c.detached ? `detached ${String(c.headSha).slice(0, 12)}` : c.headSha || 'unknown');
    return {
      kind: 'reject',
      applied: [],
      governed: [],
      rejected: [
        fail(
          'E_HEAD_MOVED',
          `workspace HEAD moved mid-transaction (${nameOf(before)} → ${nameOf(now)}) — nothing was written; re-run the apply from a settled checkout`
        ),
      ],
      committed: false,
      exitCode: 1,
    };
  }

  function runOnce({ dir, git, recordCheckpoint = () => {}, rollbackToCheckpoint = () => false, rollbackUncommitted = () => false }) {
    if (operationReceipt) {
      const file = path.join(dir, 'operations', `${operationReceipt.id}.json`);
      const text = readStoreFile(file);
      if (text !== null) {
        let receipt;
        try { receipt = JSON.parse(text); } catch { return { kind: 'reject', applied: [], governed: [], rejected: [fail('E_OPERATION', 'Unreadable operation receipt')], exitCode: 1 }; }
        if (receipt.digest !== operationReceipt.digest || receipt.resultHash !== crypto.createHash('sha256').update(JSON.stringify(receipt.result)).digest('hex')) return { kind: 'reject', applied: [], governed: [], rejected: [fail('E_OPERATION', 'Operation identity conflicts with a different payload or damaged result')], exitCode: 1 };
        return { ...receipt.result, replayed: true };
      }
      if (fs.existsSync(file)) return { kind: 'reject', applied: [], governed: [], rejected: [fail('E_OPERATION', 'Operation receipt cannot be read safely')], exitCode: 1 };
    }
    if (operationRecovery) return { kind: 'reject', applied: [], governed: [], rejected: [fail('E_RETRY', 'Repair history and committed receipt are missing')], exitCode: 1 };
    const packetFailure = packetPreflight?.({ storeDir: dir, layer: routing.layer, bucketKey: routing.bucketKey });
    if (packetFailure) return { kind: 'reject', applied: [], governed: [], rejected: [packetFailure], exitCode: 1 };
    if (!dryRun) {
      const movedEarly = assertHeadUnmoved();
      if (movedEarly) return movedEarly;
    }
    let layerRoot = dir;
    if (promotionMode) {
      layerRoot = dir;
    } else if (routing.layer === 'branch' && routing.bucketKey) {
      if (dryRun) {
        layerRoot = bucketDirFor(dir, routing.bucketKey);
      } else {
        migrateRenamedBucket(dir, { workspace, context: routing.context });
        layerRoot = ensureBucket(dir, {
          key: routing.bucketKey,
          branch: routing.context.branch,
          baseSha: routing.context.baseSha,
        });
      }
    }
    const existing = new Map(listLearnings(layerRoot).map((l) => [l.id, l]));

    const promotionSources = promotionMode
      ? new Map(listLearnings(bucketDirFor(dir, promotion.branchKey)).map((l) => [l.id, l]))
      : null;
    if (promotionMode) {
      const promotionBucketDir = bucketDirFor(dir, promotion.branchKey);
      if (bucketAncestryOk(workspace, readBucketMeta(promotionBucketDir)) === false) {
        return {
          kind: 'reject',
          applied: [],
          governed: [],
          rejected: [
            fail(
              'E_SCHEMA',
              `promotion source bucket ${promotion.branchKey} has unrelated history — its recorded base is not an ancestor of HEAD (branch-name reuse); prune it instead: ae knowledge prune --branch ${promotion.branchKey}`
            ),
          ],
          committed: false,
          exitCode: 1,
        };
      }
    }

    function recordContentFailure(code, episodes) {
      if (dryRun || !git || promotionMode || !CONTENT_FAILURE_CODES.has(code)) return null;
      const seenKeys = new Set();
      const eps = (episodes || [])
        .filter((e) => e && e.path && /^[0-9a-f]{64}$/.test(e.sha256 || ''))
        .filter((e) => {
          const key = `${e.path}@${e.sha256}`;
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
      if (!eps.length) return null;
      let unrecoverable = null;
      try {
        const ledger = readLedger(dir);
        const at = todayClamped();
        const entries = [];
        for (const e of eps) {
          const priorFailures = ledger.filter((le) => le.failure && le.path === e.path && le.sha256 === e.sha256).length;
          entries.push({ path: e.path, sha256: e.sha256, failure: code, at });
          if (priorFailures + 1 >= QUARANTINE_THRESHOLD) {
            entries.push({ path: e.path, sha256: e.sha256, quarantined: true, learning: null, at });
          }
        }
        appendLedger(dir, entries);
        const commitRes = commitStore(dir, `consolidate: record failure ${code}`);
        if (!commitRes.ok) {
          if (!rollbackUncommitted()) {
            unrecoverable = `strike recording failed to commit (${commitRes.stderr || 'git commit failed'}) and could not be rolled back`;
          }
          return `strike recording failed to commit: ${commitRes.stderr || 'git commit failed'}`;
        }
        recordCheckpoint();
      } catch (err) {
        if (err instanceof StoreTransactionAbort) throw err;
      } finally {
        if (unrecoverable) throw new Error(unrecoverable);
      }
      return null;
    }

    function rejectOp(code, reason, episodes) {
      const strikeNote = recordContentFailure(code, episodes);
      return {
        kind: 'reject',
        applied: [],
        governed: [],
        rejected: [fail(code, strikeNote ? `${reason} (${strikeNote})` : reason)],
        committed: false,
        exitCode: 1,
      };
    }

    const domainProjection = new Map();
    function projectedActive(domain) {
      if (!domainProjection.has(domain)) {
        domainProjection.set(domain, activeCountInDomain(existing, domain));
      }
      return domainProjection.get(domain);
    }
    function bumpProjectedActive(domain, delta) {
      domainProjection.set(domain, projectedActive(domain) + delta);
    }

    const consumedTargets = new Set(); // SUPERSEDE/MERGE targets already spoken for this run
    const strengthenedTargets = new Set();
    const plannedIds = new Set(); // new ids (ADD/SUPERSEDE-rename/MERGE) already claimed this run
    function idTaken(id) {
      return existing.has(id) || plannedIds.has(id);
    }

    const governance = readGovernance(dir);

    const candidateKeys = new Set();
    {
      const onDisk = collectEpisodes({ workspace, copilotHome, home });
      const { consumed } = splitLedger(readLedger(dir));
      if (layerRoot !== dir) {
        for (const key of splitLedger(readLedger(layerRoot)).consumed) consumed.add(key);
      }
      const eligibility = {
        layer: routing.layer,
        currentBranch: routing.context?.branch || null,
        defaultBranchName: routing.defaultBranch?.name || null,
        storeHasBuckets: storeHasBuckets(dir),
      };
      for (const e of onDisk) {
        if (!episodeEligibleForLayer(e.branch, eligibility)) continue;
        const key = `${e.path}@${e.sha256}`;
        if (!consumed.has(key)) candidateKeys.add(key);
      }
    }
    function episodesNeedingCandidacy(op) {
      if (op.op === 'ADD') return op.episodes || [];
      const exempt = new Set();
      const targets = op.op === 'MERGE' ? op.targets || [] : op.target ? [op.target] : [];
      for (const t of targets) {
        const l = existing.get(t);
        if (l) for (const e of l.fm.episodes || []) exempt.add(`${e.path}@${e.sha256}`);
      }
      return (op.episodes || []).filter((e) => !exempt.has(`${e.path}@${e.sha256}`));
    }
    function assertCandidacy(op, opIndex) {
      for (const e of episodesNeedingCandidacy(op)) {
        if (!candidateKeys.has(`${e.path}@${e.sha256}`)) {
          return fail(
            'E_SCHEMA',
            `op ${opIndex}: episode ${e.path} is not a current unconsolidated candidate — already consolidated or absent`
          );
        }
      }
      return null;
    }

    // Validate every op before writing anything — all-or-nothing runs.
    const planned = [];
    const disputes = [];
    for (let i = 0; i < parsed.ops.length; i++) {
      let op = parsed.ops[i];
      if (promotionMode && !PROMOTION_OP_KINDS.has(op.op)) {
        return {
          kind: 'reject',
          applied: [],
          governed: [],
          rejected: [fail('E_SCHEMA', `op ${i}: a promotion op-set carries only ADD/STRENGTHEN/SUPERSEDE ops, never ${op.op}`)],
          committed: false,
          exitCode: 1,
        };
      }
      if (op.op === 'NOOP') {
        const bad = validateEpisodes(op.episodes, i);
        if (bad) return rejectOp(bad.code, bad.reason, op.episodes);
        const badNoop = verifyNoopEpisodes(workspace, copilotHome, op.episodes, i, home);
        if (badNoop) return rejectOp(badNoop.code, badNoop.reason, op.episodes);
        planned.push({ ...op });
        continue;
      }
      if (!FILE_TOUCHING.has(op.op)) {
        return rejectOp('E_SCHEMA', `op ${i}: unknown op ${op.op}`, op.episodes);
      }
      const bad = validateEpisodes(op.episodes, i);
      if (bad) return rejectOp(bad.code, bad.reason, op.episodes);
      let promotedEpisodes = null;
      if (promotionMode) {
        const src = op.source && typeof op.source === 'object' ? op.source : null;
        const sourceLearning = src && typeof src.id === 'string' ? promotionSources.get(src.id) : null;
        if (!sourceLearning) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_SCHEMA', `op ${i}: promotion source ${src?.id || '(none)'} not found in bucket ${promotion.branchKey}`)],
            committed: false,
            exitCode: 1,
          };
        }
        if (!isActiveFm(sourceLearning.fm)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_SCHEMA',
                `op ${i}: promotion source ${src.id} is not an active, unpromoted bucket learning — only active branch claims promote`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        const sourceText = readLearningFile(sourceLearning.file);
        if (sourceText === null) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_SCHEMA', `op ${i}: promotion source ${src.id} could not be read safely from the store`)],
            committed: false,
            exitCode: 1,
          };
        }
        const currentSha = crypto.createHash('sha256').update(sourceText).digest('hex');
        if (currentSha !== src.sha256) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_SCHEMA', `op ${i}: promotion source ${src.id} changed since the op-set was emitted — regenerate with: ae knowledge promote`)],
            committed: false,
            exitCode: 1,
          };
        }
        const destId = op.op === 'STRENGTHEN' ? op.target : newIdFor(op);
        if (destId !== src.id) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_SCHEMA',
                `op ${i}: promotion destination ${destId || '(none)'} does not match source ${src.id} — promotion moves a claim between layers, it never renames or re-authors it`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        const namedTargets = [
          ...(op.target !== undefined ? [op.target] : []),
          ...(Array.isArray(op.targets) ? op.targets : []),
        ];
        for (const t of namedTargets) {
          if (t !== src.id) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail(
                  'E_SCHEMA',
                  `op ${i}: promotion target ${t || '(none)'} does not match source ${src.id} — a promotion moves one claim between layers, it never touches another`
                ),
              ],
              committed: false,
              exitCode: 1,
            };
          }
        }
        if (op.op !== 'STRENGTHEN') {
          op = { ...op, trigger: sourceLearning.fm.trigger || '', body: sourceLearning.body };
        }
        const recorded = new Map();
        for (const e of sourceLearning.fm.episodes || []) {
          if (e.path) recorded.set(`${e.path}@${e.sha256}`, e);
        }
        promotedEpisodes = [];
        for (const e of op.episodes) {
          const recordedEpisode = recorded.get(`${e.path}@${e.sha256}`);
          if (!recordedEpisode) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail('E_SCHEMA', `op ${i}: episode ${e.path} was never recorded on the branch-applied source ${src.id} — promotion evidence re-validates from recorded hashes only`),
              ],
              committed: false,
              exitCode: 1,
            };
          }
          promotedEpisodes.push({
            path: recordedEpisode.path,
            sha256: recordedEpisode.sha256,
            kind: recordedEpisode.kind,
            plan: recordedEpisode.plan || null,
          });
        }
      } else {
        const badKind = verifyAdmittedEpisodeKinds(workspace, copilotHome, op.episodes, i, home);
        if (badKind) return rejectOp(badKind.code, badKind.reason, op.episodes);
        const notCandidate = assertCandidacy(op, i);
        if (notCandidate) return rejectOp(notCandidate.code, notCandidate.reason, op.episodes);
      }
      if (op.merged_from !== undefined) {
        return rejectOp(
          'E_SCHEMA',
          `op ${i}: merged_from is derived from a MERGE's own targets and cannot be asserted by an op`,
          op.episodes
        );
      }

      let isReteachShape = false;
      let allHumanTeaching = false;

      if (op.op === 'STRENGTHEN' || op.op === 'SUPERSEDE') {
        if (!op.target || !existing.has(op.target)) {
          return rejectOp('E_TARGET', `op ${i}: target ${op.target || '(none)'} does not exist`, op.episodes);
        }
        const promotedTo = existing.get(op.target).fm.promoted_to;
        if (promotedTo) {
          return promotedTargetRejection(i, op.target, promotedTo);
        }
        isReteachShape = op.op === 'SUPERSEDE' && newIdFor(op) === op.target;
        allHumanTeaching =
          isReteachShape &&
          op.episodes.length > 0 &&
          op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e, home)) &&
                    overridesGovernanceRecency(workspace, copilotHome, op.episodes, governance.get(op.target), { humanPresent, home });
                if (!allHumanTeaching && !isActiveFm(existing.get(op.target).fm)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail(
                'E_TARGET',
                op.op === 'SUPERSEDE'
                  ? `op ${i}: target ${op.target} is not active — SUPERSEDE an active learning or choose a new slug`
                  : `op ${i}: target ${op.target} is not active — STRENGTHEN requires an active target`
              ),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        if (consumedTargets.has(op.target)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_TARGET', `op ${i}: target ${op.target} already consumed by an earlier op in this run`)],
            committed: false,
            exitCode: 1,
          };
        }
        if (op.op === 'SUPERSEDE' && strengthenedTargets.has(op.target)) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail('E_TARGET', `op ${i}: target ${op.target} already strengthened by an earlier op in this run — combine into one op`),
            ],
            committed: false,
            exitCode: 1,
          };
        }
      }

      if (op.op === 'STRENGTHEN') {
        strengthenedTargets.add(op.target);
      }

      if (op.op === 'MERGE') {
        if (!Array.isArray(op.targets) || op.targets.length < 2) {
          return rejectOp('E_SCHEMA', `op ${i}: MERGE needs targets (>= 2 existing active learning ids)`, op.episodes);
        }
        for (const t of op.targets) {
          if (!existing.has(t)) {
            return rejectOp('E_TARGET', `op ${i}: target ${t} does not exist`, op.episodes);
          }
        }
        for (const t of op.targets) {
          const promotedTo = existing.get(t).fm.promoted_to;
          if (promotedTo) {
            return promotedTargetRejection(i, t, promotedTo);
          }
        }
        for (const t of op.targets) {
          if (consumedTargets.has(t)) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [fail('E_TARGET', `op ${i}: target ${t} already consumed by an earlier op in this run`)],
              committed: false,
              exitCode: 1,
            };
          }
          if (strengthenedTargets.has(t)) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail('E_TARGET', `op ${i}: target ${t} already strengthened by an earlier op in this run — combine into one op`),
              ],
              committed: false,
              exitCode: 1,
            };
          }
        }
        for (const t of op.targets) {
          if (!isActiveFm(existing.get(t).fm)) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [fail('E_TARGET', `op ${i}: target ${t} is not active (already superseded/retired/disputed)`)],
              committed: false,
              exitCode: 1,
            };
          }
        }
      }

      if (op.op === 'ADD' || op.op === 'SUPERSEDE' || op.op === 'MERGE') {
        if (
          typeof op.domain !== 'string' || !op.domain ||
          typeof op.slug !== 'string' || !op.slug ||
          typeof op.trigger !== 'string' || !op.trigger ||
          typeof op.body !== 'string' || !op.body
        ) {
          return rejectOp('E_SCHEMA', `op ${i}: ${op.op} needs domain, slug, trigger, body as non-empty strings`, op.episodes);
        }
        if (CONTROL_CHAR_RE.test(op.trigger)) {
          return rejectOp('E_SCHEMA', `op ${i}: trigger must not contain control characters (newlines, tabs, etc.)`, op.episodes);
        }
        const newId = newIdFor(op);
        if (op.op === 'ADD') {
          if (idTaken(newId)) {
            if (existing.has(newId)) {
              // Real on-disk dedup miss — a content-failure strike is warranted.
              return rejectOp(
                'E_EXISTS',
                `op ${i}: ${newId} already exists — use STRENGTHEN (more evidence) or SUPERSEDE (replace the claim)`,
                op.episodes
              );
            }
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
              committed: false,
              exitCode: 1,
            };
          }
          const domain = normalizeSlug(op.domain);
          if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
              ],
              committed: false,
              exitCode: 1,
            };
          }
          bumpProjectedActive(domain, 1);
          plannedIds.add(newId);
        }
        if (op.op === 'MERGE' && idTaken(newId)) {
          if (existing.has(newId)) {
            // Real on-disk dedup miss — a content-failure strike is warranted.
            return rejectOp(
              'E_EXISTS',
              `op ${i}: ${newId} already exists — merging onto an existing id is not supported, SUPERSEDE it as a target instead`,
              op.episodes
            );
          }
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
            committed: false,
            exitCode: 1,
          };
        }
        const secrets = scanSecretsFolded(`${op.trigger}\n${op.body}\n${op.why || ''}\n${op.applies || ''}\n${op.does_not_apply || ''}\n${op.shows || ''}`);
        if (secrets.length) {
          return rejectOp('E_SECRET', `op ${i}: secret-shaped content (${secrets.map((s) => s.id).join(', ')})`, op.episodes);
        }
        const lint = lintImperative(op);
        if (lint) {
          return rejectOp('E_LINT', `op ${i}: ${lint}`, op.episodes);
        }
      }

      if (op.op === 'MERGE') {
        const disputedTargets = op.targets.filter((t) => isDisputedTargetFm(existing.get(t).fm));
        if (disputedTargets.length) {
          for (const t of disputedTargets) disputes.push({ index: i, target: t });
          continue;
        }

        for (const t of op.targets) {
          bumpProjectedActive(existing.get(t).domain, -1);
        }
        const domain = normalizeSlug(op.domain);
        if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [
              fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
            ],
            committed: false,
            exitCode: 1,
          };
        }
        bumpProjectedActive(domain, 1);
        plannedIds.add(newIdFor(op));
        for (const t of op.targets) consumedTargets.add(t);
      }

      if (op.op === 'SUPERSEDE') {
        const target = existing.get(op.target);
        const newId = newIdFor(op);

        if (newId !== op.target && idTaken(newId)) {
          if (existing.has(newId)) {
            // Real on-disk dedup miss — a content-failure strike is warranted.
            return rejectOp(
              'E_EXISTS',
              `op ${i}: ${newId} already exists — choose a different slug or SUPERSEDE it directly instead of ${op.target}`,
              op.episodes
            );
          }
          return {
            kind: 'reject',
            applied: [],
            governed: [],
            rejected: [fail('E_EXISTS', `op ${i}: ${newId} was already introduced by an earlier op in this run`)],
            committed: false,
            exitCode: 1,
          };
        }

        if (!allHumanTeaching && isDisputedTargetFm(target.fm)) {
          disputes.push({ index: i, target: op.target });
          continue;
        }

        if (newId !== op.target) {
          bumpProjectedActive(target.domain, -1);
          const domain = normalizeSlug(op.domain);
          if (projectedActive(domain) >= DOMAIN_ACTIVE_CAP) {
            return {
              kind: 'reject',
              applied: [],
              governed: [],
              rejected: [
                fail('E_DOMAIN_CAP', `domain ${domain} at cap (${DOMAIN_ACTIVE_CAP} active) — MERGE existing learnings or retire first`),
              ],
              committed: false,
              exitCode: 1,
            };
          }
          bumpProjectedActive(domain, 1);
          plannedIds.add(newId);
        }
        consumedTargets.add(op.target);
      }
      if (op.op === 'STRENGTHEN') {
        const scopeSecrets = scanSecretsFolded(`${op.why || ''}\n${op.applies || ''}\n${op.does_not_apply || ''}\n${op.shows || ''}`);
        if (scopeSecrets.length) {
          return rejectOp(
            'E_SECRET',
            `op ${i}: secret-shaped content (${scopeSecrets.map((s) => s.id).join(', ')})`,
            op.episodes
          );
        }
      }
      const admittedEpisodes = promotedEpisodes || op.episodes || [];
      const teachingAuthority = op.authority === 'instruction' || op.authority === 'correction';
      const humanTeaching =
        admittedEpisodes.length > 0 &&
        admittedEpisodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e, home));
      if (teachingAuthority && !humanTeaching) {
        return {
          kind: 'reject',
          applied: [],
          governed: [],
          rejected: [fail('E_AUTHORITY', `op ${i}: ${op.authority} requires human-teaching episodes`)],
          committed: false,
          exitCode: 1,
        };
      }
      planned.push({ ...op, ...(promotedEpisodes ? { episodes: promotedEpisodes } : {}), index: i });
    }

    // Compose ADD/SUPERSEDE/MERGE files and enforce the byte cap before writing.
    const writes = [];
    for (const op of planned) {
      if (op.op !== 'ADD' && op.op !== 'SUPERSEDE' && op.op !== 'MERGE') continue;
      const domain = normalizeSlug(op.domain);
      const slug = normalizeSlug(op.slug);
      const id = `${domain}/${slug}`;
      let source = op.episodes.length && op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e, home)) ? 'human' : 'auto';
      let status = source === 'human' ? 'active' : 'provisional';
      let provenance = writeProvenance;
      let scope = op;
      if (promotionMode) {
        const src = promotionSources.get(op.source.id);
        source = src.fm.source || 'auto';
        status = isActiveFm(src.fm) && src.fm.status === 'active' ? 'active' : src.fm.status || 'provisional';
        provenance = { commit: src.fm.commit, branch: src.fm.branch, base: src.fm.base };
        scope = src.fm;
      } else {
        status = statusForAuthority(op.authority, status);
      }
      const anchors = promotionMode ? scope.anchors || [] : extractAnchors({ workspace, copilotHome, episodes: op.episodes, home });
      const content = renderLearning({
        trigger: op.trigger,
        body: op.body,
        episodes: op.episodes,
        anchors,
        sourceBindings: promotionMode ? scope.source_bindings : anchors.length ? captureSourceBindings({ workspace, paths: anchors }) : undefined,
        applicabilityVersion: promotionMode ? scope.applicability_version : anchors.length ? APPLICABILITY_VERSION : undefined,
        origin,
        status,
        source,
        supersededBy: null,
                mergedFrom: op.op === 'MERGE' ? op.targets : null,
        authority: scope.authority,
        why: scope.why,
        applies: scope.applies,
        does_not_apply: scope.does_not_apply,
        shows: scope.shows,
        provenance,
      });
      if (Buffer.byteLength(content, 'utf8') - provenanceBytes(provenance) - applicabilityBytes(parseLearningFrontmatter(content).fm) > LEARNING_BYTE_CAP) {
        return rejectOp('E_BYTE_CAP', `${id} exceeds ${LEARNING_BYTE_CAP} bytes — split into two claims`, op.episodes);
      }
      writes.push({ op, id, domain, slug, content });
    }

    const strengthenWrites = [];
    for (const op of planned) {
      if (op.op !== 'STRENGTHEN') continue;
      const target = existing.get(op.target);
      const content = composeStrengthenedLearning(target, op, workspace, copilotHome, home);
      if (content === null) {
        return rejectOp('E_TARGET', `op ${op.target}: learning file could not be read safely from the store`, op.episodes);
      }
      if (Buffer.byteLength(content, 'utf8') - provenanceBytes(target.fm) - applicabilityBytes(parseLearningFrontmatter(content).fm) > LEARNING_BYTE_CAP) {
        return rejectOp(
          'E_BYTE_CAP',
          `${op.target} exceeds ${LEARNING_BYTE_CAP} bytes after strengthening — split into two claims or supersede`,
          op.episodes
        );
      }
      strengthenWrites.push({ op, target, content });
    }

    if (dryRun) {
      return {
        kind: 'preview',
        applied: planned.map((o) => ({ op: o.op, id: o.target || (o.domain && `${normalizeSlug(o.domain)}/${normalizeSlug(o.slug)}`) || null })),
        rejected: disputes.map((d) => ({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target })),
                governed: [],
      };
    }

    const moved = assertHeadUnmoved();
    if (moved) {
      if (!rollbackToCheckpoint()) {
        throw new Error(
          `${moved.rejected[0].reason} — and the store could not be rolled back to its checkpoint; the run is aborted with the store left for manual inspection`
        );
      }
      return moved;
    }

    const applied = [];
    const rejected = [];
    const ledgerEntries = [];
    const governed = [];
    const at = todayClamped();
    const governanceAt = new Date().toISOString();

    for (const { op, id, domain, slug, content } of writes) {
      const file = path.join(layerRoot, 'learnings', domain, `${slug}.md`);
      if (!writeLearningFile(file, content)) {
        throw new Error(`refused to write ${id}: the learning path does not resolve safely inside the knowledge store`);
      }
      applied.push({ op: op.op, id });
      for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: id, at });
      if (op.op === 'SUPERSEDE' && op.target !== id) {
        const target = existing.get(op.target);
        if (!updateFrontmatterField(target.file, 'superseded_by', id)) {
          throw new Error(`refused to tombstone ${op.target}: the learning path does not resolve safely inside the knowledge store`);
        }
      }
      if (op.op === 'MERGE') {
        for (const t of op.targets) {
          const target = existing.get(t);
          if (!updateFrontmatterField(target.file, 'superseded_by', id)) {
            throw new Error(`refused to tombstone ${t}: the learning path does not resolve safely inside the knowledge store`);
          }
        }
      }
    }

    for (const { op, id, domain, slug } of writes) {
      const entry = governance.get(id);
      if (!entry || !['retire', 'dispute', 'promote'].includes(entry.action)) continue;
      const isReteach =
        op.episodes.length > 0 &&
        op.episodes.every((e) => verifyHumanTeachingEpisode(workspace, copilotHome, e, home)) &&
        overridesGovernanceRecency(workspace, copilotHome, op.episodes, entry, { humanPresent, home });
        if (isReteach && layerRoot === dir) {
        appendGovernance(dir, { id, action: 'confirm', reason: 'superseded by re-teach', to: null, at: governanceAt });
        continue;
      }
      if (isReteach) {
        log(
          `consolidate: re-teach of ${id} landed branch-local — the standing ${entry.action} decision still binds both layers; re-teach on the default branch (or promote) to retract it`
        );
      }
      const file = path.join(layerRoot, 'learnings', domain, `${slug}.md`);
      if (entry.action === 'promote') {
        const root = path.resolve(workspace);
        const toFull = path.resolve(root, entry.to || '');
        if (!entry.to || (toFull !== root && !toFull.startsWith(root + path.sep))) {
          log(`consolidate: governance record for ${id} has an unsafe promote target (${entry.to}) — skipped reapply`);
          continue;
        }
        const text = readLearningFile(file);
        if (text === null) {
          throw new Error(`refused to reapply governance to ${id}: the learning path does not resolve safely inside the knowledge store`);
        }
        const { fm, body } = parseLearningFrontmatter(text);
        if (!writeLearningFile(file, serializeLearning({ ...fm, promoted_to: entry.to }, body))) {
          throw new Error(`refused to reapply governance to ${id}: the learning path does not resolve safely inside the knowledge store`);
        }
      } else {
        if (!updateFrontmatterField(file, 'status', entry.action === 'retire' ? 'retired' : 'disputed')) {
          throw new Error(`refused to reapply governance to ${id}: the learning path does not resolve safely inside the knowledge store`);
        }
      }
      governed.push({ id, action: entry.action });
    }

    for (const { op, target, content } of strengthenWrites) {
      if (!writeLearningFile(target.file, content)) {
        throw new Error(`refused to strengthen ${op.target}: the learning path does not resolve safely inside the knowledge store`);
      }
      applied.push({ op: 'STRENGTHEN', id: op.target });
      for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: op.target, at });
    }

    if (promotionMode && !dryRun) {
      const bucketRoot = bucketDirFor(dir, promotion.branchKey);
      let touchedBucket = false;
      for (const entry of [...writes, ...strengthenWrites]) {
        const src = entry.op.source?.id ? promotionSources.get(entry.op.source.id) : null;
        if (!src) continue;
        const text = readLearningFile(src.file);
        if (text === null) {
          throw new Error(`refused to tombstone ${src.id}: bucket learning path does not resolve safely inside the knowledge store`);
        }
        const parsedSource = parseLearningFrontmatter(text);
        if (!writeLearningFile(src.file, serializeLearning({ ...parsedSource.fm, promoted_to_golden: src.id }, parsedSource.body))) {
          throw new Error(`refused to tombstone ${src.id}: bucket learning path does not resolve safely inside the knowledge store`);
        }
        appendGovernance(dir, {
          id: src.id,
          action: 'absorb-branch',
          reason: `promoted from ${promotion.branchKey}`,
          to: null,
          at: governanceAt,
        });
        touchedBucket = true;
      }
      if (touchedBucket) rebuildIndex(bucketRoot);
    }

    for (const op of planned) {
      if (op.op === 'NOOP') {
        applied.push({ op: 'NOOP', id: op.reason || null });
        for (const e of op.episodes) ledgerEntries.push({ path: e.path, sha256: e.sha256, learning: null, at });
      }
    }

    for (const d of disputes) {
      const target = existing.get(d.target);
      if (!updateFrontmatterField(target.file, 'status', 'disputed')) {
        throw new Error(`refused to dispute ${d.target}: the learning path does not resolve safely inside the knowledge store`);
      }
      rejected.push({ ...fail('E_DISPUTED', 'disputed-pending-human'), reason: 'disputed-pending-human', target: d.target });
    }

    if (ledgerEntries.length) appendLedger(layerRoot, ledgerEntries);
    rebuildIndex(layerRoot);

    const summary = applied.length
      ? applied.map((a) => `${a.op.toLowerCase()}${a.id ? ` ${a.id}` : ''}`).join(' · ')
      : disputes.length
        ? `dispute ${disputes.map((d) => d.target).join(', ')}`
        : 'noop';
        const result = {
      kind: 'success',
      applied,
      rejected,
      governed,
      layer: promotionMode ? 'golden' : routing.layer,
      bucketKey: !promotionMode && routing.layer === 'branch' ? routing.bucketKey : null,
      commitMessage: `consolidate: ${summary}${
        promotionMode ? ` [promote ${promotion.branchKey}]` : routing.layer === 'branch' ? ` [${routing.bucketKey}]` : ''
      }`,
    };
    if (operationReceipt && !dryRun) {
      if (!writeStoreFile(path.join(dir, 'operations', `${operationReceipt.id}.json`), JSON.stringify({ version: 1, digest: operationReceipt.digest, resultHash: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'), result }) + '\n')) throw new Error('Cannot publish consolidation operation receipt');
    }
    return result;
  }

  if (dryRun) {
    deriveRouting();
    const { dir, git } = ensureStore(workspace, { home, dryRun: true });
    const result = runOnce({ dir, git });
    if (result.kind === 'reject') {
      return { applied: result.applied, governed: result.governed, rejected: result.rejected, committed: false, exitCode: result.exitCode };
    }
    return { applied: result.applied, rejected: result.rejected, committed: false, exitCode: 0, dryRun: true, governed: result.governed };
  }

    const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: 'consolidate: apply',
            afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home, log });
      },
    },
    ({ dir, git, recordCheckpoint, rollbackToCheckpoint, rollbackUncommitted }) => {
        deriveRouting();
        try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      if (err instanceof StoreTransactionAbort) throw err;
      // best effort — any OTHER hand-edit absorb failure must never block applyOps.
    }
    const { mode: freshMode } = readStoreConfig(workspace, { home });
    if (freshMode !== 'on' && !(freshMode === 'suggest' && approve)) {
      const reason =
        freshMode === 'suggest'
          ? 'knowledge mode is suggest — review the ops JSON, then re-run apply with --yes'
          : `knowledge mode is ${freshMode} — run: ae knowledge on`;
      return { kind: 'reject', applied: [], governed: [], rejected: [{ code: 'E_MODE', reason }], committed: false, exitCode: 2 };
    }
    return runOnce({ dir, git, recordCheckpoint, rollbackToCheckpoint, rollbackUncommitted });
  });

  if (!tx.ok) {
    if (tx.locked) {
      return { applied: [], governed: [], rejected: [fail('E_LOCKED', 'another consolidation holds the store lock')], committed: false, exitCode: 1 };
    }
    return {
      applied: [],
      governed: [],
      rejected: [fail('E_APPLY_FAILED', tx.error?.message || 'store transaction failed')],
      committed: false,
      exitCode: 1,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const staleExtra = tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {};
  const inner = tx.result;
  if (inner.kind === 'reject') {
    return { applied: inner.applied, governed: inner.governed, rejected: inner.rejected, committed: false, exitCode: inner.exitCode, ...staleExtra };
  }

    return {
    applied: inner.applied,
    rejected: inner.rejected,
    committed: tx.committed,
    exitCode: 0,
    storeDir: tx.dir,
    indexPath: path.join(tx.dir, 'INDEX.md'),
    governed: inner.governed,
    layer: inner.layer,
    bucketKey: inner.bucketKey ?? null,
    ...(inner.replayed ? { replayed: true } : {}),
    ...(routing?.branchWarning ? { branchWarning: routing.branchWarning } : {}),
    ...staleExtra,
  };
}

export function updateFrontmatterField(file, field, value) {
  const text = readLearningFile(file);
  if (text === null) return false;
  const re = new RegExp(`^${field}:.*$`, 'm');
    const next = re.test(text)
    ? text.replace(re, `${field}: ${value}`)
    : text.replace(/^---(\r?\n)/, (_, nl) => `---${nl}${field}: ${value}${nl}`);
  return writeLearningFile(file, next);
}

function composeStrengthenedLearning(target, op, workspace, copilotHome, home) {
    const text = readLearningFile(target.file);
  if (text === null) return null;
  const { fm, body } = parseLearningFrontmatter(text);
  const episodes = op.episodes || [];
  const seen = new Set((fm.episodes || []).map((e) => `${e.path}@${e.sha256}`));
  const merged = [...(fm.episodes || [])];
  let gainedFix = false;
  for (const e of episodes) {
    if (seen.has(`${e.path}@${e.sha256}`)) continue;
    merged.push(e);
    if (e.kind === 'fix') gainedFix = true;
  }
  const picked = (key) => (op[key] ? op[key] : fm[key]);
  const authority = picked('authority');
  // A later fix ends rank damping for other provisional learnings. An inference stays provisional.
  const status = authority === 'inference' ? 'provisional' : fm.status === 'provisional' && gainedFix ? 'active' : fm.status || 'active';
  const anchors = [...new Set([...(fm.anchors || []), ...extractAnchors({ workspace, copilotHome, episodes: merged, home })])].slice(0, ANCHOR_CAP);
  const sourceBindings = Array.isArray(fm.source_bindings)
    ? [...fm.source_bindings, ...captureSourceBindings({ workspace, paths: anchors.filter(anchor => !fm.source_bindings.some(binding => binding.path === anchor)) })]
    : fm.source_bindings;
  const content = renderLearning({
    trigger: fm.trigger || '',
    body,
    episodes: merged,
    anchors,
    sourceBindings,
    applicabilityVersion: fm.applicability_version,
    origin: fm.origin || 'unknown',
    status,
    source: fm.source || 'auto',
    supersededBy: fm.superseded_by || null,
        mergedFrom: parseMergedFrom(fm.merged_from),
        promotedTo: fm.promoted_to || null,
        promotedToGolden: fm.promoted_to_golden || null,
        authority,
        why: picked('why'),
        applies: picked('applies'),
        does_not_apply: picked('does_not_apply'),
        shows: picked('shows'),
        provenance: { commit: fm.commit, branch: fm.branch, base: fm.base },
  });
  return content;
}

export function rebuildIndex(dir) {
  const active = listLearnings(dir).filter((l) => isActiveFm(l.fm));
  const lines = [
    '# Learnings Index',
    '',
    '_Rebuilt by `ae consolidate --apply`. One line per active learning._',
    '',
        ...active.map((l) => `- [${l.id}] ${inertLine(l.fm.trigger || '')}`),
    '',
  ];
    if (!writeStoreFile(path.join(dir, 'INDEX.md'), lines.join('\n'))) {
    throw new Error(`refused to rebuild ${path.join(dir, 'INDEX.md')} — the path does not resolve safely inside the knowledge store`);
  }
}
