// §13.7 self-exec entry — pins the env-driven worker dispatch in
// `src/cli/index.ts` so a future refactor that reorders the
// early-exit block (e.g. moves it after parseArgs, or replaces it
// with a verb-style dispatcher) doesn't silently regress compiled-
// binary sandbox enforcement.
//
// The compiled-binary path can't address its own embedded
// `/$bunfs/.../worker.ts` via `bun run`, so the spawn broker
// re-invokes `process.execPath` with `FORJA_BROKER_WORKER=1`.
// `index.ts` MUST detect the flag before parseArgs (the worker
// process gets zero CLI args and would otherwise hit the
// empty-prompt REPL gate) and dispatch to the worker module's
// exported entry. This test exercises that path end-to-end through
// the real `createSpawnBroker` pipeline.
//
// Source-checkout path (`bun run src/broker/worker.ts`) lives in
// `tests/broker/cancellation.test.ts:'end-to-end ...'`; that test
// covers the entry via `import.meta.main`. Together the two tests
// pin both invocation paths.
import { describe, expect, test } from 'bun:test';
import { createSpawnBroker } from '../../src/broker/index.ts';

describe('§13.7 broker self-exec via FORJA_BROKER_WORKER env flag', () => {
  test('spawn `src/cli/index.ts` with the env flag routes through runWorkerProcess', async () => {
    const broker = createSpawnBroker({
      command: process.execPath,
      args: ['run', 'src/cli/index.ts'],
      env: {
        ...process.env,
        FORJA_BROKER_WORKER: '1',
      } as Record<string, string>,
      timeoutMs: 30_000,
    });
    try {
      const r = await broker.execute({
        toolName: '__echo__',
        args: { roundtrip: 'ok' },
        capabilities: [],
        sandboxProfile: null,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        // __echo__ handler reflects the request fields verbatim;
        // a non-echo response would mean the entry-point dispatch
        // hit a different code path.
        const echoed = JSON.parse(r.stdout) as Record<string, unknown>;
        expect(echoed.toolName).toBe('__echo__');
        expect(echoed.args).toEqual({ roundtrip: 'ok' });
      }
    } finally {
      await broker.close();
    }
  });

  test('without the env flag, `src/cli/index.ts` falls through to normal CLI (no worker dispatch)', async () => {
    // Sanity-check the early-exit gate: without FORJA_BROKER_WORKER,
    // index.ts must NOT consume stdin as a BrokerRequest. We invoke
    // with --version (a fast no-side-effects verb) and expect the
    // CLI's normal output, not a broker response envelope. The
    // assertion guards against an accidental "always dispatch to
    // worker" inversion of the env check.
    const proc = Bun.spawn([process.execPath, 'run', 'src/cli/index.ts', '--version'], {
      env: { ...process.env, FORJA_BROKER_WORKER: '' } as Record<string, string>,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // VERSION is the package.json `version` field. Don't pin the
    // literal — just verify it looks like a version line and NOT
    // a broker response envelope (which would start with `{"ok":`).
    expect(text).not.toContain('"ok":');
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
