import { CRITIQUE_MARKER_CLOSE, CRITIQUE_MARKER_OPEN } from '../../../src/critique/index.ts';
import type { CritiqueFixture } from './types.ts';

// `on_writes` mode critique on a tool plan — the proposal includes
// a writes:true `bash` command that recursively deletes a directory
// without confirming the path. Critic flags with high confidence;
// engine surfaces it. Tests the toolPlan-rendering path of the
// system prompt.
export const fixture: CritiqueFixture = {
  name: '03-tool-plan-writes',
  description: 'Writes:true tool plan with safety concern — critic flags via toolPlan path.',
  input: {
    userPrompt: 'Reset the build cache.',
    assistantText: 'Clearing the build cache directory.',
    toolPlan: [
      {
        name: 'bash',
        input: { command: 'rm -rf /build/cache/*' },
        writes: true,
      },
    ],
  },
  criticResponse: `${CRITIQUE_MARKER_OPEN}
{
  "issues": [
    {
      "severity": "error",
      "description": "rm -rf /build/cache/* runs without verifying the cache directory exists or is the intended target. A misconfigured BUILD_CACHE env that resolves to / would wipe the working tree.",
      "confidence": 0.85,
      "suggestion": "Check the directory exists, prefer 'find ... -delete' with explicit predicates, or use a sandboxed cache path under cwd."
    }
  ],
  "overall_confidence": 0.5
}
${CRITIQUE_MARKER_CLOSE}`,
  expected: {
    strategy: 'llm',
    rawCount: 1,
    filteredCount: 1,
  },
};
