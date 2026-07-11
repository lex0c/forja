import { afterEach, describe, expect, test } from 'bun:test';
import {
  createChannel,
  fakeTransportPair,
  type IpcChannel,
  type IpcMessage,
  makePermissionAnswer,
} from '../../src/subagents/ipc.ts';
import { createChildPermissionBridge } from '../../src/subagents/permission-bridge.ts';

// The bridge sits between `invoke-tool`'s `confirmPermission`
// callback contract and the IPC channel. Tests build a fake
// transport pair: the bridge owns one side ("child"), the test
// owns the other ("parent") and acts as the proxy by replying with
// permission:answer messages on demand. No real subprocess.

interface BridgeRig {
  // Channel the bridge is wired to (child side).
  childChannel: IpcChannel;
  // Channel the test acts on (parent side).
  parentChannel: IpcChannel;
  // Stable sequence of promptIds the bridge will mint, so tests
  // can correlate without parsing the wire payload.
  promptIds: string[];
  errLines: string[];
  signal: AbortSignal;
  abortController: AbortController;
}

const buildRig = (overrides?: { signal?: AbortSignal }): BridgeRig => {
  const transports = fakeTransportPair();
  const childChannel = createChannel(transports.a);
  const parentChannel = createChannel(transports.b);
  const promptIds: string[] = [];
  let counter = 0;
  const newPromptId = (): string => {
    counter += 1;
    const id = `pid-${counter}`;
    promptIds.push(id);
    return id;
  };
  const errLines: string[] = [];
  const abortController = new AbortController();
  const signal = overrides?.signal ?? abortController.signal;
  const bridge = createChildPermissionBridge({
    channel: childChannel,
    signal,
    newPromptId,
    errSink: (line) => {
      errLines.push(line);
    },
  });
  // Stash the bridge on the rig — tests need it but the type
  // graph stays cleaner if we expose it via a destructure target.
  (signal as unknown as { __bridge?: unknown }).__bridge = bridge;
  return {
    childChannel,
    parentChannel,
    promptIds,
    errLines,
    signal,
    abortController,
  };
};

const getBridgeFromRig = (rig: BridgeRig) =>
  (rig.signal as unknown as { __bridge: ReturnType<typeof createChildPermissionBridge> }).__bridge;

const collectParentMessages = (rig: BridgeRig): IpcMessage[] => {
  const out: IpcMessage[] = [];
  rig.parentChannel.onMessage((msg) => {
    out.push(msg);
  });
  return out;
};

const flushMicrotasks = async (): Promise<void> => {
  // Two microtask drains: confirmPermission's resolve runs in a
  // promise.then; the parent's send + the channel's onMessage
  // dispatch each take one tick. Two awaits is enough on Bun's
  // event loop for the round-trip.
  await Promise.resolve();
  await Promise.resolve();
};

let activeRigs: BridgeRig[] = [];

afterEach(() => {
  for (const rig of activeRigs) {
    getBridgeFromRig(rig).dispose();
    rig.parentChannel.close();
    rig.childChannel.close();
  }
  activeRigs = [];
});

const newRig = (overrides?: { signal?: AbortSignal }): BridgeRig => {
  const rig = buildRig(overrides);
  activeRigs.push(rig);
  return rig;
};

