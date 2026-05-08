import type { CritiqueFixture } from './types.ts';

// Critic emits text that's missing the close marker. Engine should
// soft-fail with strategy=failed and reason=markers_missing — the
// run continues, audit captures the failure, no modal opens.
// Verifies the spec's "critic is a soft check, not a hard gate"
// guarantee.
export const fixture: CritiqueFixture = {
  name: '04-malformed-output',
  description: 'Critic forgets the close marker — engine soft-fails with markers_missing.',
  input: {
    userPrompt: 'Add a unit test for parseCSV.',
    assistantText: 'Added tests/parseCSV.test.ts with 3 cases.',
  },
  // Open marker present, close marker missing. The engine's
  // extractor returns null, parser never runs, soft-fail path
  // takes over.
  criticResponse: `[critique]
{"issues":[],"overall_confidence":1.0}
(forgot to close the block)`,
  expected: {
    strategy: 'failed',
    reasonContains: 'markers_missing',
  },
};
