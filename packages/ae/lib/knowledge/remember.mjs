import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInsightCompound } from '../compound.mjs';
import { runIndexKnowledge } from '../index-knowledge.mjs';
import { applyOps } from './apply.mjs';
import { normalizeSlug, readStoreConfig, storeDir, listLearnings, withStoreTransaction, StoreTransactionAbort, readLedger, writeLedger, CORRECTION_AUTHORITIES } from './store.mjs';
import { absorbOrAbort } from './admin.mjs';
import { resolveWriteLayer } from './layer.mjs';
import { bucketDirFor } from './overlay.mjs';
import { episodeAbsPath } from '../project-layout.mjs';
import { positionalsOf } from '../positionals.mjs';
import { checkServeSentence } from '../sentence.mjs';

function oneLine(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim();
  if (!line || /[\u0000-\u001f\u007f]/.test(line)) return null;
  return line;
}

function refuseCorrect(blockedReason) {
  return {
    pass: false,
    exitCode: 2,
    episodePath: null,
    learningId: null,
    blockedReason,
    nextTools: [
      'ae correct "<claim>" --trigger "<when>" --why "<why>" --applies "<where>" --does-not-apply "<where not>" --shows "<phrase>" --authority <instruction|correction|inference>',
    ],
  };
}

export function runCorrect(args) {
  const flags = args.flags || {};
  const why = oneLine(flags.why);
  const applies = oneLine(flags.applies);
  const doesNot = oneLine(flags.doesNotApply);
  const authority = typeof flags.authority === 'string' ? flags.authority.trim() : '';
  if (!why || !applies || !doesNot || !CORRECTION_AUTHORITIES.has(authority)) {
    const named = typeof flags.authority === 'string' ? flags.authority.trim() : '';
    const blockedReason = named && !CORRECTION_AUTHORITIES.has(named)
      ? 'authority must be instruction, correction, or inference'
      : 'correct needs --why, --applies, --does-not-apply, and --authority';
    return refuseCorrect(blockedReason);
  }
  const claim = positionalsOf(args.argv, { limit: 1 })[0] || '';
  const shows = oneLine(flags.shows);
  if (authority === 'correction' && !shows) return refuseCorrect('correct --authority correction needs --shows');
  if (shows && shows.split(/\s+/).length > 25) return refuseCorrect('shows is longer than 25 words');
  for (const [field, value] of [
    ['claim', claim],
    ['applies', applies],
    ['does_not_apply', doesNot],
  ]) {
    const sentence = checkServeSentence(value, field);
    if (!sentence.ok) return refuseCorrect(sentence.blockedReason);
  }
  return runRemember({
    ...args,
    correction: { authority, why, applies, does_not_apply: doesNot, ...(shows ? { shows } : {}) },
  });
}

