import { CRITIQUE_MARKER_CLOSE, CRITIQUE_MARKER_OPEN } from '../../../src/critique/index.ts';
import type { CritiqueFixture } from './types.ts';

// Clean executor output — a small refactor that addresses the user's
// ask without surprises. Critic emits an empty issues list and
// reports high overall confidence. Engine should return strategy=llm
// with zero filtered issues, and the modal would NOT open. Spec
// §5.4 line 574: false positive rate < 5% — a critic that flagged
// this would be the dominant noise source.
export const fixture: CritiqueFixture = {
  name: '01-clean-output',
  description: 'Clean executor output — critic emits empty issues, engine surfaces zero filtered.',
  input: {
    userPrompt: 'Rename `oldName` to `newName` in src/utils.ts.',
    assistantText:
      'I read src/utils.ts, found 3 occurrences of `oldName` (line 12, 47, 89), ' +
      'and replaced each with `newName`. The function signature is unchanged.',
  },
  criticResponse: `Sure, here is my review:
${CRITIQUE_MARKER_OPEN}
{"issues":[],"overall_confidence":0.95}
${CRITIQUE_MARKER_CLOSE}`,
  expected: {
    strategy: 'llm',
    rawCount: 0,
    filteredCount: 0,
    minOverallConfidence: 0.9,
  },
};
