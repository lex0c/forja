import { CRITIQUE_MARKER_CLOSE, CRITIQUE_MARKER_OPEN } from '../../../src/critique/index.ts';
import type { CritiqueFixture } from './types.ts';

// Real bug in the proposal — the executor "deletes" by setting a
// reference to null but never frees the underlying handle. Critic
// flags with high confidence as an `error` severity. Engine should
// surface one filtered issue (above threshold 0.7).
export const fixture: CritiqueFixture = {
  name: '02-flagged-bug',
  description: 'Real bug in proposal — critic flags with confidence 0.9, engine surfaces it.',
  input: {
    userPrompt: 'Free the cached file handles when the cache is evicted.',
    assistantText:
      'I added eviction logic that sets `cache[key] = null` and removes the entry ' +
      'from the LRU list. The handle reference is dropped from the cache so it ' +
      'will be garbage collected.',
  },
  criticResponse: `${CRITIQUE_MARKER_OPEN}
{
  "issues": [
    {
      "severity": "error",
      "description": "Setting cache[key] = null does not close the underlying file descriptor; GC will not invoke the close syscall on its own. The handle leaks until process exit.",
      "confidence": 0.92,
      "suggestion": "Call handle.close() (or equivalent) before nulling the cache entry so the OS-side fd is released."
    }
  ],
  "overall_confidence": 0.4
}
${CRITIQUE_MARKER_CLOSE}`,
  expected: {
    strategy: 'llm',
    rawCount: 1,
    filteredCount: 1,
    maxOverallConfidence: 0.5,
  },
};
