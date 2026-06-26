import type { ProactiveRecallFixture } from './types.ts';

// Noise rejection / Δcache cost = 0: when the turn is about a topic NO memory
// covers, every candidate scores ~0, falls under the BM25 floor, and nothing is
// injected. The reactive baseline (§4.1-4.2) pays nothing here; proactive must
// not either. This is what keeps the feature from taxing every unrelated turn.
export const fixture: ProactiveRecallFixture = {
  name: '02-nothing-relevant-injects-nothing',
  description: 'no memory clears the floor on an off-topic turn → nothing injected',
  memories: [
    {
      scope: 'user',
      name: 'jwt-auth',
      description: 'authentication token handling',
      body: 'Use JWT bearer tokens for authentication.',
    },
    {
      scope: 'user',
      name: 'css-naming',
      description: 'css class naming convention',
      body: 'Prefer BEM naming for CSS classes.',
    },
    {
      scope: 'user',
      name: 'git-rebase',
      description: 'git branch workflow',
      body: 'Rebase feature branches onto main.',
    },
  ],
  goalText: 'database',
  prompt: 'design the postgres migration and schema indexes',
  expected: { count: 0, maxBlockChars: 0 },
};
