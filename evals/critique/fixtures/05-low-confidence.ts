import { CRITIQUE_MARKER_CLOSE, CRITIQUE_MARKER_OPEN } from '../../../src/critique/index.ts';
import type { CritiqueFixture } from './types.ts';

// Critic flags two issues but both confidences are below the default
// threshold of 0.7. Engine surfaces them in `rawIssues` (audit
// preserves them) but `filteredIssues` is empty (modal does NOT
// open). Tests the threshold-gate semantic — false positives that
// the model wasn't sure about don't reach the operator. Spec line
// 564 confidence guide: < 0.5 = noise, 0.5 = coin flip.
export const fixture: CritiqueFixture = {
  name: '05-low-confidence',
  description:
    'Critic flags but confidences are below threshold — rawIssues preserved, filteredIssues empty.',
  input: {
    userPrompt: 'Add logging to the auth middleware.',
    assistantText: 'Added a logger.info line at the start of authenticate().',
  },
  criticResponse: `${CRITIQUE_MARKER_OPEN}
{
  "issues": [
    {
      "severity": "info",
      "description": "Could log the request id alongside the user id.",
      "confidence": 0.45,
      "suggestion": "Pass req.id into the logger.info call."
    },
    {
      "severity": "warn",
      "description": "Logging at info might be too verbose for high-traffic auth.",
      "confidence": 0.55,
      "suggestion": "Consider debug level instead."
    }
  ],
  "overall_confidence": 0.7
}
${CRITIQUE_MARKER_CLOSE}`,
  expected: {
    strategy: 'llm',
    rawCount: 2,
    filteredCount: 0,
  },
};
