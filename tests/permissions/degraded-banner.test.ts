// Slice 92 — §13.6 degraded banner emitter. Tests cover:
//   - first-emission semantics on transition into degraded
//   - recurring emissions every Nth tool call
//   - reset on transition back to ready (and re-arming for next degraded)
//   - reason passthrough via getReason
//   - intervalCalls validation (must be int ≥ 1)

import { describe, expect, test } from 'bun:test';
import {
  type DegradedBannerEvent,
  createDegradedBannerEmitter,
} from '../../src/permissions/degraded-banner.ts';
import type { EngineState } from '../../src/permissions/state-machine.ts';

const harness = (opts: {
  states?: EngineState[];
  intervalCalls?: number;
  reason?: string;
  startTs?: number;
}) => {
  const states: EngineState[] = opts.states ?? [];
  let stateIdx = 0;
  const events: DegradedBannerEvent[] = [];
  let ts = opts.startTs ?? 1000;
  const emitter = createDegradedBannerEmitter({
    getState: () => states[stateIdx] ?? 'ready',
    onFire: (event) => events.push(event),
    intervalCalls: opts.intervalCalls ?? 10,
    ...(opts.reason !== undefined ? { getReason: () => opts.reason as string } : {}),
    now: () => ts++,
  });
  return {
    emitter,
    events,
    setStateIdx: (i: number) => {
      stateIdx = i;
    },
  };
};

describe('createDegradedBannerEmitter — state transitions', () => {
  test('ready state: no emissions', () => {
    const { emitter, events } = harness({ states: ['ready'] });
    for (let i = 0; i < 20; i++) {
      emitter.notifyToolCall('session-A');
    }
    expect(events.length).toBe(0);
  });

  test('first tool call while degraded: fires immediately with firstEmission=true', () => {
    const { emitter, events } = harness({ states: ['degraded'], intervalCalls: 10 });
    emitter.notifyToolCall('session-A');
    expect(events.length).toBe(1);
    expect(events[0]?.firstEmission).toBe(true);
    expect(events[0]?.sessionId).toBe('session-A');
  });

  test('after first emission, recurring fires every Nth call (N=3)', () => {
    const { emitter, events } = harness({ states: ['degraded'], intervalCalls: 3 });
    // calls: 1 (first, fires), 2, 3, 4 (fires), 5, 6, 7 (fires), 8, 9, 10 (fires)
    for (let i = 0; i < 10; i++) {
      emitter.notifyToolCall('session-A');
    }
    expect(events.length).toBe(4);
    expect(events[0]?.firstEmission).toBe(true);
    expect(events[1]?.firstEmission).toBe(false);
    expect(events[2]?.firstEmission).toBe(false);
    expect(events[3]?.firstEmission).toBe(false);
  });

  test('default intervalCalls is 10', () => {
    const { emitter, events } = harness({ states: ['degraded'] });
    for (let i = 0; i < 25; i++) {
      emitter.notifyToolCall('session-A');
    }
    // First call fires immediately; then every 10th call (11, 21).
    expect(events.length).toBe(3);
  });
});

describe('createDegradedBannerEmitter — reset on state transition back to ready', () => {
  test('degraded → ready → degraded: second-time first-emission fires again', () => {
    const states: EngineState[] = ['degraded'];
    let stateIdx = 0;
    const events: DegradedBannerEvent[] = [];
    const emitter = createDegradedBannerEmitter({
      getState: () => states[stateIdx] ?? 'ready',
      onFire: (e) => events.push(e),
      intervalCalls: 3,
      now: () => 0,
    });
    // 1 call → first emission
    emitter.notifyToolCall('s');
    expect(events.length).toBe(1);
    expect(events[0]?.firstEmission).toBe(true);

    // Transition to ready
    states.push('ready');
    stateIdx = 1;
    emitter.notifyToolCall('s');
    emitter.notifyToolCall('s');
    expect(events.length).toBe(1); // no new emissions

    // Transition back to degraded
    states.push('degraded');
    stateIdx = 2;
    emitter.notifyToolCall('s');
    expect(events.length).toBe(2);
    expect(events[1]?.firstEmission).toBe(true); // fresh first emission

    // Verify counter reset: next emission needs N more calls
    emitter.notifyToolCall('s'); // 2nd call in this degraded round
    emitter.notifyToolCall('s'); // 3rd
    emitter.notifyToolCall('s'); // 4th — fires
    expect(events.length).toBe(3);
    expect(events[2]?.firstEmission).toBe(false);
  });
});

