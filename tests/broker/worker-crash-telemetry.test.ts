// Slice 84 — worker.crashed telemetry from the spawn broker.
// Pins emission on the three post-spawn detection branches
// (no_response / invalid_response / missing_fields) and
// non-emission on the paths that aren't crashes (timeout,
// abort, success, spawn failure).

import { describe, expect, test } from 'bun:test';
import {
  type BrokerRequest,
  type SpawnFn,
  type SpawnedProcess,
  createSpawnBroker,
} from '../../src/broker/index.ts';
import {
  type WorkerCrashEvent,
  createRecordingTelemetrySink,
  createScrubbingTelemetrySink,
} from '../../src/telemetry/index.ts';

const baseRequest = (overrides: Partial<BrokerRequest> = {}): BrokerRequest => ({
  toolName: 'bash',
  args: { command: 'echo hi' },
  capabilities: [],
  sandboxProfile: 'ro',
  ...overrides,
});

const streamFromString = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

interface MockOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const makeMockProc = (opts: MockOpts = {}): SpawnedProcess => ({
  stdin: { write: () => 0, end: () => undefined },
  stdout: streamFromString(opts.stdout ?? ''),
  stderr: streamFromString(opts.stderr ?? ''),
  exited: Promise.resolve(opts.exitCode ?? 0),
  kill: () => {},
});

// ─── emission on the three crash paths ────────────────────────────────────

describe('createSpawnBroker — worker.crashed telemetry: emits on crash', () => {
  test('no_response: worker exits without writing → emits cause=no_response', async () => {
    const sink = createRecordingTelemetrySink();
    let nowVal = 1_000;
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: (() =>
        makeMockProc({ stdout: '', stderr: 'worker panic\n', exitCode: 137 })) satisfies SpawnFn,
      telemetry: sink,
      now: () => {
        nowVal += 50;
        return nowVal;
      },
    });
    await broker.execute(baseRequest());
    await broker.close();
    expect(sink.events().length).toBe(1);
    const e = sink.events()[0] as WorkerCrashEvent;
    expect(e.kind).toBe('worker.crashed');
    expect(e.cause).toBe('no_response');
    expect(e.exitCode).toBe(137);
    expect(e.stderr).toBe('worker panic\n');
    expect(e.toolName).toBe('bash');
    expect(e.sandboxProfile).toBe('ro');
    expect(e.elapsedMs).toBeGreaterThan(0);
    expect(typeof e.ts).toBe('number');
  });

  test('invalid_response: last stdout line is not JSON → emits cause=invalid_response', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProc({ stdout: 'garbage not json\n', stderr: '', exitCode: 0 }),
      telemetry: sink,
    });
    await broker.execute(baseRequest());
    await broker.close();
    expect(sink.events().length).toBe(1);
    const e = sink.events()[0] as WorkerCrashEvent;
    expect(e.cause).toBe('invalid_response');
    expect(e.exitCode).toBe(0);
  });

  test('missing_fields: parseable JSON but wrong shape → emits cause=missing_fields', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProc({ stdout: '{"foo":"bar"}\n', stderr: '', exitCode: 0 }),
      telemetry: sink,
    });
    await broker.execute(baseRequest());
    await broker.close();
    expect(sink.events().length).toBe(1);
    const e = sink.events()[0] as WorkerCrashEvent;
    expect(e.cause).toBe('missing_fields');
  });
});

// ─── non-emission on non-crash paths ──────────────────────────────────────

