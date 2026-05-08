import { describe, expect, test } from 'bun:test';
import { buildPlaybookSlashCommands } from '../../../../src/cli/slash/commands/playbook.ts';
import type { PlaybookDispatcher, SlashContext } from '../../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../../src/providers/registry.ts';
import { openMemoryDb } from '../../../../src/storage/db.ts';
import { migrate } from '../../../../src/storage/migrate.ts';
import type { RunSubagentResult } from '../../../../src/subagents/index.ts';
import type { SubagentDefinition } from '../../../../src/subagents/types.ts';
import { createBus } from '../../../../src/tui/bus.ts';
import { createFocusStack } from '../../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../../src/tui/modal-manager.ts';

// Minimal definition factory. Mirrors the shape exercised by the
// playbook-prompt tests so the two suites stay legible side-by-side.
const makeDef = (
  name: string,
  overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition => ({
  name,
  description: `${name} description`,
  tools: [],
  budget: { maxSteps: 1, maxCostUsd: 0.01 },
  systemPrompt: 'body',
  scope: 'user',
  isolation: 'none',
  sourcePath: `/fake/${name}.md`,
  sourceSha256: 'a'.repeat(64),
  meta: {},
  ...overrides,
});

interface CtxOpts {
  runPlaybook?: PlaybookDispatcher;
  isRunning?: boolean;
  sessionId?: string | null;
}

const makeCtx = (opts: CtxOpts = {}): SlashContext => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  const baseConfig = {
    cwd: '/test',
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0 },
    now: () => 1,
    requestShutdown: () => {},
    isRunning: () => opts.isRunning ?? false,
    currentSessionId: () => opts.sessionId ?? null,
    modelRegistry: createModelRegistry(),
    ...(opts.runPlaybook !== undefined ? { runPlaybook: opts.runPlaybook } : {}),
  };
};

const fakeDoneResult = (output: string): RunSubagentResult => ({
  output,
  sessionId: 'sess-fake',
  status: 'done',
  reason: 'done',
  costUsd: 0.01234,
  steps: 3,
  durationMs: 250,
});

describe('buildPlaybookSlashCommands', () => {
  test('returns empty array when no defs are provided', () => {
    expect(buildPlaybookSlashCommands([])).toEqual([]);
  });

  test('skips defs without a slash field', () => {
    // Generic subagents (`agents/explore.md` legacy shape) without
    // `slash` participate in `task_*` routing but contribute no
    // operator-facing surface. Filtering at the factory layer
    // keeps the registry free of nameless entries that would
    // otherwise break `createRegistry`'s lookup contract.
    const defs = [makeDef('explore'), makeDef('code-review', { slash: 'review' })];
    const cmds = buildPlaybookSlashCommands(defs);
    expect(cmds.map((c) => c.name)).toEqual(['review']);
  });

  test('orders commands alphabetically by slash name', () => {
    // Stable order matters because /help renders commands top-
    // to-bottom and an operator who tabs through `complete('')`
    // expects a predictable sequence regardless of which scope
    // contributed which def.
    const defs = [
      makeDef('refactor', { slash: 'refactor' }),
      makeDef('code-review', { slash: 'review' }),
      makeDef('debug', { slash: 'debug' }),
      makeDef('explain', { slash: 'explain' }),
    ];
    const cmds = buildPlaybookSlashCommands(defs);
    expect(cmds.map((c) => c.name)).toEqual(['debug', 'explain', 'refactor', 'review']);
  });

  test('description includes the canonical playbook name in parens', () => {
    // /help reads "review — Review code (playbook code-review)" so
    // the operator can tell `/review` from any builtin sharing the
    // word. Without this hint the slash-vs-name indirection is
    // invisible at the help surface.
    const defs = [makeDef('code-review', { slash: 'review' })];
    const cmd = buildPlaybookSlashCommands(defs)[0];
    expect(cmd?.description).toContain('(playbook code-review)');
  });
});

