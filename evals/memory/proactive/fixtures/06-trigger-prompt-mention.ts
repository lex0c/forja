import type { ProactiveRecallFixture } from './types.ts';

// §4.4 P3 prompt-mention runtime trigger: a memory tagged `triggers: [kubernetes]`
// surfaces when the prompt mentions the tag, even though the term appears nowhere
// in its name/description/body. The untagged off-topic memories stay out — the
// tag is the ONLY thing connecting that memory to the turn. (Three memories so
// the tag's IDF clears the floor — the two-doc corpus put it at 0.96, just under,
// a reminder that the floor is corpus-size sensitive.)
export const fixture: ProactiveRecallFixture = {
  name: '06-trigger-prompt-mention',
  description:
    'a triggers:-tagged memory surfaces on a prompt mentioning the tag (term absent from its text)',
  memories: [
    {
      scope: 'user',
      name: 'deploy-checklist',
      description: 'release checklist steps',
      triggers: ['kubernetes'],
      body: 'Run the smoke suite and bump the version before shipping.',
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
      body: 'Rebase feature branches onto main before merging.',
    },
  ],
  goalText: 'infrastructure work',
  prompt: 'walk me through a kubernetes rollout',
  expected: {
    recalls: ['memory:user/deploy-checklist'],
    excludes: ['memory:user/css-naming', 'memory:user/git-rebase'],
  },
};
