import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedGitObservation, withGitIdentityCache, withGitObservationCache } from '../lib/git-observation-cache.mjs';

test('an identity phase reuses only repository identity and never HEAD, diff or domain snapshots', () => {
  const reads = new Map();
  const read = key => cachedGitObservation([key, '/workspace'], () => {
    const count = (reads.get(key) || 0) + 1;
    reads.set(key, count);
    return count;
  });
  withGitIdentityCache(() => {
    assert.equal(read('repo-identity'), 1);
    assert.equal(read('repo-identity'), 1);
    for (const key of ['head', 'changed', 'inspect', 'coordinator', 'authority-project-store']) {
      assert.equal(read(key), 1);
      assert.equal(read(key), 2, `${key} must remain a live observation`);
    }
    withGitObservationCache(() => {
      assert.equal(read('repo-identity'), 1);
      assert.equal(read('head'), 3, 'a nested legacy validator must not widen the identity-only cache');
      assert.equal(read('head'), 4);
    });
  });
  withGitIdentityCache(() => assert.equal(read('repo-identity'), 2, 'a new phase reobserves identity'));
});

test('an independent identity phase never inherits a populated broader cache', () => {
  let observed = 0;
  const read = () => cachedGitObservation(['repo-identity', '/workspace'], () => ++observed);
  withGitObservationCache(() => {
    assert.equal(read(), 1);
    withGitIdentityCache(() => {
      assert.equal(read(), 2);
      assert.equal(read(), 2);
    });
    withGitIdentityCache(() => assert.equal(read(), 3));
  });
});

test('identity phases reject asynchronous callbacks and deactivate observations retained after await', async () => {
  let release, pending, afterAwait, observed = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const read = () => cachedGitObservation(['repo-identity', '/workspace'], () => ++observed);
  assert.throws(() => withGitIdentityCache(() => {
    assert.equal(read(), 1);
    pending = (async () => { await barrier; afterAwait = [read(), read()]; })();
    return pending;
  }), /synchronous/);
  release();
  await pending;
  assert.deepEqual(afterAwait, [2, 3], 'async continuation cannot retain the old scope or cache new observations');
});

test('throwing from an identity phase does not retain its observations', () => {
  let observed = 0;
  const read = () => cachedGitObservation(['repo-identity', '/workspace'], () => ++observed);
  assert.throws(() => withGitIdentityCache(() => { read(); throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(read(), 2);
  assert.equal(read(), 3);
});
