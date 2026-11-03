import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Reuse git observations for one read-only validation. A later call reads git again. */
export function withGitObservationCache(run) {
  if (storage.getStore()) return run();
  return storage.run(new Map(), run);
}

/** One synchronous read phase; no policy, aliases, HEAD or changed-file cache. */
export function withGitIdentityCache(run) {
  const map = new Map();
  map.identityOnly = true;
  map.active = true;
  try {
    const result = storage.run(map, run);
    if (result && typeof result.then === 'function') throw new Error('Git identity observation phases must be synchronous');
    return result;
  } finally {
    // Async resources created accidentally inside the callback retain their ALS
    // context. Deactivate it as well as clearing it before that work can resume.
    map.active = false;
    map.clear();
  }
}

export function cachedGitObservation(key, read) {
  const map = storage.getStore();
  if (!map || map.active === false || map.identityOnly && key[0] !== 'repo-identity') return read();
  const id = JSON.stringify(key);
  if (map.has(id)) return map.get(id);
  const value = read();
  map.set(id, value);
  return value;
}
