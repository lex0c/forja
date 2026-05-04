// History navigation + persistence tests for the REPL editor handler.
// Spec: HISTORY.md §2.1 (↑/↓ + scratch), §1 (storage round-trip).
//
// Pattern: build a real migrated SQLite memory db so submits actually
// hit storage, then assert via loadHistory + the harness userPrompt
// captures (proxies for "what did the buffer contain when Enter
// landed"). Where in-buffer state matters mid-session, capture
// rendererWrite to scrape the live frame text.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { BootstrapResult } from '../../src/cli/bootstrap.ts';
import { runRepl } from '../../src/cli/repl.ts';
import type { HarnessConfig, HarnessEvent, HarnessResult } from '../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { appendHistory, countHistory, loadHistory } from '../../src/storage/history.ts';
import { migrate } from '../../src/storage/migrate.ts';

const PROJECT_CWD = '/tmp/forja-history-repl-test';

const makeArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: '',
  json: false,
  help: false,
  version: false,
  yes: false,
  plan: false,
  listSessions: false,
  includeSubagents: false,
  ...overrides,
});

const makeStdin = (): NodeJS.ReadStream & { feed: (s: string) => void } => {
  const ee = new EventEmitter() as EventEmitter & {
    feed: (s: string) => void;
    resume: () => unknown;
    pause: () => unknown;
  };
  ee.feed = (s: string): void => {
    ee.emit('data', Buffer.from(s, 'utf-8'));
  };
  ee.resume = () => ee;
  ee.pause = () => ee;
  return ee as unknown as NodeJS.ReadStream & { feed: (s: string) => void };
};

const makeBootstrapStubWithDb = (db: DB): BootstrapResult => {
  const config = {
    cwd: PROJECT_CWD,
    userPrompt: '',
    budget: { ...DEFAULT_BUDGET },
    enableCheckpoints: false,
    provider: {
      id: 'mock/m',
      capabilities: { context_window: 200000, output_max_tokens: 4096 },
    },
  } as unknown as HarnessConfig;
  return {
    config,
    db,
    modelId: 'mock/m',
    policyLayers: [],
    lockConflicts: [],
    subagents: { byName: new Map(), shadows: [] } as unknown as BootstrapResult['subagents'],
  };
};

interface CapturedRun {
  configs: HarnessConfig[];
  emit: (event: HarnessEvent) => void;
}

const makeRunAgent = (): {
  runAgent: (cfg: HarnessConfig) => Promise<HarnessResult>;
  captured: CapturedRun[];
  finish: (idx: number) => void;
} => {
  const captured: CapturedRun[] = [];
  let nextN = 1;
  const pendingResolves: Array<() => void> = [];

  return {
    runAgent: (cfg: HarnessConfig): Promise<HarnessResult> => {
      const n = nextN++;
      captured.push({ configs: [cfg], emit: (event) => cfg.onEvent?.(event) });
      return new Promise<HarnessResult>((resolve) => {
        pendingResolves.push(() => {
          const result: HarnessResult = {
            status: 'done',
            reason: 'done',
            sessionId: `sess-${n}`,
            steps: 1,
            durationMs: 1,
            usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
            costUsd: 0,
            usageComplete: true,
          };
          resolve(result);
        });
      });
    },
    captured,
    finish: (idx) => {
      const cap = captured[idx];
      const result: HarnessResult = {
        status: 'done',
        reason: 'done',
        sessionId: `sess-${idx + 1}`,
        steps: 1,
        durationMs: 1,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
      };
      if (cap !== undefined) cap.emit({ type: 'session_finished', result });
      const r = pendingResolves[idx];
      if (r !== undefined) r();
    },
  };
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  delete process.env.FORJA_NO_HISTORY;
});

afterEach(() => {
  process.removeAllListeners('SIGINT');
  delete process.env.FORJA_NO_HISTORY;
});

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

