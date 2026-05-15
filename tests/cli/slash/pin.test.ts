// /pin slash command tests (CONTEXT_TUNING.md §12.4).
//
// Real migrated DB + ContextPinsStore wired through SlashContext —
// exercise the command end-to-end and assert against returned notes
// + persisted rows. Same shape as memory.test.ts for the slash
// surface (and parallels tests/storage/context-pins.test.ts for the
// underlying repo).

import { beforeEach, describe, expect, test } from 'bun:test';
import { pinCommand } from '../../../src/cli/slash/commands/pin.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import {
  type ContextPinsStore,
  PIN_CAP,
  createContextPinsStore,
} from '../../../src/storage/repos/context-pins.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;
let sessionId: string;
let store: ContextPinsStore;
let nowMs: number;

const buildCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const focusStack = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack, now: () => nowMs });
  const baseConfig = {
    cwd: '/p',
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
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0, critiqueRuns: 0 },
    now: () => nowMs,
    requestShutdown: () => {},
    isRunning: () => false,
    currentSessionId: () => sessionId,
    replSessionIds: () => [sessionId],
    modelRegistry: createModelRegistry(),
    contextPinsStore: store,
    ...overrides,
  };
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  store = createContextPinsStore(db);
  nowMs = 1_000_000;
});

