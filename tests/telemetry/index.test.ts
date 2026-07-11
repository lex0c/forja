import { describe, expect, test } from 'bun:test';
import {
  createNoopTelemetrySink,
  createRecordingTelemetrySink,
  type PermissionDecisionEvent,
} from '../../src/telemetry/index.ts';

const exampleEvent = (
  overrides: Partial<PermissionDecisionEvent> = {},
): PermissionDecisionEvent => ({
  kind: 'permission.decision',
  ts: 1_700_000_000_000,
  approval_id: 42,
  parent_approval_id: null,
  tool: 'bash',
  tool_version: 'v1',
  resolver_version: 'v1',
  capabilities: ['exec:shell'],
  decision: 'allow',
  score: 0.3,
  score_components: { capability_risk: 0.2 },
  confidence: 'high',
  policy_hash: 'sha256:abc',
  classifier_hash: null,
  classifier_adjust: null,
  sandbox_profile: 'cwd-rw',
  ttl_expires_at: null,
  ...overrides,
});

describe('createNoopTelemetrySink', () => {
  test('emit is a no-op that does not throw', () => {
    const sink = createNoopTelemetrySink();
    expect(() => sink.emit(exampleEvent())).not.toThrow();
  });
});

describe('createRecordingTelemetrySink', () => {
  test('events() returns empty array before any emit', () => {
    const sink = createRecordingTelemetrySink();
    expect(sink.events()).toEqual([]);
  });

  test('emit appends to the internal buffer in order', () => {
    const sink = createRecordingTelemetrySink();
    sink.emit(exampleEvent({ approval_id: 1 }));
    sink.emit(exampleEvent({ approval_id: 2 }));
    sink.emit(exampleEvent({ approval_id: 3 }));
    const events = sink.events();
    expect(events).toHaveLength(3);
    expect((events[0] as PermissionDecisionEvent | undefined)?.approval_id).toBe(1);
    expect((events[1] as PermissionDecisionEvent | undefined)?.approval_id).toBe(2);
    expect((events[2] as PermissionDecisionEvent | undefined)?.approval_id).toBe(3);
  });

  test('events() returns a snapshot — mutations of the returned array do NOT affect future reads', () => {
    const sink = createRecordingTelemetrySink();
    sink.emit(exampleEvent({ approval_id: 1 }));
    const snapshot = sink.events();
    // Cast away readonly to attempt mutation — even if the caller
    // bypasses the type, the sink's internal state must stay intact.
    (snapshot as PermissionDecisionEvent[]).push(exampleEvent({ approval_id: 999 }));
    expect(sink.events()).toHaveLength(1);
    expect((sink.events()[0] as PermissionDecisionEvent | undefined)?.approval_id).toBe(1);
  });

  test('clear() empties the buffer', () => {
    const sink = createRecordingTelemetrySink();
    sink.emit(exampleEvent());
    sink.emit(exampleEvent());
    expect(sink.events()).toHaveLength(2);
    sink.clear();
    expect(sink.events()).toEqual([]);
  });

  test('emit after clear continues capturing', () => {
    const sink = createRecordingTelemetrySink();
    sink.emit(exampleEvent({ approval_id: 1 }));
    sink.clear();
    sink.emit(exampleEvent({ approval_id: 2 }));
    expect(sink.events()).toHaveLength(1);
    expect((sink.events()[0] as PermissionDecisionEvent | undefined)?.approval_id).toBe(2);
  });
});
