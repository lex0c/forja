import { describe, expect, test } from 'bun:test';
import {
  type StateTransition,
  canTransition,
  createStateController,
  isRejectingState,
} from '../../src/permissions/state-machine.ts';

describe('canTransition', () => {
  test('init → loading-policy is valid', () => {
    expect(canTransition('init', 'loading-policy')).toBe(true);
  });
  test('init → ready (skipping loading) is invalid', () => {
    expect(canTransition('init', 'ready')).toBe(false);
  });
  test('loading-policy → validating-chain valid', () => {
    expect(canTransition('loading-policy', 'validating-chain')).toBe(true);
  });
  test('validating-chain → ready valid', () => {
    expect(canTransition('validating-chain', 'ready')).toBe(true);
  });
  test('validating-chain → degraded valid (fallback path)', () => {
    expect(canTransition('validating-chain', 'degraded')).toBe(true);
  });
  test('ready ↔ degraded valid both ways', () => {
    expect(canTransition('ready', 'degraded')).toBe(true);
    expect(canTransition('degraded', 'ready')).toBe(true);
  });
  test('any → refusing valid except from refusing itself', () => {
    expect(canTransition('init', 'refusing')).toBe(true);
    expect(canTransition('loading-policy', 'refusing')).toBe(true);
    expect(canTransition('validating-chain', 'refusing')).toBe(true);
    expect(canTransition('ready', 'refusing')).toBe(true);
    expect(canTransition('degraded', 'refusing')).toBe(true);
  });
  test('refusing is terminal (no outgoing edges)', () => {
    expect(canTransition('refusing', 'ready')).toBe(false);
    expect(canTransition('refusing', 'init')).toBe(false);
    expect(canTransition('refusing', 'degraded')).toBe(false);
    expect(canTransition('refusing', 'refusing')).toBe(false);
  });
  test('self-loops not allowed for most states (ready, init, etc.)', () => {
    // No-op transitions are masked from the audit log by refusing
    // them outright — a caller asking "transition to ready" while
    // already there is signaling a bug. Exception: degraded gets
    // a self-edge so re-degrade calls from telemetry/sandbox paths
    // don't throw (slice 177).
    expect(canTransition('ready', 'ready')).toBe(false);
    expect(canTransition('init', 'init')).toBe(false);
    expect(canTransition('loading-policy', 'loading-policy')).toBe(false);
    expect(canTransition('validating-chain', 'validating-chain')).toBe(false);
    expect(canTransition('refusing', 'refusing')).toBe(false);
  });

  // Slice 177 (review — P1). The `degraded → degraded` self-edge is
  // explicitly valid so callers re-degrading the engine (e.g. seal
  // scheduler hitting a 2nd failure, sandbox availability re-probed
  // mid-session and still missing) don't throw. The transition is
  // RECORDED in history so the operator can see WHY the engine kept
  // re-degrading.
  test('degraded→degraded is a valid self-edge (slice 177)', () => {
    expect(canTransition('degraded', 'degraded')).toBe(true);
  });
});

describe('createStateController', () => {
  test('starts at init by default', () => {
    const c = createStateController();
    expect(c.get()).toBe('init');
  });

  test('can be pinned to a different initial state (test seam)', () => {
    const c = createStateController({ initial: 'ready' });
    expect(c.get()).toBe('ready');
  });

  test('records valid transitions in history', () => {
    const c = createStateController({ now: () => 1000 });
    c.transition('loading-policy', 'bootstrap_start');
    c.transition('validating-chain', 'policy_loaded');
    c.transition('ready', 'chain_intact');
    expect(c.get()).toBe('ready');
    expect(c.history()).toEqual([
      { from: 'init', to: 'loading-policy', reason: 'bootstrap_start', ts: 1000 },
      { from: 'loading-policy', to: 'validating-chain', reason: 'policy_loaded', ts: 1000 },
      { from: 'validating-chain', to: 'ready', reason: 'chain_intact', ts: 1000 },
    ]);
  });

  test('invalid transition throws with the offending edge in message', () => {
    const c = createStateController({ initial: 'ready' });
    expect(() => c.transition('init', 'sneaky')).toThrow(/ready → init/);
  });

  test('refusing is terminal — every leave attempt throws', () => {
    const c = createStateController({ initial: 'refusing' });
    expect(() => c.transition('ready', 'wishful')).toThrow();
    expect(() => c.transition('init', 'reset')).toThrow();
  });

  test('returns the event from transition()', () => {
    const c = createStateController({ now: () => 42 });
    const evt = c.transition('loading-policy', 'go');
    expect(evt).toEqual({ from: 'init', to: 'loading-policy', reason: 'go', ts: 42 });
  });

  test('onTransition listener fires per transition', () => {
    const events: StateTransition[] = [];
    const c = createStateController({
      onTransition: (e) => events.push(e),
      now: () => 5,
    });
    c.transition('loading-policy', 'a');
    c.transition('validating-chain', 'b');
    expect(events.length).toBe(2);
    expect(events[0]?.to).toBe('loading-policy');
    expect(events[1]?.to).toBe('validating-chain');
  });

  test('listener throws do not break state', () => {
    const c = createStateController({
      onTransition: () => {
        throw new Error('observer exploded');
      },
    });
    expect(() => c.transition('loading-policy', 'x')).not.toThrow();
    expect(c.get()).toBe('loading-policy');
  });
});

describe('isRejectingState', () => {
  test('init / loading-policy / validating-chain / refusing reject checks', () => {
    expect(isRejectingState('init')).toBe(true);
    expect(isRejectingState('loading-policy')).toBe(true);
    expect(isRejectingState('validating-chain')).toBe(true);
    expect(isRejectingState('refusing')).toBe(true);
  });
  test('ready / degraded do not reject checks', () => {
    expect(isRejectingState('ready')).toBe(false);
    expect(isRejectingState('degraded')).toBe(false);
  });
});
