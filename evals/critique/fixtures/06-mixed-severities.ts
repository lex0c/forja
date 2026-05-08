import { CRITIQUE_MARKER_CLOSE, CRITIQUE_MARKER_OPEN } from '../../../src/critique/index.ts';
import type { CritiqueFixture } from './types.ts';

// Critic emits one issue at each severity level (info / warn /
// error), all above threshold. Engine preserves severity verbatim
// in rawIssues — verifies the bridge between engine vocabulary
// and the modal's translation layer (info→low, warn→medium,
// error→high) doesn't lose fidelity at the engine boundary.
export const fixture: CritiqueFixture = {
  name: '06-mixed-severities',
  description:
    'One issue per severity (info/warn/error), all above threshold — engine preserves severity in rawIssues.',
  input: {
    userPrompt: 'Refactor the date helper.',
    assistantText: 'Done — see src/date.ts.',
  },
  criticResponse: `${CRITIQUE_MARKER_OPEN}
{
  "issues": [
    {
      "severity": "info",
      "description": "Function name 'fmt' is terse for an exported helper.",
      "confidence": 0.75,
      "suggestion": "Consider 'formatDate' for clarity."
    },
    {
      "severity": "warn",
      "description": "No timezone is applied; consumers in different TZs will see drift.",
      "confidence": 0.8,
      "suggestion": "Accept a 'tz' parameter or document UTC behavior."
    },
    {
      "severity": "error",
      "description": "DST boundary returns 23h or 25h depending on direction; current implementation assumes 24h days.",
      "confidence": 0.9,
      "suggestion": "Use Temporal API or a vetted TZ library, do not subtract 24*3600 directly."
    }
  ],
  "overall_confidence": 0.3
}
${CRITIQUE_MARKER_CLOSE}`,
  expected: {
    strategy: 'llm',
    rawCount: 3,
    filteredCount: 3,
    maxOverallConfidence: 0.4,
  },
};
