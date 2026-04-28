import type { HarnessEvent } from '../../harness/index.ts';

// Subscribers to harness events. Renderers implement this to push lifecycle
// events to their target (TTY, NDJSON, future Ink components, etc.).
//
// The `flush` hook lets renderers emit any final state after the harness
// returns (e.g., a trailing newline, summary footer). Sync to keep simple.
export interface OutputRenderer {
  onEvent(event: HarnessEvent): void;
  flush(): void;
}
