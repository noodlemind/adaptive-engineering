import fs from 'node:fs';
import path from 'node:path';
import { storeDir, withStoreTransaction, StoreTransactionAbort, listLearnings, serializeLearning, appendGovernance } from './store.mjs';
import { updateFrontmatterField, todayClamped, rebuildIndex } from './apply.mjs';
import { writeLearningFile } from './store-io.mjs';
import { absorbOrAbort, mirrorLearnings } from './admin.mjs';

const ACTIONS = new Set(['retire', 'dispute', 'confirm', 'promote']);
const TARGET_STATUS = { retire: 'retired', dispute: 'disputed', confirm: 'active' };

export function setLearningStatus({ workspace, id, action, reason, to, home, log = () => {} }) {
  if (!ACTIONS.has(action) || !id) {
    return { pass: false, exitCode: 2, id: id || null, status: null,
      blockedReason: 'usage: ae learning <retire|dispute|confirm|promote> <id> --reason "<r>" | --to <path>' };
  }
  if (action !== 'confirm' && action !== 'promote' && !reason) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: `${action} requires --reason` };
  }
  if (action === 'promote' && !to) {
    return { pass: false, exitCode: 2, id, status: null, blockedReason: 'promote requires --to' };
  }

    const storePath = storeDir(workspace, { home });
  if (!fs.existsSync(storePath)) {
    return { pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
  }

  const tx = withStoreTransaction(
    workspace,
    {
      home,
      label: `${action} ${id}`,
            afterCommit: ({ result }) => {
        if (result?.kind === 'reject') return;
        mirrorLearnings({ workspace, home });
      },
    },
    ({ dir, recordCheckpoint }) => {
        try {
      absorbOrAbort({ workspace, home, log, recordCheckpoint });
    } catch (err) {
      if (err instanceof StoreTransactionAbort) throw err;
    }
    const learning = listLearnings(dir).find((l) => l.id === id);
    if (!learning) {
      return { kind: 'reject', pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: no learning ${id}` };
    }

    if (action !== 'promote' && learning.fm.promoted_to) {
      return {
        kind: 'reject', pass: false, exitCode: 2, id, status: null,
        blockedReason: `${id} is promoted (behavior lives in ${learning.fm.promoted_to}) — lifecycle actions don't apply; edit the primitive or purge`,
      };
    }

    if (action === 'promote') {
      const root = path.resolve(workspace);
      const primitiveFull = path.resolve(root, to);
      if (primitiveFull !== root && !primitiveFull.startsWith(root + path.sep)) {
        return { kind: 'reject', pass: false, exitCode: 2, id, status: null, blockedReason: `promote --to escapes the workspace: ${to}` };
      }
      if (!fs.existsSync(primitiveFull)) {
        return { kind: 'reject', pass: false, exitCode: 1, id, status: null, blockedReason: `E_TARGET: ${to} does not exist` };
      }
      const hasQualifyingEpisode = (learning.fm.episodes || []).some(
        (e) => e.path && (e.kind === 'fix' || e.kind === 'human-teaching')
      );
      if (!hasQualifyingEpisode) {
        return {
          kind: 'reject', pass: false, exitCode: 2, id, status: null,
          blockedReason: 'insight-only learnings never promote (design §10)',
        };
      }
      const promotedTo = path.relative(root, primitiveFull).split(path.sep).join('/');
      const nextFm = { ...learning.fm, promoted_to: promotedTo };
      if (!writeLearningFile(learning.file, serializeLearning(nextFm, learning.body))) {
        throw new Error(`refused to promote ${id}: the learning path does not resolve safely inside the knowledge store`);
      }
      rebuildIndex(dir);
      appendGovernance(dir, { id, action: 'promote', reason: reason || null, to: promotedTo, at: new Date().toISOString() });
      return { kind: 'success', commitMessage: `promote ${id}: ${promotedTo}`, status: 'promoted' };
    }

    if (!updateFrontmatterField(learning.file, 'status', TARGET_STATUS[action])) {
      throw new Error(`refused to ${action} ${id}: the learning path does not resolve safely inside the knowledge store`);
    }
    if (action === 'confirm' && !updateFrontmatterField(learning.file, 'last_confirmed', todayClamped())) {
      throw new Error(`refused to confirm ${id}: the learning path does not resolve safely inside the knowledge store`);
    }
    rebuildIndex(dir);
    appendGovernance(dir, { id, action, reason: reason || null, to: null, at: new Date().toISOString() });
    return { kind: 'success', commitMessage: `${action} ${id}: ${reason || 'human confirm'}`, status: TARGET_STATUS[action] };
  });

  if (!tx.ok) {
    return {
      pass: false,
      exitCode: 1,
      id,
      status: null,
      blockedReason: tx.locked
        ? 'E_LOCKED: another operation holds the store lock'
        : `${action} failed: ${tx.error?.message || 'store transaction failed'}`,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

  const inner = tx.result;
  if (inner.kind === 'reject') {
    return {
      pass: inner.pass,
      exitCode: inner.exitCode,
      id: inner.id,
      status: inner.status,
      blockedReason: inner.blockedReason,
      ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
    };
  }

    return {
    pass: true,
    exitCode: 0,
    id,
    status: inner.status,
    blockedReason: null,
    ...(tx.staleLockNote ? { staleLockRemoved: tx.staleLockNote } : {}),
  };
}