describe('playbook slash command exec — preconditions', () => {
  const def = makeDef('code-review', { slash: 'review' });

  test('empty args refused with usage hint', async () => {
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec([], makeCtx());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('/review requires a prompt');
    expect(result.message).toContain('code-review');
  });

  test('missing runPlaybook bridge surfaces "dispatch unavailable"', async () => {
    // Headless / test contexts that don't wire the bridge. The
    // command stays registered (so /help shows it) but explicitly
    // refuses dispatch — silent no-op would be a worse footgun.
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec(['some prompt'], makeCtx({}));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('cannot dispatch');
    expect(result.message).toContain('not wired');
  });

  test('isRunning=true refuses dispatch', async () => {
    // Slash dispatch while a foreground turn is in flight would
    // race the provider/permission engine. Refusing here is the
    // friendlier UX.
    let dispatched = false;
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec(
      ['some prompt'],
      makeCtx({
        isRunning: true,
        runPlaybook: async () => {
          dispatched = true;
          return fakeDoneResult('');
        },
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('turn or playbook is in progress');
    expect(dispatched).toBe(false);
  });
});

describe('playbook slash command exec — happy path', () => {
  test('forwards canonical name + joined prompt to runPlaybook', async () => {
    // Holder object so TS's flow analysis (which doesn't narrow
    // through async callbacks) doesn't keep `captured` typed as
    // `null` after the dispatch resolves.
    const captured: { value: { name: string; prompt: string } | null } = { value: null };
    const def = makeDef('code-review', { slash: 'review' });
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec(
      ['the', 'whole', 'prompt'],
      makeCtx({
        runPlaybook: async (input) => {
          captured.value = input;
          return fakeDoneResult('Looks good.');
        },
      }),
    );
    expect(captured.value).toEqual({ name: 'code-review', prompt: 'the whole prompt' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Notes shape: header line with the verdict, blank, then the
    // playbook output. Asserting structure so a future renderer
    // tweak doesn't silently drop the body.
    expect(result.notes?.[0]).toContain('/review finished');
    expect(result.notes?.[0]).toContain('3 step(s)');
    expect(result.notes?.[0]).toContain('$0.0123');
    expect(result.notes?.[0]).toContain('250ms');
    expect(result.notes?.[1]).toBe('');
    expect(result.notes?.[2]).toBe('Looks good.');
  });

  test('renders empty output as a placeholder so the row is visible', async () => {
    const def = makeDef('code-review', { slash: 'review' });
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec(
      ['p'],
      makeCtx({
        runPlaybook: async () => fakeDoneResult(''),
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[2]).toBe('(no output produced)');
  });

  test('non-done status shown in the verdict line', async () => {
    const def = makeDef('debug', { slash: 'debug' });
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    const result = await cmd.exec(
      ['investigate'],
      makeCtx({
        runPlaybook: async () => ({
          output: 'Stopped mid-step.',
          sessionId: 'x',
          status: 'exhausted',
          reason: 'maxSteps',
          costUsd: 0.5,
          steps: 35,
          durationMs: 12_000,
        }),
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('exhausted');
    expect(result.notes?.[0]).toContain('maxSteps');
    expect(result.notes?.[0]).toContain('35 step(s)');
  });

  test('runPlaybook throws → exec lets the error bubble (dispatch wraps it)', async () => {
    // Playbook commands don't try-catch the bridge: the dispatch
    // layer (`dispatch` in slash/index.ts) already turns thrown
    // exceptions into `kind:error` with `crashed` in the message.
    // Re-catching here would lose the existing audit attribution.
    const def = makeDef('code-review', { slash: 'review' });
    const cmd = buildPlaybookSlashCommands([def])[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;
    let threw = false;
    try {
      await cmd.exec(
        ['p'],
        makeCtx({
          runPlaybook: async () => {
            throw new Error('downstream blew up');
          },
        }),
      );
    } catch (e) {
      threw = true;
      expect(e instanceof Error ? e.message : String(e)).toBe('downstream blew up');
    }
    expect(threw).toBe(true);
  });
});
