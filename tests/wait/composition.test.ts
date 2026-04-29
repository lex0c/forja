import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../src/wait/index.ts';

const tempRoots: string[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];

const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'forja-wait-comp-'));
  tempRoots.push(d);
  return d;
};

// Wrapper around setTimeout so afterEach can clear pending timers
// — otherwise a delayed writeFileSync from an earlier test could
// fire AFTER the temp dir is removed and throw ENOENT into the
// next test's run.
const later = (fn: () => void, ms: number): void => {
  timers.push(setTimeout(fn, ms));
};

afterEach(() => {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('wait_for: any_of', () => {
  test('races sub-conditions; first match wins', async () => {
    // sleep(500) vs file_exists(present) — the file is already there,
    // so file_exists wins immediately (well within the 500ms sleep).
    const dir = mktemp();
    const path = join(dir, 'fast.txt');
    writeFileSync(path, 'x');
    const start = Date.now();
    const r = await waitFor(
      {
        kind: 'any_of',
        conditions: [
          { kind: 'sleep', durationMs: 5000 },
          { kind: 'file_exists', path },
        ],
      },
      { timeoutMs: 10000, pollIntervalMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('any_of');
    expect(r.payload?.matchedKind).toBe('file_exists');
    expect(r.payload?.matchedIndex).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });

  test('cancels losers when winner emerges', async () => {
    // Two file_exists waits; only one file appears. The other should
    // be aborted on winner — we observe via the OUTER timeout NOT
    // firing (the loser would otherwise spin until timeout).
    const dir = mktemp();
    const winner = join(dir, 'win.txt');
    const loser = join(dir, 'lose.txt');
    later(() => writeFileSync(winner, 'x'), 100);
    const start = Date.now();
    const r = await waitFor(
      {
        kind: 'any_of',
        conditions: [
          { kind: 'file_exists', path: loser },
          { kind: 'file_exists', path: winner },
        ],
      },
      { timeoutMs: 30000, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(true);
    expect(r.payload?.matchedIndex).toBe(1);
    // Outer timeout was 30s — if cancellation regressed, this test
    // would still pass (winner resolves), but waitFor would NOT
    // return until the loser settles. We verify the loser was
    // cancelled by checking total elapsed << outer timeout.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('reports timeout when no sub-condition matches', async () => {
    const dir = mktemp();
    const r = await waitFor(
      {
        kind: 'any_of',
        conditions: [
          { kind: 'file_exists', path: join(dir, 'never1.txt') },
          { kind: 'file_exists', path: join(dir, 'never2.txt') },
        ],
      },
      { timeoutMs: 200, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });

  test('empty any_of([]) waits out the timeout', async () => {
    const start = Date.now();
    const r = await waitFor({ kind: 'any_of', conditions: [] }, { timeoutMs: 150 });
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  test('captures matched sub-payload', async () => {
    const dir = mktemp();
    const path = join(dir, 'stable.txt');
    writeFileSync(path, 'x');
    const r = await waitFor(
      {
        kind: 'any_of',
        conditions: [{ kind: 'file_exists', path }],
      },
      { timeoutMs: 1000, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(true);
    // Inner file_exists payload is preserved
    const inner = r.payload?.matchedPayload as { path?: string } | undefined;
    expect(inner?.path).toBe(path);
  });
});

describe('wait_for: all_of', () => {
  test('matches when every sub-condition matches', async () => {
    const dir = mktemp();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'x');
    later(() => writeFileSync(b, 'y'), 100);
    const r = await waitFor(
      {
        kind: 'all_of',
        conditions: [
          { kind: 'file_exists', path: a },
          { kind: 'file_exists', path: b },
        ],
      },
      { timeoutMs: 5000, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('all_of');
    expect(r.payload?.matched).toBe(2);
  });

  test('short-circuits on first failure', async () => {
    // sub[0] times out at 100ms; sub[1] would match at 1000ms.
    // all_of should fail at ~100ms when sub[0] times out, NOT
    // wait for sub[1] (which gets aborted by the short-circuit).
    const dir = mktemp();
    const slowPath = join(dir, 'slow.txt');
    later(() => writeFileSync(slowPath, 'x'), 1000);
    const start = Date.now();
    const r = await waitFor(
      {
        kind: 'all_of',
        conditions: [
          { kind: 'file_exists', path: join(dir, 'never.txt') },
          { kind: 'file_exists', path: slowPath },
        ],
      },
      { timeoutMs: 200, pollIntervalMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(r.matched).toBe(false);
    expect(r.payload?.failedIndex).toBe(0);
    expect(r.payload?.failedKind).toBe('file_exists');
    // Should fail in roughly the timeout window, not wait the full
    // 1s for sub[1]'s file to appear.
    expect(elapsed).toBeLessThan(700);
  });

  test('empty all_of([]) matches immediately', async () => {
    const start = Date.now();
    const r = await waitFor({ kind: 'all_of', conditions: [] }, { timeoutMs: 5000 });
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('all_of');
    expect(r.payload?.matched).toBe(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('reports failed sub payload (which sub failed and why)', async () => {
    const dir = mktemp();
    const r = await waitFor(
      {
        kind: 'all_of',
        conditions: [{ kind: 'file_exists', path: join(dir, 'never.txt') }],
      },
      { timeoutMs: 100, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(false);
    expect(r.payload?.failedIndex).toBe(0);
    expect(r.payload?.failedKind).toBe('file_exists');
  });
});

describe('wait_for: composition error propagation', () => {
  test('any_of surfaces a real sub error instead of silently timing out', async () => {
    // Regression: prior to the fix, any_of's catch on Promise.any
    // swallowed the AggregateError without distinguishing real
    // sub-throws (e.g., bgManager missing for a nested process_*)
    // from synthetic matched=false rejections. Composition would
    // silently report timeout, masking the underlying error.
    expect(
      waitFor(
        {
          kind: 'any_of',
          conditions: [{ kind: 'process_exit', processId: 'no-such-id' }],
        },
        { timeoutMs: 1000, pollIntervalMs: 50 },
      ),
    ).rejects.toThrow(/bgManager/i);
  });

  test('all_of: process_* nested without bgManager fails fast at function entry', async () => {
    // Without the recursive containsProcessKind check, all_of would
    // dispatch sub-waits, each sub would throw, Promise.all would
    // reject — eventually surfacing the error, but with confusing
    // routing (the throw is from sub N, not "your composition needs
    // a manager"). Recursive pre-check fails fast with a clear
    // message at the outer level.
    expect(
      waitFor(
        {
          kind: 'all_of',
          conditions: [
            { kind: 'sleep', durationMs: 100 },
            { kind: 'process_output', processId: 'x', pattern: /y/ },
          ],
        },
        { timeoutMs: 1000, pollIntervalMs: 50 },
      ),
    ).rejects.toThrow(/process_\* condition.*requires options\.bgManager/);
  });

  test('deeply nested process_* triggers recursive bgManager check', async () => {
    // any_of([sleep, all_of([process_exit])]) — two levels deep.
    expect(
      waitFor(
        {
          kind: 'any_of',
          conditions: [
            { kind: 'sleep', durationMs: 100 },
            {
              kind: 'all_of',
              conditions: [{ kind: 'process_exit', processId: 'x' }],
            },
          ],
        },
        { timeoutMs: 1000, pollIntervalMs: 50 },
      ),
    ).rejects.toThrow(/bgManager/i);
  });
});

describe('wait_for: composition nesting', () => {
  test('nested any_of inside all_of', async () => {
    const dir = mktemp();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'x');
    later(() => writeFileSync(b, 'y'), 100);
    // all_of matches when both: A exists AND (sleep(50) OR B exists)
    const r = await waitFor(
      {
        kind: 'all_of',
        conditions: [
          { kind: 'file_exists', path: a },
          {
            kind: 'any_of',
            conditions: [
              { kind: 'sleep', durationMs: 50 },
              { kind: 'file_exists', path: b },
            ],
          },
        ],
      },
      { timeoutMs: 5000, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(true);
  });

  test('aborted signal propagates to all sub-waits', async () => {
    const ac = new AbortController();
    const dir = mktemp();
    const promise = waitFor(
      {
        kind: 'all_of',
        conditions: [
          { kind: 'file_exists', path: join(dir, 'a.txt') },
          { kind: 'file_exists', path: join(dir, 'b.txt') },
        ],
      },
      { timeoutMs: 30000, pollIntervalMs: 50, signal: ac.signal },
    );
    later(() => ac.abort(), 100);
    const start = Date.now();
    const r = await promise;
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('aborted');
    expect(Date.now() - start).toBeLessThan(500);
  });
});