export function runRemember({ workspace, copilotHome, flags, argv, log = () => {}, home, correction = null }) {
    const { mode } = readStoreConfig(workspace, { home });
  if (!['on', 'suggest'].includes(mode)) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId: null,
      blockedReason: `knowledge mode is ${mode} — run: ae knowledge on`,
      nextTools: ['ae knowledge on'],
    };
  }
    const claim = positionalsOf(argv, { limit: 1 })[0] || null;
  if (!claim || !flags.trigger) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId: null,
      blockedReason: 'remember needs a claim positional and --trigger',
      nextTools: ['ae remember "<claim>" --trigger "<when it applies>"'],
    };
  }

  const domain = normalizeSlug(flags.domain || 'general');
  const slug = normalizeSlug(flags.trigger);
  const learningId = `${domain}/${slug}`;

    const dir = storeDir(workspace, { home });
  const goldenLearning = fs.existsSync(dir) ? listLearnings(dir).find((l) => l.id === learningId) : null;
    let layerRoot = dir;
  try {
    const routing = resolveWriteLayer({ workspace, home });
    if (routing.layer === 'branch' && routing.bucketKey) layerRoot = bucketDirFor(dir, routing.bucketKey);
  } catch {
    layerRoot = dir;
  }
  const existingLearning =
    layerRoot === dir ? goldenLearning : fs.existsSync(layerRoot) ? listLearnings(layerRoot).find((l) => l.id === learningId) : null;
  const promotedTo = goldenLearning?.fm.promoted_to || existingLearning?.fm.promoted_to;
  if (promotedTo) {
    return {
      pass: false,
      exitCode: 2,
      episodePath: null,
      learningId,
      blockedReason: `this claim was promoted to ${promotedTo} — update that primitive, or re-teach under a different --trigger/--domain`,
      nextTools: [`ae learnings --why ${learningId}`],
    };
  }

  const teachFlags = {
    ...flags,
    title: claim.slice(0, 80),
    body: claim,
    category: flags.category || 'teachings',
    claim,
  };
  const episode = runInsightCompound({ workspace, copilotHome, flags: teachFlags, log, kind: 'human-teaching', home });
  if (!episode.pass) {
    return {
      pass: false,
      exitCode: episode.exitCode,
      episodePath: null,
      learningId: null,
      blockedReason: episode.blockedReason,
      nextTools: episode.nextTools,
    };
  }

    if (flags.dryRun) {
    return {
      pass: true,
      exitCode: 0,
      episodePath: episode.path,
      learningId,
      blockedReason: null,
      dryRun: true,
      nextTools: ['re-run without --dry-run to write the episode and learning'],
    };
  }

  const episodeFull = episodeAbsPath(workspace, episode.path, { home });
  const text = fs.readFileSync(episodeFull, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');

    const newEpisode = { path: episode.path, sha256, kind: 'human-teaching', plan: null };
  const scope = { ...(correction || {}) };
  if (existingLearning) {
    for (const key of ['authority', 'why', 'applies', 'does_not_apply', 'shows']) {
      if (!scope[key] && existingLearning.fm[key]) scope[key] = existingLearning.fm[key];
    }
  }
  const op = existingLearning
    ? { op: 'SUPERSEDE', target: learningId, domain, slug, trigger: flags.trigger, body: claim, episodes: [newEpisode], ...scope }
    : { op: 'ADD', domain, slug, trigger: flags.trigger, body: claim, episodes: [newEpisode], ...scope };
  const ops = { schema: 1, ops: [op] };
  const opsDir = path.join(workspace, '.harness');
  fs.mkdirSync(opsDir, { recursive: true });
    const opsPath = path.join(opsDir, `remember-ops-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(opsPath, JSON.stringify(ops), 'utf8');
  let applied;
  try {
    applied = applyOps({ workspace, opsPath, dryRun: flags.dryRun, home, approve: true, log, copilotHome, humanPresent: true });
  } finally {
    fs.rmSync(opsPath, { force: true });
  }
  if (applied.exitCode !== 0) {
    fs.rmSync(episodeFull, { force: true });
    try {
      withStoreTransaction(workspace, { home, label: `remember: clear failure bookkeeping for ${episode.path}` }, ({ dir, recordCheckpoint }) => {
        try {
          absorbOrAbort({ workspace, home, log, recordCheckpoint });
        } catch (err) {
          if (err instanceof StoreTransactionAbort) throw err;
          // best effort — any OTHER hand-edit absorb failure must never block this cleanup.
        }
        const ledger = readLedger(dir);
        const keptLedger = ledger.filter((e) => e.path !== episode.path);
        if (keptLedger.length === ledger.length) {
          return { kind: 'success', commitMessage: null };
        }
        // Through the choke point, fail-closed on an unreadable ledger (R1).
        writeLedger(dir, keptLedger);
        return { kind: 'success', commitMessage: `remember: clear failure bookkeeping for ${episode.path}` };
      });
    } catch {
      // best effort — a ledger-cleanup failure must never mask the original rejection.
    }
    try {
      const knowledgeRoot = fs.existsSync(path.join(copilotHome, 'knowledge'))
        ? path.join(copilotHome, 'knowledge')
        : null;
      runIndexKnowledge({ knowledgeRoot, workspace, copilotHome, flags, log, home });
    } catch {
      // advisory reindex — the rollback itself already succeeded
    }
    const rejectedCode = applied.rejected?.[0]?.code;
    const rejectedReason = applied.rejected?.[0]?.reason;
    const isTriggerControlChar = rejectedCode === 'E_SCHEMA' && /trigger must not contain control characters/.test(rejectedReason || '');
    return {
      pass: false,
      exitCode: applied.exitCode,
      episodePath: null,
      learningId: null,
      blockedReason: isTriggerControlChar
        ? '--trigger contains control characters (a line break, tab, etc.) — remove them and re-run'
        : rejectedReason || 'apply failed',
      nextTools: rejectedCode === 'E_BYTE_CAP' ? ['shorten the claim (1,200-byte learning cap) and re-run'] : [],
      ...(applied.staleLockRemoved ? { staleLockRemoved: applied.staleLockRemoved } : {}),
    };
  }
  return {
    pass: true,
    exitCode: 0,
    episodePath: episode.path,
    learningId,
    blockedReason: null,
    nextTools: ['ae learnings ' + domain],
    ...(applied.staleLockRemoved ? { staleLockRemoved: applied.staleLockRemoved } : {}),
  };
}