describe('permission-bridge — happy path', () => {
  test('confirmPermission emits permission:ask with the request payload', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    const seen = collectParentMessages(rig);

    const promise = bridge.confirmPermission({
      toolName: 'bash',
      args: { command: 'ls' },
      cwd: '/tmp/proj',
      prompt: 'Run shell command?',
    });

    await flushMicrotasks();
    expect(seen).toHaveLength(1);
    const ask = seen[0];
    expect(ask?.type).toBe('permission:ask');
    if (ask?.type === 'permission:ask') {
      expect(ask.promptId).toBe('pid-1');
      expect(ask.toolName).toBe('bash');
      expect(ask.args).toEqual({ command: 'ls' });
      expect(ask.cwd).toBe('/tmp/proj');
      expect(ask.prompt).toBe('Run shell command?');
    }
    expect(bridge.pendingCount()).toBe(1);

    rig.parentChannel.send(makePermissionAnswer({ promptId: 'pid-1', decision: 'allow' }));
    const answer = await promise;
    expect(answer).toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('deny answer collapses to false', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    const promise = bridge.confirmPermission({
      toolName: 'write_file',
      args: { path: 'a.txt' },
      cwd: '/c',
      prompt: 'Write to disk?',
    });
    await flushMicrotasks();
    rig.parentChannel.send(makePermissionAnswer({ promptId: 'pid-1', decision: 'deny' }));
    expect(await promise).toBe(false);
  });

  test('parallel asks resolve independently and out-of-order', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    const p1 = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q1',
    });
    const p2 = bridge.confirmPermission({
      toolName: 'write_file',
      args: {},
      cwd: '/c',
      prompt: 'q2',
    });
    await flushMicrotasks();
    expect(bridge.pendingCount()).toBe(2);

    // Answer second one first.
    rig.parentChannel.send(makePermissionAnswer({ promptId: 'pid-2', decision: 'allow' }));
    expect(await p2).toBe(true);
    expect(bridge.pendingCount()).toBe(1);

    rig.parentChannel.send(makePermissionAnswer({ promptId: 'pid-1', decision: 'deny' }));
    expect(await p1).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('permission-bridge — failure modes', () => {
  test('hard abort drains pending as denied', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    const p1 = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q1',
    });
    const p2 = bridge.confirmPermission({
      toolName: 'write_file',
      args: {},
      cwd: '/c',
      prompt: 'q2',
    });
    await flushMicrotasks();
    expect(bridge.pendingCount()).toBe(2);

    rig.abortController.abort();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('channel close drains pending as denied', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    const promise = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q1',
    });
    await flushMicrotasks();
    expect(bridge.pendingCount()).toBe(1);

    rig.parentChannel.close();
    expect(await promise).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('confirmPermission after channel close short-circuits to false without IPC traffic', async () => {
    // Regression guard. Earlier the bridge tracked only `disposed`
    // and the live `signal.aborted` flag — a channel close (peer
    // EOF, parent died) would drain pending entries but leave the
    // bridge "open". A subsequent confirmPermission call would
    // register a new pending promise and call channel.send on a
    // closed channel; the fake transport silently drops post-close
    // writes, so the promise would hang indefinitely. The bridge
    // now flips a `closed` flag inside its onClose handler so this
    // path resolves to denial promptly.
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    const seen = collectParentMessages(rig);
    rig.parentChannel.close();

    const answer = await bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'late',
    });
    expect(answer).toBe(false);
    expect(seen).toHaveLength(0);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('confirmPermission after abort short-circuits to false without IPC traffic', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    const seen = collectParentMessages(rig);

    rig.abortController.abort();
    const answer = await bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'late',
    });
    expect(answer).toBe(false);
    expect(seen).toHaveLength(0);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('confirmPermission with a pre-aborted signal short-circuits to false', async () => {
    const ac = new AbortController();
    ac.abort();
    const rig = newRig({ signal: ac.signal });
    const bridge = getBridgeFromRig(rig);
    const seen = collectParentMessages(rig);

    const answer = await bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'never',
    });
    expect(answer).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test('answer for unknown promptId is logged and dropped', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    rig.parentChannel.send(makePermissionAnswer({ promptId: 'ghost', decision: 'allow' }));
    await flushMicrotasks();

    expect(rig.errLines).toHaveLength(1);
    expect(rig.errLines[0]).toContain('unknown promptId');
    expect(rig.errLines[0]).toContain('ghost');
    expect(bridge.pendingCount()).toBe(0);
  });

  test('non-permission messages on the wire are ignored', async () => {
    // Defensive: the bridge's onMessage handler subscribes to
    // every IpcMessage on the channel — interrupt:soft,
    // permission:answer, even random `event` payloads if the
    // parent ever fanned them back. The bridge must be a no-op
    // for anything but permission:answer.
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    collectParentMessages(rig);

    const promise = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q',
    });
    await flushMicrotasks();
    expect(bridge.pendingCount()).toBe(1);

    // Inject the kind of traffic the parent might legitimately
    // send for other purposes (interrupt commands, etc.). The
    // bridge must NOT touch the pending request.
    rig.parentChannel.send({
      type: 'interrupt:soft',
      id: 'env-1',
      ts: Date.now(),
    });
    await flushMicrotasks();
    expect(bridge.pendingCount()).toBe(1);
    expect(rig.errLines).toEqual([]);

    rig.parentChannel.send(makePermissionAnswer({ promptId: 'pid-1', decision: 'allow' }));
    expect(await promise).toBe(true);
  });

  test('dispose drains pending and short-circuits future calls', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    const seen = collectParentMessages(rig);

    const p1 = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q1',
    });
    await flushMicrotasks();
    expect(seen).toHaveLength(1);

    bridge.dispose();
    expect(await p1).toBe(false);

    const p2 = bridge.confirmPermission({
      toolName: 'bash',
      args: {},
      cwd: '/c',
      prompt: 'q2',
    });
    expect(await p2).toBe(false);
    // No second IPC ask emitted after dispose.
    expect(seen).toHaveLength(1);
  });

  test('dispose is idempotent', () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
  });
});