describe('/pin: create (happy path)', () => {
  test('persists a single-word pin and reports the active count', async () => {
    const r = await pinCommand.exec(['hello'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.[0]).toContain('[constraint]');
    expect(r.notes?.[0]).toContain('hello');
    expect(r.notes?.[0]).toContain('(1/10 active)');
    expect(store.listPinsBySession(sessionId)).toHaveLength(1);
  });

  test('joins multi-word text with spaces', async () => {
    const r = await pinCommand.exec(
      ['rodar', 'pnpm', 'fmt', 'antes', 'de', 'commitar'],
      buildCtx(),
    );
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const pin = store.listPinsBySession(sessionId)[0];
    expect(pin?.text).toBe('rodar pnpm fmt antes de commitar');
  });

  test('honors --kind flag', async () => {
    const r = await pinCommand.exec(['phase: refactor', '--kind', 'reminder'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    expect(r.notes?.[0]).toContain('[reminder]');
    expect(store.listPinsBySession(sessionId)[0]?.kind).toBe('reminder');
  });

  test('--kind can appear before the text', async () => {
    const r = await pinCommand.exec(
      ['--kind', 'invariant', 'no', 'circular', 'imports'],
      buildCtx(),
    );
    if (r.kind !== 'ok') throw new Error('unexpected');
    const pin = store.listPinsBySession(sessionId)[0];
    expect(pin?.kind).toBe('invariant');
    expect(pin?.text).toBe('no circular imports');
  });

  test('honors --expires-in and stores expires_at', async () => {
    const r = await pinCommand.exec(['transient', '--expires-in', '30m'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    const pin = store.listPinsBySession(sessionId)[0];
    expect(pin?.expiresAt).toBe(nowMs + 30 * 60_000);
  });

  test('pins are tagged created_by=user and have null sourceStepId', async () => {
    await pinCommand.exec(['operator typed this'], buildCtx());
    const pin = store.listPinsBySession(sessionId)[0];
    expect(pin?.createdBy).toBe('user');
    expect(pin?.sourceStepId).toBeNull();
  });
});

describe('/pin --list', () => {
  test('reports empty when no pins', async () => {
    const r = await pinCommand.exec(['--list'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    expect(r.notes?.[0]).toContain('no pins');
  });

  test('lists active pins with header (N/cap)', async () => {
    store.createPin({ sessionId, text: 'first', kind: 'constraint', createdBy: 'user' });
    store.createPin({ sessionId, text: 'second', kind: 'workflow', createdBy: 'user' });
    const r = await pinCommand.exec(['--list'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    expect(r.notes?.[0]).toContain(`(2/${PIN_CAP})`);
    expect(r.notes?.some((l) => l.includes('first'))).toBe(true);
    expect(r.notes?.some((l) => l.includes('second'))).toBe(true);
  });

  test('skips expired pins', async () => {
    store.createPin({
      sessionId,
      text: 'alive',
      kind: 'constraint',
      createdBy: 'user',
      createdAt: nowMs,
    });
    store.createPin({
      sessionId,
      text: 'expired',
      kind: 'reminder',
      createdBy: 'user',
      createdAt: nowMs,
      expiresAt: nowMs - 1,
    });
    const r = await pinCommand.exec(['--list'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    expect(r.notes?.[0]).toContain('(1/');
    expect(r.notes?.some((l) => l.includes('expired'))).toBe(false);
  });

  test('renders "expires in" for active pins with expiry', async () => {
    store.createPin({
      sessionId,
      text: 'transient',
      kind: 'reminder',
      createdBy: 'user',
      createdAt: nowMs,
      expiresAt: nowMs + 30 * 60_000,
    });
    const r = await pinCommand.exec(['--list'], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    const line = r.notes?.find((l) => l.includes('transient'));
    expect(line).toContain('expires in 30m');
  });
});

describe('/pin --remove', () => {
  test('removes an existing pin and reports the short id', async () => {
    const pin = store.createPin({
      sessionId,
      text: 'doomed',
      kind: 'constraint',
      createdBy: 'user',
    });
    const r = await pinCommand.exec(['--remove', pin.id], buildCtx());
    if (r.kind !== 'ok') throw new Error('unexpected');
    expect(r.notes?.[0]).toContain('removed pin');
    expect(store.listPinsBySession(sessionId)).toHaveLength(0);
  });

  test('errors when --remove id is unknown', async () => {
    const r = await pinCommand.exec(['--remove', 'no-such-id'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('no pin with id');
  });

  test('errors when --remove is missing the id', async () => {
    const r = await pinCommand.exec(['--remove'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('needs an id');
  });
});

describe('/pin: validation + mutual exclusivity', () => {
  test('errors with usage when no args', async () => {
    // No args → mode falls through to 'help', which is success-shaped
    // (returns usage notes). Distinct from "missing text" which only
    // fires when create mode is explicit (a non-flag positional).
    const r = await pinCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.some((l) => l.startsWith('usage:'))).toBe(true);
  });

  test('--help shows usage', async () => {
    const r = await pinCommand.exec(['--help'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.some((l) => l.startsWith('usage:'))).toBe(true);
  });

  test('rejects unknown flag', async () => {
    const r = await pinCommand.exec(['hello', '--foo'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('unknown flag');
  });

  test('rejects --kind without value', async () => {
    const r = await pinCommand.exec(['hello', '--kind'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('rejects invalid --kind value', async () => {
    const r = await pinCommand.exec(['hello', '--kind', 'banana'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('invalid kind');
  });

  test('rejects --expires-in without value', async () => {
    const r = await pinCommand.exec(['hello', '--expires-in'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('rejects malformed --expires-in', async () => {
    const r = await pinCommand.exec(['hello', '--expires-in', '30 minutes'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('30m');
  });

  test('rejects positional text with --list', async () => {
    const r = await pinCommand.exec(['--list', 'extra'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('positional text not allowed');
  });

  test('rejects --kind with --list', async () => {
    const r = await pinCommand.exec(['--list', '--kind', 'reminder'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('--kind not allowed');
  });

  test('rejects --list combined with --remove', async () => {
    const r = await pinCommand.exec(['--list', '--remove', 'x'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('cannot combine');
  });

  test('rejects --expires-in with --remove', async () => {
    const r = await pinCommand.exec(['--remove', 'x', '--expires-in', '30m'], buildCtx());
    expect(r.kind).toBe('error');
  });
});

describe('/pin: secret scanner', () => {
  test('refuses text that matches a credential pattern', async () => {
    const r = await pinCommand.exec(['tok', 'AKIAIOSFODNN7EXAMPLE'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('credential pattern');
    expect(store.listPinsBySession(sessionId)).toHaveLength(0);
  });

  test('refuses an Anthropic key shape', async () => {
    const r = await pinCommand.exec(
      ['log', 'line', 'with', 'sk-ant-aaaaaaaaaaaaaaaaaaaa'],
      buildCtx(),
    );
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('credential pattern');
  });

  test('error message does NOT echo the matched credential', async () => {
    const cred = 'AKIAIOSFODNN7EXAMPLE';
    const r = await pinCommand.exec(['tok', cred], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).not.toContain(cred);
  });

  test('does NOT reject injection phrases (operator typed them)', async () => {
    // The whole point of using scanForSecrets vs scanForInjection
    // on the slash surface: a /pin like "ignore previous
    // instructions" can be a legitimate operator note about a
    // model failure mode. The tool path (pin_context) still runs
    // the full scanForInjection per CONTEXT_TUNING.md §12.4
    // discipline; the slash path trusts the operator on phrases.
    const r = await pinCommand.exec(['ignore', 'previous', 'instructions'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(store.listPinsBySession(sessionId)).toHaveLength(1);
  });
});

describe('/pin: cap + unwired surfaces', () => {
  test('reports cap exceeded when 10 pins already exist', async () => {
    for (let i = 0; i < PIN_CAP; i++) {
      store.createPin({
        sessionId,
        text: `existing ${i}`,
        kind: 'constraint',
        createdBy: 'user',
      });
    }
    const r = await pinCommand.exec(['overflow'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('cap reached');
    expect(r.message).toContain(`${PIN_CAP}/${PIN_CAP}`);
  });

  test('refuses when no current session yet', async () => {
    const r = await pinCommand.exec(['hello'], buildCtx({ currentSessionId: () => null }));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('no active session');
  });

  test('refuses when contextPinsStore is unwired', async () => {
    const { contextPinsStore: _omit, ...ctxNoStore } = buildCtx();
    void _omit;
    const r = await pinCommand.exec(['hello'], ctxNoStore);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('pin store unavailable');
  });
});