describe('createDegradedBannerEmitter — reason + ts', () => {
  test('reason from getReason callback is included in events', () => {
    const { emitter, events } = harness({
      states: ['degraded'],
      reason: 'bwrap binary missing',
    });
    emitter.notifyToolCall('s');
    expect(events[0]?.reason).toBe('bwrap binary missing');
  });

  test('omitted getReason defaults to empty string', () => {
    const { emitter, events } = harness({ states: ['degraded'] });
    emitter.notifyToolCall('s');
    expect(events[0]?.reason).toBe('');
  });

  test('ts seam pinned via now() — emissions carry the synthetic value', () => {
    const { emitter, events } = harness({
      states: ['degraded'],
      intervalCalls: 2,
      startTs: 500,
    });
    // now() returns ts then increments; only emissions call now().
    emitter.notifyToolCall('s'); // first emission, ts=500 (ts becomes 501)
    emitter.notifyToolCall('s'); // 2nd call, no emission
    emitter.notifyToolCall('s'); // 3rd call, emission, ts=501 (ts becomes 502)
    expect(events.length).toBe(2);
    expect(events[0]?.ts).toBe(500);
    expect(events[1]?.ts).toBe(501);
  });
});

describe('createDegradedBannerEmitter — non-degraded states', () => {
  test('refusing state does NOT trigger emissions', () => {
    const { emitter, events } = harness({ states: ['refusing'] });
    emitter.notifyToolCall('s');
    emitter.notifyToolCall('s');
    expect(events.length).toBe(0);
  });

  test('loading-policy state does NOT trigger emissions', () => {
    const { emitter, events } = harness({ states: ['loading-policy'] });
    emitter.notifyToolCall('s');
    expect(events.length).toBe(0);
  });
});

describe('createDegradedBannerEmitter — argument validation', () => {
  test('intervalCalls < 1 throws', () => {
    expect(() =>
      createDegradedBannerEmitter({
        getState: () => 'ready',
        onFire: () => {},
        intervalCalls: 0,
      }),
    ).toThrow('intervalCalls must be integer >= 1');
  });

  test('intervalCalls = 1.5 throws (non-integer)', () => {
    expect(() =>
      createDegradedBannerEmitter({
        getState: () => 'ready',
        onFire: () => {},
        intervalCalls: 1.5,
      }),
    ).toThrow('intervalCalls must be integer >= 1');
  });

  test('intervalCalls = 1 is valid (fire every call after first)', () => {
    const events: DegradedBannerEvent[] = [];
    const emitter = createDegradedBannerEmitter({
      getState: () => 'degraded',
      onFire: (e) => events.push(e),
      intervalCalls: 1,
    });
    emitter.notifyToolCall('s'); // first
    emitter.notifyToolCall('s'); // counter reaches 1, fires
    emitter.notifyToolCall('s'); // counter reaches 1 again, fires
    expect(events.length).toBe(3);
    expect(events[0]?.firstEmission).toBe(true);
    expect(events[1]?.firstEmission).toBe(false);
    expect(events[2]?.firstEmission).toBe(false);
  });
});

describe('createDegradedBannerEmitter — sessionId per-call', () => {
  test('sessionId passed at notifyToolCall flows into event', () => {
    const { emitter, events } = harness({ states: ['degraded'], intervalCalls: 2 });
    emitter.notifyToolCall('session-A');
    emitter.notifyToolCall('session-A');
    emitter.notifyToolCall('session-A'); // 3rd → fires
    expect(events.length).toBe(2);
    expect(events.map((e) => e.sessionId)).toEqual(['session-A', 'session-A']);
  });
});
