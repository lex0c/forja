// /history command tests. Spec: HISTORY.md §2.3.
//
// Pattern matches dispatch.test.ts: build a SlashContext with a real
// migrated SQLite memory db, append history rows directly via storage
// API, exercise the command, assert against the returned notes and
// the db state.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyCommand } from '../../../src/cli/slash/commands/history.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { appendHistory, countHistory } from '../../../src/storage/history.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import type { HistoryClearAnswer, HistoryClearAskArgs } from '../../../src/tui/modal-manager.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

interface HistoryStub {
  enabled: boolean;
  cleared: boolean;
  optOut: 'env' | 'file-marker' | null;
}

const makeCtx = (
  cwd: string,
  options: {
    historyAnswer?: HistoryClearAnswer;
    historyAskCalls?: HistoryClearAskArgs[];
  } = {},
): { ctx: SlashContext; db: DB; stub: HistoryStub } => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  // Override askHistoryClear so tests don't need a focus-stack
  // listener. The real path is exercised in modal-manager.test.ts.
  if (options.historyAnswer !== undefined) {
    const stack = options.historyAskCalls ?? [];
    (
      modalManager as unknown as { askHistoryClear: typeof modalManager.askHistoryClear }
    ).askHistoryClear = async (args) => {
      stack.push(args);
      return options.historyAnswer ?? 'no';
    };
  }
  const db = openMemoryDb();
  migrate(db);
  const baseConfig = {
    cwd,
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: {
      id: 'test/m',
      capabilities: { context_window: 1000, output_max_tokens: 100 },
    },
  } as unknown as HarnessConfig;
  const stub: HistoryStub = { enabled: true, cleared: false, optOut: null };
  return {
    ctx: {
      baseConfig,
      db,
      bus,
      modalManager,
      cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0, critiqueRuns: 0 },
      now: () => 1,
      requestShutdown: () => {},
      isRunning: () => false,
      currentSessionId: () => null,
      replSessionIds: () => [],
      modelRegistry: createModelRegistry(),
      history: {
        isEnabled: () => stub.enabled,
        setEnabled: (enabled) => {
          stub.enabled = enabled;
        },
        clearLocal: () => {
          stub.cleared = true;
        },
        optOutReason: () => stub.optOut,
      },
    },
    db,
    stub,
  };
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-slash-history-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.FORJA_NO_HISTORY;
});

