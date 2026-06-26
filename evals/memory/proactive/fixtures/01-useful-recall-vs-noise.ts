import type { ProactiveRecallFixture } from './types.ts';

// Useful recall: a clearly-relevant memory surfaces for an on-topic turn while
// unrelated memories stay out. The baseline the whole feature has to clear —
// if this fails, proactive injection is either silent or noisy.
export const fixture: ProactiveRecallFixture = {
  name: '01-useful-recall-vs-noise',
  description: 'a clearly-relevant memory surfaces; unrelated memories stay out',
  memories: [
    {
      scope: 'user',
      name: 'jwt-auth',
      description: 'authentication token handling',
      body: 'Use short-lived JWT bearer tokens for authentication. Validate the token signature on every request and reject expired auth tokens.',
    },
    {
      scope: 'user',
      name: 'css-naming',
      description: 'css class naming convention',
      body: 'Prefer BEM naming for CSS classes across the web app components.',
    },
    {
      scope: 'user',
      name: 'git-rebase',
      description: 'git branch workflow',
      body: 'Rebase feature branches onto main before opening a merge request.',
    },
  ],
  goalText: 'authentication',
  prompt: 'how should we handle auth tokens on the API',
  expected: {
    recalls: ['memory:user/jwt-auth'],
    excludes: ['memory:user/css-naming', 'memory:user/git-rebase'],
  },
};
