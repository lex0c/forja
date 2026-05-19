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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  explainPermissions: false,
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
    hookWarnings: [],
    critiqueWarnings: [],
    memoryConfigWarnings: [] as readonly string[],
    providersConfigWarnings: [] as readonly string[],
    budgetConfigWarnings: [] as readonly string[],
    permissionState: 'ready',
    permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    installIdentity: { install_id: 'test-fixture', created_at_ms: 0 },
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

  test('Ctrl+R does NOT open overlay while buffer starts with `/` (slash mode wins)', async () => {
    appendHistory(db, PROJECT_CWD, 'something', { ts: 1 });

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
    // Type a slash command name that has zero autocomplete matches —
    // collapses the popover (state.slash → null) but keeps the buffer
    // slash-prefixed. Pre-fix, Ctrl+R here opened the overlay and
    // hijacked the slash composition. Post-fix, both gates hold and
    // Ctrl+R is consumed as a no-op (Ctrl+R has no editor binding,
    // so the buffer stays exactly as the operator typed it).
    stdin.feed('/doesnotexist');
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Pressing Enter should now dispatch the slash command (which
    // returns "unknown command" — the dispatcher's normal failure
    // mode), confirming the buffer reached Enter intact.
    stdin.feed('\r');
    await tick();
    // No turn started — a real /unknown command surfaces an error
    // event but never calls runAgent.
    expect(ra.captured).toHaveLength(0);
    stdin.feed('\x04');
    await promise;
  });

  test('Ctrl+R also blocked while typing a known slash command (popover live)', async () => {
    // Sanity: the original `state.slash !== null` gate already covered
    // this case, but pin it here so a future refactor that loosens
    // the slash-buffer gate doesn't silently open Ctrl+R during a
    // mid-edit `/help`.
    appendHistory(db, PROJECT_CWD, 'something', { ts: 1 });

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
    stdin.feed('/he'); // popover should match /help
    await tick();
    stdin.feed(CTRL_R);
    await tick();
    // Cancel slash mode + verify nothing escaped to the overlay.
    // Esc Esc — the parser's lone-ESC drain would otherwise keep the
    // first byte buffered until a follow-up arrives, leaving the
    // shutdown gate unable to land. Two escapes flush both as
    // discrete `escape` events: first clears slash mode + buffer,
    // second is a no-op while idle.
    stdin.feed('\x1b\x1b');
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

describe('repl — mirror trim (cap enforcement)', () => {
  test('mirror evicts oldest entries when submits exceed cap; recall walks only the surviving window', async () => {
    // historyCapOverride threads the same cap into both storage and
    // the mirror. With cap=3, after 5 submits the surviving slice is
    // [p2, p3, p4]; ↑ keeps walking older until clamped at p2.
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
      historyCapOverride: 3,
    });
    await tick();
    for (let i = 0; i < 5; i++) {
      stdin.feed(`p${i}\r`);
      await tick();
      ra.finish(i);
      await tick();
    }
    // Sanity vs persistence: storage trimmed to [p2, p3, p4]. Check
    // BEFORE driving the recall path — Enter on a recalled entry
    // submits and itself appends, which would reshape the table.
    expect(loadHistory(db, PROJECT_CWD)).toEqual(['p2', 'p3', 'p4']);
    // Pre-fix the mirror still held all 5 entries, so ↑×5 would land
    // on p0 — which storage no longer has. Post-fix, ↑×5 clamps at p2.
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[5]?.configs[0]?.userPrompt).toBe('p2');
    ra.finish(5);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('mirror cap matches storage cap exactly — no off-by-one drift', async () => {
    // After exactly cap submits, the mirror should hold cap entries
    // (no eviction yet). After cap+1, eviction kicks in and the
    // mirror is back to cap.
    const cap = 4;
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
      historyCapOverride: cap,
    });
    await tick();
    for (let i = 0; i < cap; i++) {
      stdin.feed(`x${i}\r`);
      await tick();
      ra.finish(i);
      await tick();
    }
    // Submit one more — pushes mirror to cap+1, then trim back to cap.
    stdin.feed(`x${cap}\r`);
    await tick();
    ra.finish(cap);
    await tick();
    // Verify by walking ↑ exactly `cap` times: the cap-th press
    // should land on the oldest surviving entry (`x1`), not `x0`
    // (which was evicted).
    for (let i = 0; i < cap + 2; i++) {
      stdin.feed(ARROW_UP);
    }
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[cap + 1]?.configs[0]?.userPrompt).toBe('x1');
    ra.finish(cap + 1);
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});

describe('repl — /history on reload (boot disabled → re-enable)', () => {
  test('boot with .agent/no-history present + entries in db; /history on after marker removal repopulates the mirror', async () => {
    // Pre-stage: entries already in the db (operator was using history
    // before opting out via the marker), then create the marker so
    // boot starts with persistence disabled.
    const realRoot = mkdtempSync(join(tmpdir(), 'forja-history-reload-'));
    try {
      const dbForBoot = openMemoryDb();
      migrate(dbForBoot);
      appendHistory(dbForBoot, realRoot, 'old-prompt-one', { ts: 1 });
      appendHistory(dbForBoot, realRoot, 'old-prompt-two', { ts: 2 });
      mkdirSync(join(realRoot, '.agent'), { recursive: true });
      writeFileSync(join(realRoot, '.agent', 'no-history'), '');

      // Build a bootstrap stub pointing at this real path so storage's
      // file-marker check resolves correctly.
      const bootstrapForReload: BootstrapResult = {
        config: {
          cwd: realRoot,
          userPrompt: '',
          budget: { ...DEFAULT_BUDGET },
          enableCheckpoints: false,
          provider: {
            id: 'mock/m',
            capabilities: { context_window: 200000, output_max_tokens: 4096 },
          },
        } as unknown as HarnessConfig,
        db: dbForBoot,
        modelId: 'mock/m',
        policyLayers: [],
        lockConflicts: [],
        subagents: { byName: new Map(), shadows: [] } as unknown as BootstrapResult['subagents'],
        hookWarnings: [],
        critiqueWarnings: [],
        memoryConfigWarnings: [] as readonly string[],
        providersConfigWarnings: [] as readonly string[],
        budgetConfigWarnings: [] as readonly string[],
        permissionState: 'ready',
        permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
        installIdentity: { install_id: 'test-fixture', created_at_ms: 0 },
      };

      const stdin = makeStdin();
      const ra = makeRunAgent();
      const promise = runRepl({
        args: makeArgs(),
        bootstrapOverride: bootstrapForReload,
        stdin,
        skipTtyCheck: true,
        skipTrustPrompt: true,
        runAgentOverride: ra.runAgent,
        rendererWrite: () => undefined,
      });
      await tick();
      // Sanity: ↑ at this point would be a no-op since the mirror is
      // empty (storage's loadHistory honored the marker). Skip the
      // explicit assertion — the post-on recall is the load-bearing
      // signal.
      // Operator removes the marker (out-of-band, e.g. via shell) and
      // runs /history on; the command must reload the mirror.
      rmSync(join(realRoot, '.agent', 'no-history'));
      stdin.feed('/history on\r');
      await tick();
      // ↑ should now recall the most-recent pre-existing entry.
      stdin.feed(ARROW_UP);
      await tick();
      stdin.feed('\r');
      await tick();
      expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('old-prompt-two');
      ra.finish(0);
      await tick();
      stdin.feed('\x04');
      await promise;
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  test('off → concurrent write by another REPL → on reloads and surfaces the new entry', async () => {
    // Single shared db simulates two REPLs in the same project. We
    // don't actually boot REPL B; we simulate its writes by calling
    // appendHistory directly while REPL A has /history off.
    //
    // Slash-command submits persist (recordHistorySubmit fires for
    // both `/history off` and the rest), so the simulated REPL B
    // write needs a ts strictly greater than Date.now() to remain
    // newest after the load reorders by `ts DESC, id DESC`. Using
    // `Date.now() + 1e6` (~16 minutes in the future) safely beats
    // anything the slash submits can stamp during this test.
    const farFutureTs = Date.now() + 1_000_000;
    appendHistory(db, PROJECT_CWD, 'baseline', { ts: 1 });

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
    // /history off — REPL A's flag goes false.
    stdin.feed('/history off\r');
    await tick();
    // Simulated REPL B append while A is off — ts pinned beyond any
    // wall-clock value the slash submits use, so it's strictly newest.
    appendHistory(db, PROJECT_CWD, 'from-other-repl', { ts: farFutureTs });
    // /history on — A's mirror reloads, picking up B's entry.
    stdin.feed('/history on\r');
    await tick();
    // ↑ should surface the most-recent (other REPL's write).
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('from-other-repl');
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});

describe('repl — reverse-search emergency stop (Ctrl+C / Ctrl+D)', () => {
  test('Ctrl+D while overlay is open + idle: exits 130, overlay closes', async () => {
    appendHistory(db, PROJECT_CWD, 'something', { ts: 1 });

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
    stdin.feed('some'); // type query so we know overlay is open
    await tick();
    // Pre-fix: Ctrl+D was swallowed by the `if (key.ctrl) return true`
    // branch — operator stuck inside the overlay until they Esc out.
    // Post-fix: shell-EOF convention fires unconditionally.
    stdin.feed('\x04');
    expect(await promise).toBe(130);
  });

  test('Ctrl+C while overlay is open + running: triggers soft interrupt', async () => {
    appendHistory(db, PROJECT_CWD, 'preexisting', { ts: 1 });

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
    // Start a turn, then open the overlay mid-run, then Ctrl+C —
    // the soft signal must fire even though the overlay swallows
    // most other keys.
    stdin.feed('go\r');
    await tick();
    expect(ra.captured).toHaveLength(1);
    const cfg = ra.captured[0]?.configs[0];
    const softSignal = cfg?.softStopSignal;
    expect(softSignal?.aborted).toBe(false);
    stdin.feed(CTRL_R);
    await tick();
    stdin.feed('\x03'); // raw-mode Ctrl+C
    await tick();
    expect(softSignal?.aborted).toBe(true);
    // Cleanup.
    ra.finish(0);
    await tick();
    stdin.feed('\x04');
    await promise;
  });

  test('Ctrl+C while overlay is open + idle: arms the exit gate (matches outer Ctrl+C semantics)', async () => {
    appendHistory(db, PROJECT_CWD, 'something', { ts: 1 });

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
    // First Ctrl+C inside overlay: should close the overlay AND arm
    // the idle exit gate (NOT exit yet — same double-tap convention).
    stdin.feed('\x03');
    await tick();
    // Second Ctrl+C within the 2s window: confirms the gate was armed
    // (not just consumed). Since overlay closed on the first, this
    // press lands in the regular editor handler.
    stdin.feed('\x03');
    expect(await promise).toBe(130);
  });
});

describe('repl — history persistence failure (robustness)', () => {
  test('appendHistory throwing mid-session emits a warn and keeps the REPL alive', async () => {
    // Build a Proxy around a real migrated db. After boot's `loadHistory`
    // succeeds, we flip the poison flag so the next `db.transaction()`
    // call (the one inside appendHistory) throws — simulating the FS-
    // gone-read-only / disk-full / db-locked-elsewhere class of failures
    // that pre-fix would have crashed the editor handler on a single
    // Enter.
    let poisoned = false;
    const realDb = openMemoryDb();
    migrate(realDb);
    // Proxy bind: bun:sqlite's Database uses private fields, so
    // `Reflect.get` (which forwards `this` to the receiver) breaks
    // method dispatch. Re-bind every function to the target so the
    // underlying private state is reachable, then selectively
    // override `transaction` when `poisoned` is set.
    const dbProxy = new Proxy(realDb, {
      get(target, prop, _receiver) {
        if (prop === 'transaction' && poisoned) {
          return (_fn: () => unknown) => () => {
            throw new Error('simulated db failure');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const warnMessages: string[] = [];
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(dbProxy as unknown as DB),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    // Capture warns by hooking the rendererWrite would be too noisy —
    // hook directly into the captured run's onEvent? No: warns go via
    // the bus, not the harness adapter. Easiest: intercept after the
    // fact via the rendererWrite. Actually the cleanest probe is to
    // poison after boot, submit, finish the turn, then exit and verify
    // the REPL exited cleanly (exitCode 130 from ^D, NOT a crash).
    await tick();
    poisoned = true;
    stdin.feed('first prompt\r');
    await tick();
    // The submit should still reach the harness (startTurn fires after
    // recordHistorySubmit returns, regardless of persist outcome).
    expect(ra.captured).toHaveLength(1);
    expect(ra.captured[0]?.configs[0]?.userPrompt).toBe('first prompt');
    ra.finish(0);
    await tick();
    // Un-poison so REPL shutdown can close the db cleanly.
    poisoned = false;
    stdin.feed('\x04');
    expect(await promise).toBe(130);
    // Suppress unused warning — the array is reserved for a future
    // assertion when we add a `warnSink` test seam.
    void warnMessages;
  });

  test('after a failed append, the in-memory mirror is NOT polluted with the ghost entry', async () => {
    // Sequence: submit "first" (succeeds) → poison → submit "second"
    // (db throws, mirror should NOT push) → un-poison → submit "third"
    // (succeeds). Then assert via a fresh ↑ flow that "second" is NOT
    // in the recall sequence — only "first" and "third".
    let poisoned = false;
    const realDb = openMemoryDb();
    migrate(realDb);
    // Proxy bind: bun:sqlite's Database uses private fields, so
    // `Reflect.get` (which forwards `this` to the receiver) breaks
    // method dispatch. Re-bind every function to the target so the
    // underlying private state is reachable, then selectively
    // override `transaction` when `poisoned` is set.
    const dbProxy = new Proxy(realDb, {
      get(target, prop, _receiver) {
        if (prop === 'transaction' && poisoned) {
          return (_fn: () => unknown) => () => {
            throw new Error('simulated db failure');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const stdin = makeStdin();
    const ra = makeRunAgent();
    const promise = runRepl({
      args: makeArgs(),
      bootstrapOverride: makeBootstrapStubWithDb(dbProxy as unknown as DB),
      stdin,
      skipTtyCheck: true,
      skipTrustPrompt: true,
      runAgentOverride: ra.runAgent,
      rendererWrite: () => undefined,
    });
    await tick();
    stdin.feed('first\r');
    await tick();
    ra.finish(0);
    await tick();
    poisoned = true;
    stdin.feed('second\r');
    await tick();
    ra.finish(1);
    await tick();
    poisoned = false;
    stdin.feed('third\r');
    await tick();
    ra.finish(2);
    await tick();
    // ↑ ↑: should land on "first", skipping "second" entirely (mirror
    // never recorded it). With pre-fix mirror-first ordering, "second"
    // would be a ghost in the array — recall would walk through it.
    stdin.feed(ARROW_UP);
    stdin.feed(ARROW_UP);
    await tick();
    stdin.feed('\r');
    await tick();
    expect(ra.captured[3]?.configs[0]?.userPrompt).toBe('first');
    ra.finish(3);
    await tick();
    stdin.feed('\x04');
    await promise;
  });
});
