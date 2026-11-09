import { gitSupportsNoLazyFetch, MIN_GIT_NO_LAZY_FETCH } from '../../lib/doctor.mjs';

// Flow models and formal verification refuse to read Git metadata without --no-lazy-fetch.
// Their tests skip on older Git unless CI demands the capability, so a broken probe cannot hide them.
const supported = gitSupportsNoLazyFetch();
if (!supported && process.env.AE_REQUIRE_NO_LAZY_FETCH === '1') {
  throw new Error(`AE_REQUIRE_NO_LAZY_FETCH=1 but git on PATH does not accept --no-lazy-fetch (needs Git ${MIN_GIT_NO_LAZY_FETCH}+)`);
}
export const NEEDS_NO_LAZY_FETCH = supported ? false : `needs Git ${MIN_GIT_NO_LAZY_FETCH}+ for --no-lazy-fetch`;