// Slice 166 (review — Batch D subagent IPC concurrency, first item).
// The race window between the initial guard (`disposed || closed ||
// signal.aborted`) and the `pending.set` registration. Theoretical
// in pure single-threaded JS (sync code between the two lines can't
// yield), but defensive: a future refactor adding an `await` or a
// Bun-IPC dispatch firing as a microtask between sync statements
// would break the contract "every confirmPermission returns within
// terminal-state ticks". The post-set re-check closes the gap.
describe('permission-bridge — terminal-state re-check after pending.set (slice 166)', () => {
  test('signal aborts BEFORE confirmPermission returns → re-check resolves false (no orphan promise)', async () => {
    // Hard to trigger the race deterministically; instead drive
    // the moral equivalent: abort the signal AFTER pending.set
    // has run but BEFORE the caller awaits. The re-check fires
    // because we check `signal.aborted` AFTER the set.
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    // Start the call; capture the promise without awaiting yet.
    rig.abortController.abort('test abort');
    // Post-abort confirmPermission: line 195 initial guard fires
    // because signal.aborted=true. We get false synchronously.
    // (This is the existing guard; what slice 166 adds is the
    // second check AFTER set, exercised by the next test.)
    const result = await bridge.confirmPermission({
      toolName: 'bash',
      args: { command: 'ls' },
      cwd: '/work',
      prompt: 'Run bash?',
    });
    expect(result).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('dispose during confirmPermission → pending entry cleaned up, no orphan', async () => {
    // Concrete reproduction of the cleanup contract: the bridge
    // must never leave an entry in `pending` after a terminal
    // state. We probe by counting pending entries after dispose.
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    // Issue confirmPermission, then dispose immediately. The
    // initial pending.set registered the entry; dispose drains
    // it via `drainPendingAsDenied`. Result: pending stays empty.
    const promise = bridge.confirmPermission({
      toolName: 'bash',
      args: { command: 'ls' },
      cwd: '/work',
      prompt: 'Run bash?',
    });
    bridge.dispose();
    // After dispose, the drain ran (entry resolved to false).
    const result = await promise;
    expect(result).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });

  test('channel close during confirmPermission → entry drained', async () => {
    const rig = newRig();
    const bridge = getBridgeFromRig(rig);
    const promise = bridge.confirmPermission({
      toolName: 'bash',
      args: { command: 'ls' },
      cwd: '/work',
      prompt: 'Run bash?',
    });
    // Close the parent side; bridge sees the close event.
    rig.parentChannel.close();
    await flushMicrotasks();
    const result = await promise;
    expect(result).toBe(false);
    expect(bridge.pendingCount()).toBe(0);
  });
});