describe('/history (summary)', () => {
  test('reports entry count + persistence hint when history is on', async () => {
    const { ctx, db } = makeCtx(tmpRoot);
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    appendHistory(db, tmpRoot, 'b', { ts: 2 });
    const result = await historyCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('2 entries');
    expect(result.notes?.[0]).toContain('cap ');
    expect(result.notes?.[0]).toContain('/history list');
  });

  test('summary surfaces session-OFF state explicitly', async () => {
    const { ctx, stub } = makeCtx(tmpRoot);
    stub.enabled = false;
    const result = await historyCommand.exec([], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('persistence is OFF');
  });
});

describe('/history list', () => {
  test('lists entries oldest-first within the block', async () => {
    const { ctx, db } = makeCtx(tmpRoot);
    appendHistory(db, tmpRoot, 'first', { ts: 1 });
    appendHistory(db, tmpRoot, 'second', { ts: 2 });
    appendHistory(db, tmpRoot, 'third', { ts: 3 });
    const result = await historyCommand.exec(['list'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const notes = result.notes ?? [];
    expect(notes[0]).toContain('recent history');
    expect(notes[1]).toContain('first');
    expect(notes[2]).toContain('second');
    expect(notes[3]).toContain('third');
  });

  test('empty history shows a friendly placeholder', async () => {
    const { ctx } = makeCtx(tmpRoot);
    const result = await historyCommand.exec(['list'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.notes?.[0]).toContain('no history entries');
  });

  test('multi-line prompts collapse to single visual rows in list output', async () => {
    const { ctx, db } = makeCtx(tmpRoot);
    appendHistory(db, tmpRoot, 'line one\nline two', { ts: 1 });
    const result = await historyCommand.exec(['list'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const row = result.notes?.[1] ?? '';
    expect(row).not.toContain('\n');
    expect(row).toContain('line one line two');
  });
});

describe('/history clear', () => {
  test('--yes flag wipes immediately, no modal', async () => {
    const askCalls: HistoryClearAskArgs[] = [];
    const { ctx, db, stub } = makeCtx(tmpRoot, {
      historyAnswer: 'cancel',
      historyAskCalls: askCalls,
    });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    appendHistory(db, tmpRoot, 'b', { ts: 2 });
    const result = await historyCommand.exec(['clear', '--yes'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(askCalls).toHaveLength(0);
    expect(countHistory(db, tmpRoot)).toBe(0);
    expect(stub.cleared).toBe(true);
    expect(result.notes?.[0]).toContain('cleared');
  });

  test('-y short flag also skips the modal', async () => {
    const { ctx, db } = makeCtx(tmpRoot, { historyAnswer: 'cancel' });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    await historyCommand.exec(['clear', '-y'], ctx);
    expect(countHistory(db, tmpRoot)).toBe(0);
  });

  test('clear on empty history short-circuits without modal', async () => {
    const askCalls: HistoryClearAskArgs[] = [];
    const { ctx } = makeCtx(tmpRoot, {
      historyAnswer: 'yes',
      historyAskCalls: askCalls,
    });
    const result = await historyCommand.exec(['clear'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(askCalls).toHaveLength(0);
    expect(result.notes?.[0]).toContain('nothing to clear');
  });

  test('modal "yes" answer wipes', async () => {
    const askCalls: HistoryClearAskArgs[] = [];
    const { ctx, db, stub } = makeCtx(tmpRoot, {
      historyAnswer: 'yes',
      historyAskCalls: askCalls,
    });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    const result = await historyCommand.exec(['clear'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]?.entryCount).toBe(1);
    expect(askCalls[0]?.projectRoot).toBe(tmpRoot);
    expect(countHistory(db, tmpRoot)).toBe(0);
    expect(stub.cleared).toBe(true);
    // Plain wipe — should NOT have written the file marker.
    expect(existsSync(join(tmpRoot, '.agent', 'no-history'))).toBe(false);
  });

  test('modal "yes-disable" answer wipes AND writes .agent/no-history marker', async () => {
    const { ctx, db, stub } = makeCtx(tmpRoot, { historyAnswer: 'yes-disable' });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    appendHistory(db, tmpRoot, 'b', { ts: 2 });
    const result = await historyCommand.exec(['clear'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countHistory(db, tmpRoot)).toBe(0);
    expect(existsSync(join(tmpRoot, '.agent', 'no-history'))).toBe(true);
    // Session flag flipped to match the new permanent state.
    expect(stub.enabled).toBe(false);
    expect(result.notes?.some((n) => n.includes('persistence disabled'))).toBe(true);
  });

  test('modal "no" answer leaves history intact', async () => {
    const { ctx, db, stub } = makeCtx(tmpRoot, { historyAnswer: 'no' });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    const result = await historyCommand.exec(['clear'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countHistory(db, tmpRoot)).toBe(1);
    expect(stub.cleared).toBe(false);
    expect(result.notes?.[0]).toContain('cancelled');
  });

  test('modal "cancel" (Esc) is treated like no — no wipe', async () => {
    const { ctx, db } = makeCtx(tmpRoot, { historyAnswer: 'cancel' });
    appendHistory(db, tmpRoot, 'a', { ts: 1 });
    const result = await historyCommand.exec(['clear'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countHistory(db, tmpRoot)).toBe(1);
  });
});

describe('/history off / on', () => {
  test('off flips the session flag to false', async () => {
    const { ctx, stub } = makeCtx(tmpRoot);
    expect(stub.enabled).toBe(true);
    const result = await historyCommand.exec(['off'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(stub.enabled).toBe(false);
    expect(result.notes?.[0]).toContain('off');
  });

  test('on re-enables', async () => {
    const { ctx, stub } = makeCtx(tmpRoot);
    stub.enabled = false;
    await historyCommand.exec(['on'], ctx);
    expect(stub.enabled).toBe(true);
  });

  test('on refuses when env opt-out is active', async () => {
    const { ctx, stub } = makeCtx(tmpRoot);
    stub.enabled = false;
    stub.optOut = 'env';
    const result = await historyCommand.exec(['on'], ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(stub.enabled).toBe(false); // NOT flipped back on
    expect(result.notes?.[0]).toContain('FORJA_NO_HISTORY');
  });

  test('on refuses when .agent/no-history marker is present', async () => {
    const { ctx, stub } = makeCtx(tmpRoot);
    stub.enabled = false;
    stub.optOut = 'file-marker';
    const result = await historyCommand.exec(['on'], ctx);
    if (result.kind !== 'ok') return;
    expect(stub.enabled).toBe(false);
    expect(result.notes?.[0]).toContain('.agent/no-history');
  });
});

describe('/history (errors)', () => {
  test('unknown subcommand surfaces a clear error', async () => {
    const { ctx } = makeCtx(tmpRoot);
    const result = await historyCommand.exec(['hammer'], ctx);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown subcommand');
    expect(result.message).toContain('hammer');
  });
});
