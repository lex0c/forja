import { describe, expect, test } from 'bun:test';
import type { HarnessConfig } from '../../src/harness/index.ts';
import { buildToolDefs } from '../../src/harness/loop.ts';
import { registerBuiltinTools } from '../../src/tools/builtin/index.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

// Minimal config: buildToolDefs only reads toolRegistry + the operator/reminder
// presence flags + subagentDepth. Both surfaces are "present" so the operator-
// and reminder-gated tools aren't filtered for an unrelated reason.
const makeConfig = (subagentDepth: number): HarnessConfig => {
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return {
    toolRegistry,
    confirmPermission: () => Promise.resolve('allow'),
    reminderScheduler: {},
    subagentDepth,
  } as unknown as HarnessConfig;
};

const deferredNames = (config: HarnessConfig): string[] =>
  config.toolRegistry
    .list()
    .filter((t) => t.metadata.deferred === true)
    .map((t) => t.name);

describe('buildToolDefs — deferred surface (AGENTIC_CLI §7.6)', () => {
  test('top level: deferred tools are excluded from the base surface; tool_search is in', () => {
    const config = makeConfig(0);
    const names = buildToolDefs(config, new Set()).map((t) => t.name);
    for (const d of deferredNames(config)) expect(names).not.toContain(d);
    expect(names).toContain('tool_search');
    // visible primaries whose satellites are deferred stay (no orphans)
    expect(names).toContain('bash_background');
    expect(names).toContain('task');
    expect(names).toContain('edit_file');
  });

  test('a revealed tool re-enters the surface (sticky); others stay excluded', () => {
    const config = makeConfig(0);
    const revealed = new Set(['memory_write']);
    const names = buildToolDefs(config, revealed).map((t) => t.name);
    expect(names).toContain('memory_write');
    expect(names).not.toContain('retrieve_context'); // still deferred, not revealed
  });

  test('subagent (depth > 0): deferral is OFF — the whitelist is the curation', () => {
    const config = makeConfig(1);
    const all = config.toolRegistry
      .list()
      .map((t) => t.name)
      .sort();
    const names = buildToolDefs(config, new Set())
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(all);
  });

  test("tool_search's description carries the generated catalog of unrevealed deferred tools", () => {
    const config = makeConfig(0);
    const ts = buildToolDefs(config, new Set()).find((t) => t.name === 'tool_search');
    expect(ts).toBeDefined();
    const desc = ts?.description ?? '';
    expect(desc).toContain('Deferred tools');
    // every deferred tool is listed by name
    for (const d of deferredNames(config)) expect(desc).toContain(`- ${d} —`);
  });

  test('a revealed tool drops out of the catalog (no longer advertised)', () => {
    const config = makeConfig(0);
    const ts = buildToolDefs(config, new Set(['memory_write'])).find(
      (t) => t.name === 'tool_search',
    );
    expect(ts?.description ?? '').not.toContain('- memory_write —');
  });
});
