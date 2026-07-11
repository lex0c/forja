import type { ProactiveRecallFixture } from './types.ts';

// §4.4 I3 the other half: a quarantined memory (under review, contradicted)
// keyword-stuffed to top the ranking must also never surface. The active-only
// filter runs before scoring, same as trust. A memory the operator pulled from
// circulation can't claw its way back via a proactive injection.
export const fixture: ProactiveRecallFixture = {
  name: '04-i3-quarantined-keyword-stuffing',
  description: 'a quarantined keyword-stuffed memory never surfaces (I3 active-only beats BM25)',
  memories: [
    {
      scope: 'user',
      name: 'jwt-auth',
      description: 'authentication token handling',
      body: 'Use JWT bearer tokens for authentication.',
    },
    {
      scope: 'user',
      name: 'stale-note',
      description: 'authentication authentication authentication tokens tokens',
      state: 'quarantined',
      body: 'authentication authentication authentication tokens tokens tokens auth auth auth handling.',
    },
  ],
  goalText: 'authentication',
  prompt: 'how should we handle auth tokens',
  expected: {
    recalls: ['memory:user/jwt-auth'],
    excludes: ['memory:user/stale-note'],
  },
};
