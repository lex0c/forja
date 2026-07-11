import { describe, expect, test } from 'bun:test';
import {
  type ChainVerifyFailedEvent,
  type ClassifierUnavailableEvent,
  type PermissionDecisionEvent,
  type SealingFailureEvent,
  type StateTransitionEvent,
  type TelemetryEvent,
  createJsonLinesTelemetrySink,
} from '../../src/telemetry/index.ts';

const captured = () => {
  const lines: string[] = [];
  return {
    write: (line: string) => lines.push(line),
    lines,
  };
};

describe('createJsonLinesTelemetrySink (slice 77)', () => {
  test('writes one JSON line per event with trailing newline', () => {
    const out = captured();
    const sink = createJsonLinesTelemetrySink({ write: out.write });
    const event: PermissionDecisionEvent = {
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
      policy_hash: 'sha256:p',
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
    };
    sink.emit(event);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed).toEqual(event);
  });

  test('writes one line per emit across multiple events', () => {
    const out = captured();
    const sink = createJsonLinesTelemetrySink({ write: out.write });
    const e1: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 100,
      from: 'init',
      to: 'loading-policy',
      reason: 'bootstrap_start',
    };
    const e2: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 101,
      from: 'loading-policy',
      to: 'ready',
      reason: 'policy_loaded',
    };
    sink.emit(e1);
    sink.emit(e2);
    expect(out.lines).toHaveLength(2);
    expect(JSON.parse(out.lines[0] as string)).toEqual(e1);
    expect(JSON.parse(out.lines[1] as string)).toEqual(e2);
  });

  test('handles all five event kinds without losing fields', () => {
    const out = captured();
    const sink = createJsonLinesTelemetrySink({ write: out.write });
    const events: TelemetryEvent[] = [
      {
        kind: 'permission.decision',
        ts: 1,
        approval_id: 1,
        parent_approval_id: null,
        tool: 'bash',
        tool_version: 'v1',
        resolver_version: 'v1',
        capabilities: [],
        decision: 'allow',
        score: 0,
        score_components: {},
        confidence: 'high',
        policy_hash: 'sha256:p',
        classifier_hash: null,
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
      },
      {
        kind: 'state.transition',
        ts: 2,
        from: 'ready',
        to: 'degraded',
        reason: 'sandbox_unavailable',
      },
      {
        kind: 'sealing.failure',
        ts: 3,
        mode: 'worm-file',
        path: '/var/log/forja/seal.log',
        reason: 'chattr failed',
        on_failure: 'degrade',
      } as SealingFailureEvent,
      {
        kind: 'chain.verify_failed',
        ts: 4,
        install_id: 'iid-abc',
        broken_at: 7,
        reason: 'this_hash_mismatch',
        expected: 'sha256:e',
        actual: 'sha256:a',
        accepted: false,
      } as ChainVerifyFailedEvent,
      {
        kind: 'classifier.unavailable',
        ts: 5,
        tool: 'bash',
        classifier_hash: 'v1',
        reason: 'threw',
        strict: false,
      } as ClassifierUnavailableEvent,
    ];
    for (const e of events) sink.emit(e);
    expect(out.lines).toHaveLength(5);
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(out.lines[i] as string)).toEqual(events[i]);
    }
  });

  test('write throwing propagates (no internal try/catch)', () => {
    const sink = createJsonLinesTelemetrySink({
      write: () => {
        throw new Error('disk full');
      },
    });
    const event: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'test',
    };
    expect(() => sink.emit(event)).toThrow('disk full');
  });

  test('each line is independently parseable (no shared state, no chunked output)', () => {
    // Validates the line boundary contract — operators tailing
    // the file expect ONE complete JSON object per line, never
    // partial / split across lines.
    const out = captured();
    const sink = createJsonLinesTelemetrySink({ write: out.write });
    for (let i = 0; i < 100; i++) {
      sink.emit({
        kind: 'state.transition',
        ts: i,
        from: 'ready',
        to: 'degraded',
        reason: `iter=${i}`,
      });
    }
    expect(out.lines).toHaveLength(100);
    // Every line ends with \n + parses to one event.
    for (let i = 0; i < 100; i++) {
      const line = out.lines[i] as string;
      expect(line.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(line);
      expect(parsed.kind).toBe('state.transition');
      expect(parsed.ts).toBe(i);
    }
  });

  test('default JSON serialization preserves structure (composes with scrubbing)', async () => {
    // End-to-end: bootstrap → scrubbing → jsonlines. Scrubbing
    // produces a clean event; jsonlines writes it as JSON. Both
    // composable via TelemetrySink interface.
    const { createScrubbingTelemetrySink } = await import('../../src/telemetry/scrubbing.ts');
    const out = captured();
    const jsonSink = createJsonLinesTelemetrySink({ write: out.write });
    const scrubbingSink = createScrubbingTelemetrySink(jsonSink);
    scrubbingSink.emit({
      kind: 'permission.decision',
      ts: 1,
      approval_id: 1,
      parent_approval_id: null,
      tool: 'bash',
      tool_version: 'v1',
      resolver_version: 'v1',
      capabilities: ['read-fs:/home/secret/keys', 'net-egress:internal.corp'],
      decision: 'allow',
      score: 0,
      score_components: {},
      confidence: 'high',
      policy_hash: 'sha256:p',
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
    });
    expect(out.lines).toHaveLength(1);
    const parsed = JSON.parse(out.lines[0] as string);
    expect(parsed.capabilities).toEqual(['read-fs:<path>', 'net-egress:<host>']);
  });
});
