import { describe, expect, test } from 'bun:test';
import { buildToolDefs } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import { DEFER_BELOW_TOKENS_SMALL } from '../../src/tools/context-budget.ts';

// Window-relative deferral tier (CONTEXT_TUNING §2.2). buildToolDefs reads
// `provider.capabilities.context_window` live, so the surface re-leans whenever
// a `/model` swap changes the window (the loop re-runs buildToolDefs per turn).
const stub = (name: string, metaExtra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description.`,
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'misc', writes: false, idempotent: true, ...metaExtra },
  execute: async () => ({}),
});

// `task` carries a small-window tier; `read_file` is core (no tier); `tool_search`
// is always-on and carries the deferred catalog in its description.
const config = (window: number): HarnessConfig =>
  ({
    toolRegistry: {
      list: () => [
        stub('read_file'),
        stub('task', { deferBelowTokens: DEFER_BELOW_TOKENS_SMALL }),
        stub('tool_search'),
      ],
    },
    provider: { capabilities: { context_window: window } },
  }) as unknown as HarnessConfig;

const LARGE = 200_000;
const SMALL = 32_000;

describe('buildToolDefs: window-relative deferral tier', () => {
  test('a window-tagged tool stays on the base wire on a large window', () => {
    expect(buildToolDefs(config(LARGE)).map((d) => d.name)).toContain('task');
  });

  test('a window-tagged tool leaves the base wire on a small window', () => {
    const names = buildToolDefs(config(SMALL)).map((d) => d.name);
    expect(names).not.toContain('task');
    expect(names).toContain('read_file'); // core stays
    expect(names).toContain('tool_search'); // always-on
  });

  test('the small-window catalog advertises the deferred tool in tool_search', () => {
    const search = buildToolDefs(config(SMALL)).find((d) => d.name === 'tool_search');
    expect(search?.description).toContain('Deferred tools');
    expect(search?.description).toContain('task');
  });

  test('on a large window the catalog is empty (nothing window-deferred)', () => {
    const search = buildToolDefs(config(LARGE)).find((d) => d.name === 'tool_search');
    expect(search?.description).not.toContain('Deferred tools');
  });

  test('a revealed window-deferred tool rides the small-window wire (sticky)', () => {
    const names = buildToolDefs(config(SMALL), new Set(['task'])).map((d) => d.name);
    expect(names).toContain('task');
  });

  test('an unknown window (0) keeps the tagged tool visible (static fallback)', () => {
    expect(buildToolDefs(config(0)).map((d) => d.name)).toContain('task');
  });
});
