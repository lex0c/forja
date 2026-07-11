import type { HarnessEvent } from '../../harness/index.ts';
import type { OutputRenderer } from './types.ts';

// NDJSON renderer for `--json` headless mode. Spec §2.2: in `--json`,
// stdout MUST be valid NDJSON only — nothing else. Each event is a line.
//
// We pass the HarnessEvent through directly; provider_event embeds the
// canonical StreamEvent shape (CONTRACTS.md §4) so consumers can rely on
// the exact taxonomy.
export interface JsonRendererOptions {
  // Sink for NDJSON lines. Defaults to process.stdout.write in production;
  // tests inject string-collecting fakes.
  out?: (s: string) => void;
}

export const createJsonRenderer = (options: JsonRendererOptions = {}): OutputRenderer => {
  const out = options.out ?? ((s: string) => process.stdout.write(s));
  return {
    onEvent(event: HarnessEvent) {
      out(`${JSON.stringify(event)}\n`);
    },
    flush() {
      // No trailing state to emit; each event is self-contained.
    },
  };
};
