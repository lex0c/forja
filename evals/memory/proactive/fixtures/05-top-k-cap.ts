import type { ProactiveRecallFixture } from './types.ts';

// Top-K cap: with more relevant memories than the cap, the injected set stays
// bounded at PROACTIVE_RECALL_TOP_K (3). This is the second half of the cost
// story — even a corpus where everything is on-topic can't flood the turn.
//
// Each memory carries a DISTINCT high-signal term (jwt / session / oauth /
// refresh / csrf) that the prompt names; the shared "auth" stem sits in every
// name so its IDF collapses (df = N) and contributes ~nothing — which is exactly
// why the distinctive term, not the shared one, has to carry the match past the
// floor. Five clear the floor; only the top 3 inject.
export const fixture: ProactiveRecallFixture = {
  name: '05-top-k-cap',
  description: 'more relevant memories than the cap → only top-K (3) injected',
  memories: [
    {
      scope: 'user',
      name: 'auth-jwt',
      description: 'jwt signature validation',
      body: 'Validate the jwt signature on every request.',
    },
    {
      scope: 'user',
      name: 'auth-session',
      description: 'session cookie expiry',
      body: 'Expire the session cookie after inactivity.',
    },
    {
      scope: 'user',
      name: 'auth-oauth',
      description: 'oauth grant scopes',
      body: 'Check the oauth grant scopes before access.',
    },
    {
      scope: 'user',
      name: 'auth-refresh',
      description: 'refresh rotation',
      body: 'Rotate the refresh credential on reuse.',
    },
    {
      scope: 'user',
      name: 'auth-csrf',
      description: 'csrf double submit',
      body: 'Use the csrf double submit cookie pattern.',
    },
  ],
  goalText: 'authentication',
  prompt: 'review jwt session oauth refresh csrf handling',
  // count pins the cap; maxBlockChars pins the Δcache cost of the WORST case
  // (top-K full) — bounded to a few hundred chars (~100 tokens), not thousands.
  expected: { count: 3, maxBlockChars: 600 },
};