describe('repl — history persistence on submit', () => {
  test('submitting a prompt persists it to repl_history', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed('first prompt\r');
    await tick();
    expect(loadHistory(db, PROJECT_CWD)).toEqual(['first prompt']);
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('back-to-back identical submits collapse via dup-of-last suppression', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed('repeat\r');
    await tick();
    ra.finish(0);
    await tick();
    stdin.feed('repeat\r');
    await tick();
    ra.finish(1);
    await tick();
    expect(countHistory(db, PROJECT_CWD)).toBe(1);
    stdin.feed('\x04');
    await promise;
  });

  test('multi-line buffers are stored verbatim', async () => {
    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // Backslash continuation (UI.md §5.4): `\` + Enter inserts a
    // newline in the editor without submitting.
    stdin.feed('line1\\\rline2\r');
    await tick();
    expect(loadHistory(db, PROJECT_CWD)).toEqual(['line1\nline2']);
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});

describe('repl — ↑/↓ navigation', () => {
  test('preexisting entries from prior session are recallable on boot', async () => {
    appendHistory(db, PROJECT_CWD, 'older', { ts: 1 });
    appendHistory(db, PROJECT_CWD, 'newer', { ts: 2 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // First ↑ recalls newest; Enter submits it.
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('newer');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('repeated ↑ walks to older entries; clamps at oldest', async () => {
    appendHistory(db, PROJECT_CWD, 'oldest', { ts: 1 });
    appendHistory(db, PROJECT_CWD, 'middle', { ts: 2 });
    appendHistory(db, PROJECT_CWD, 'newest', { ts: 3 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // ↑ ↑ ↑ ↑ — three back-walks land on oldest, the fourth clamps.
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('oldest');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('↓ past newest restores the scratch buffer', async () => {
    appendHistory(db, PROJECT_CWD, 'recalled', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // Operator types "draft", presses ↑ (saves "draft" to scratch,
    // recalls "recalled"), then ↓ (past newest, restores "draft"),
    // then Enter — the harness should see "draft", not "recalled".
    stdin.feed('draft');
    await tick();
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed(ARROW_DOWN);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('draft');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('submit resets historyIdx — next ↑ starts from the new newest', async () => {
    appendHistory(db, PROJECT_CWD, 'old', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // Submit "fresh" (becomes newest in the in-memory mirror).
    stdin.feed('fresh\r');
    await tick();
    ra.finish(0);
    await tick();
    // Now ↑ should land on "fresh" (the just-submitted entry), not
    // "old" (which would be the case if historyIdx hadn't reset).
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[1]?.configs[0]?.userPrompt).toBe('fresh');
    ra.finish(1);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('FORJA_NO_HISTORY=1 disables both persistence and recall', async () => {
    process.env.FORJA_NO_HISTORY = '1';
    appendHistory(db, PROJECT_CWD, 'never-seen', { ts: 1 });
    // Pre-existing rows survive but storage no-ops on load.
    expect(loadHistory(db, PROJECT_CWD)).toEqual([]);

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // ↑ on idle does nothing — no entries loaded.
    stdin.feed(ARROW_UP);
    await tick();
    // Submit "live". Storage no-ops so the new prompt does NOT land.
    stdin.feed('live\r');
    await tick();
    expect(loadHistory(db, PROJECT_CWD)).toEqual([]);
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});

const CTRL_R = '\x12'; // 0x12 = Ctrl+R per ASCII control range.
const TAB = '\t';

describe('repl — reverse-search overlay (HISTORY.md §2.2)', () => {
  test('Ctrl+R opens overlay, Enter submits matched entry', async () => {
    appendHistory(db, PROJECT_CWD, 'how to run bun in watch mode', { ts: 1 });
    appendHistory(db, PROJECT_CWD, 'something else entirely', { ts: 2 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Type "watch" — should match "how to run bun in watch mode".
    stdin.feed('watch');
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('how to run bun in watch mode');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Esc cancels overlay without changing the buffer', async () => {
    appendHistory(db, PROJECT_CWD, 'recallable', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    // Operator types "draft", opens reverse-search, types a query, Esc.
    stdin.feed('draft');
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('rec');
    await tick();
    // Two ESCs so the parser's lone-ESC drain doesn't gobble the
    // first byte (matches the existing repl.test.ts pattern); the
    // overlay handler treats the first as Esc and consumes both.
    stdin.feed('\x1b\x1b');
    await tick();
    // Original buffer must still be "draft" — submit with Enter.
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('draft');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Tab accepts to edit: substitutes buffer + closes overlay, no submit', async () => {
    appendHistory(db, PROJECT_CWD, 'editable target', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('edit');
    await tick();
    stdin.feed(TAB);
    await tick();
    // Overlay closed, buffer holds the match. NOT submitted yet — no
    // captured runs.
    expect(ra.captured).toHaveLength(0);
    // Editing: append "!", then Enter.
    stdin.feed('!');
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('editable target!');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Ctrl+R again cycles to older matches with the same query', async () => {
    appendHistory(db, PROJECT_CWD, 'older bash command', { ts: 1 });
    appendHistory(db, PROJECT_CWD, 'middle bash thing', { ts: 2 });
    appendHistory(db, PROJECT_CWD, 'newest bash run', { ts: 3 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('bash');
    await tick();
    // First Ctrl+R press already opened. Now query="bash" with 3
    // matches; selectedIdx=0 = newest. Press Ctrl+R two more times
    // to cycle to oldest.
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('older bash command');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('backspace shortens query and re-runs the search', async () => {
    appendHistory(db, PROJECT_CWD, 'a b c', { ts: 1 });
    appendHistory(db, PROJECT_CWD, 'a only', { ts: 2 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Type "b" → matches only "a b c".
    stdin.feed('b');
    await tick();
    // Backspace → query becomes "" → results empty (empty query
    // never matches per spec). Type "a" → matches both, newest first.
    stdin.feed('\x7f'); // backspace
    await tick();
    stdin.feed('a');
    await tick();
    // Newest match for "a" is "a only" (ts=2); accept with Enter.
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('a only');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Ctrl+R with empty history is a no-op (does not open overlay)', async () => {
    // No appendHistory calls — table is empty.
    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Type "x" then Enter — should submit "x" as a normal prompt
    // (overlay never opened, so chars hit the editor).
    stdin.feed('x\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('x');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('multi-line paste in the query collapses to single-line', async () => {
    appendHistory(db, PROJECT_CWD, 'how are things going on this fine day', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Bracketed-paste sequence with embedded newlines: parser delivers
    // it as a `paste` event whose `text` carries the raw payload. The
    // sanitizer must collapse so the overlay stays single-line.
    stdin.feed('\x1b[200~how\nare\x1b[201~');
    await tick();
    // Should match the seeded entry (substring "how are" after the
    // newline collapsed to "how are"). Accept with Enter to confirm
    // the overlay's state held a usable result.
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('how are things going on this fine day');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Enter with no matches is a no-op (overlay stays open)', async () => {
    appendHistory(db, PROJECT_CWD, 'apple', { ts: 1 });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(db),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('xyz'); // no matches
    await tick();
    stdin.feed('\r');
    await tick();
    // No turn started.
    expect(ra.captured).toHaveLength(0);
    // Esc Esc (parser drains both as discrete escape events; first
    // closes the overlay, second is consumed by the editor as a
    // would-be soft interrupt — no-op while idle), then ^D to exit.
    stdin.feed('\x1b\x1b');
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});