describe('createSpawnBroker — worker.crashed telemetry: does NOT emit', () => {
  test('successful response: no crash event', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProc({
          stdout: '{"ok":true,"stdout":"","stderr":"","exitCode":0}\n',
          exitCode: 0,
        }),
      telemetry: sink,
    });
    const r = await broker.execute(baseRequest());
    await broker.close();
    expect(r.ok).toBe(true);
    expect(sink.events().length).toBe(0);
  });

  test('timeout: no crash event (operator-known failure)', async () => {
    const sink = createRecordingTelemetrySink();
    // Use real Bun.spawn with a /bin/sh that sleeps longer than timeout
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'IFS= read -r _; sleep 10'],
      timeoutMs: 50,
      telemetry: sink,
    });
    const r = await broker.execute(baseRequest());
    await broker.close();
    expect(r.error).toBe('timeout after 50ms');
    expect(sink.events().length).toBe(0);
  });

  test('abort: no crash event (caller-known cancellation)', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/bin/sh',
      args: ['-c', 'sleep 10'],
      timeoutMs: 30_000,
      telemetry: sink,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await broker.execute(baseRequest(), { signal: ac.signal });
    await broker.close();
    expect(r.error).toBe('aborted');
    expect(sink.events().length).toBe(0);
  });

  test('spawn failure: no crash event (pre-exec, not a worker crash)', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/usr/bin/missing',
      spawn: () => {
        throw new Error('ENOENT');
      },
      telemetry: sink,
    });
    const r = await broker.execute(baseRequest());
    await broker.close();
    expect(r.error).toContain('spawn failed:');
    expect(sink.events().length).toBe(0);
  });

  test('sandbox wrap failure: no crash event (pre-exec)', async () => {
    const sink = createRecordingTelemetrySink();
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      sandboxRunner: () => {
        throw new Error('bwrap missing');
      },
      spawn: () => makeMockProc(),
      telemetry: sink,
    });
    const r = await broker.execute(baseRequest({ sandboxProfile: 'cwd-rw' }));
    await broker.close();
    expect(r.error).toBe('sandbox wrap failed: bwrap missing');
    expect(sink.events().length).toBe(0);
  });

  test('no telemetry configured: detection paths still set error, just no events', async () => {
    // Same as no_response, but with no sink configured — exercises the
    // `telemetry === undefined` skip path. No assertion on sink (there
    // isn't one); the test verifies the broker doesn't crash trying
    // to emit.
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProc({ stdout: '', stderr: 'x\n', exitCode: 1 }),
    });
    const r = await broker.execute(baseRequest());
    await broker.close();
    expect(r.error).toBe('worker produced no response');
  });

  test('sink throwing: broker continues normally (telemetry is observability)', async () => {
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () => makeMockProc({ stdout: '', exitCode: 1 }),
      telemetry: {
        emit: () => {
          throw new Error('sink boom');
        },
      },
    });
    const r = await broker.execute(baseRequest());
    await broker.close();
    expect(r.error).toBe('worker produced no response');
    expect(r.exitCode).toBe(1);
  });
});

// ─── scrubbing pass-through for the new event kind ────────────────────────

describe('worker.crashed scrubbing', () => {
  test('stderr with absolute paths gets <path> placeholder via scrubbing layer', async () => {
    const inner = createRecordingTelemetrySink();
    const scrubbed = createScrubbingTelemetrySink(inner);
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProc({
          stdout: '',
          stderr: 'panic at /home/john/.secret/key.pem line 42\n',
          exitCode: 137,
        }),
      telemetry: scrubbed,
    });
    await broker.execute(baseRequest());
    await broker.close();
    const e = inner.events()[0] as WorkerCrashEvent;
    expect(e.stderr).toContain('<path>');
    expect(e.stderr).not.toContain('/home/john');
  });

  test('non-path stderr passes through unchanged', async () => {
    const inner = createRecordingTelemetrySink();
    const scrubbed = createScrubbingTelemetrySink(inner);
    const broker = createSpawnBroker({
      command: '/usr/bin/worker',
      spawn: () =>
        makeMockProc({
          stdout: '',
          stderr: 'OOM killed: heap exhausted\n',
          exitCode: 137,
        }),
      telemetry: scrubbed,
    });
    await broker.execute(baseRequest());
    await broker.close();
    const e = inner.events()[0] as WorkerCrashEvent;
    expect(e.stderr).toBe('OOM killed: heap exhausted\n');
  });
});
