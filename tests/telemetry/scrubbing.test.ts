import { describe, expect, test } from 'bun:test';
import {
  type ChainVerifyFailedEvent,
  type ClassifierUnavailableEvent,
  type PermissionDecisionEvent,
  type SealingFailureEvent,
  type StateTransitionEvent,
  type TelemetryEvent,
  createRecordingTelemetrySink,
} from '../../src/telemetry/index.ts';
import { createScrubbingTelemetrySink, scrubEvent } from '../../src/telemetry/scrubbing.ts';

const basePermissionEvent = (
  overrides: Partial<PermissionDecisionEvent> = {},
): PermissionDecisionEvent => ({
  kind: 'permission.decision',
  ts: 1_700_000_000_000,
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
  ...overrides,
});

describe('scrubEvent — permission.decision (slice 76)', () => {
  test('FS capability scopes are replaced with <path>', () => {
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: [
          'read-fs:/home/john/secrets.env',
          'write-fs:/Users/jane/proj/db.sqlite',
          'delete-fs:/var/log/x',
          'exec-fs:/usr/local/bin/script',
          'git-write:/work/private-repo',
        ],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual([
      'read-fs:<path>',
      'write-fs:<path>',
      'delete-fs:<path>',
      'exec-fs:<path>',
      'git-write:<path>',
    ]);
  });

  test('net-egress capability scopes are replaced with <host>', () => {
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['net-egress:internal.corp.example.com', 'net-egress:api.github.com'],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual(['net-egress:<host>', 'net-egress:<host>']);
  });

  test('exec:shell and other unknown kinds pass through untouched', () => {
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['exec:shell', 'custom-kind:value-without-meaning'],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual(['exec:shell', 'custom-kind:value-without-meaning']);
  });

  test('non-capability fields are preserved unchanged', () => {
    const original = basePermissionEvent({
      capabilities: ['read-fs:/foo'],
      tool: 'bash',
      decision: 'confirm',
      score: 0.5,
      policy_hash: 'sha256:abc',
    });
    const out = scrubEvent(original) as PermissionDecisionEvent;
    expect(out.tool).toBe('bash');
    expect(out.decision).toBe('confirm');
    expect(out.score).toBe(0.5);
    expect(out.policy_hash).toBe('sha256:abc');
    expect(out.ts).toBe(original.ts);
    expect(out.approval_id).toBe(original.approval_id);
  });

  test('redactPaths=false leaves FS scopes intact', () => {
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['read-fs:/home/john/x', 'net-egress:api.github.com'],
      }),
      { redactPaths: false },
    ) as PermissionDecisionEvent;
    expect(out.capabilities[0]).toBe('read-fs:/home/john/x');
    // Hosts still scrubbed.
    expect(out.capabilities[1]).toBe('net-egress:<host>');
  });

  test('redactHosts=false leaves net scopes intact', () => {
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['read-fs:/x', 'net-egress:api.github.com'],
      }),
      { redactHosts: false },
    ) as PermissionDecisionEvent;
    expect(out.capabilities[0]).toBe('read-fs:<path>');
    expect(out.capabilities[1]).toBe('net-egress:api.github.com');
  });

  test('both off → identity transform', () => {
    const input = basePermissionEvent({
      capabilities: ['read-fs:/x', 'net-egress:foo.com'],
    });
    const out = scrubEvent(input, { redactPaths: false, redactHosts: false });
    expect(out).toEqual(input);
  });
});

describe('scrubEvent — sealing.failure', () => {
  test('path is replaced with <path>', () => {
    const event: SealingFailureEvent = {
      kind: 'sealing.failure',
      ts: 100,
      mode: 'worm-file',
      path: '/var/log/agent/seal.log',
      reason: 'chattr failed',
      on_failure: 'degrade',
    };
    const out = scrubEvent(event) as SealingFailureEvent;
    expect(out.path).toBe('<path>');
    expect(out.mode).toBe('worm-file');
    expect(out.reason).toBe('chattr failed');
    expect(out.on_failure).toBe('degrade');
  });

  test('absent path is preserved as undefined', () => {
    const event: SealingFailureEvent = {
      kind: 'sealing.failure',
      ts: 100,
      mode: 'none',
      reason: 'no seal config',
      on_failure: 'degrade',
    };
    const out = scrubEvent(event) as SealingFailureEvent;
    expect(out.path).toBeUndefined();
  });

  test('redactPaths=false keeps the path intact', () => {
    const event: SealingFailureEvent = {
      kind: 'sealing.failure',
      ts: 100,
      mode: 'worm-file',
      path: '/var/log/agent/seal.log',
      reason: 'chattr failed',
      on_failure: 'degrade',
    };
    const out = scrubEvent(event, { redactPaths: false }) as SealingFailureEvent;
    expect(out.path).toBe('/var/log/agent/seal.log');
  });
});

describe('scrubEvent — state.transition', () => {
  test('path-shaped substrings in reason are replaced with <path>', () => {
    const event: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 100,
      from: 'ready',
      to: 'degraded',
      reason: 'sealing failed at /var/log/agent/seal.log because /usr/bin/chattr exited 1',
    };
    const out = scrubEvent(event) as StateTransitionEvent;
    expect(out.reason).not.toContain('/var/log/agent/seal.log');
    expect(out.reason).not.toContain('/usr/bin/chattr');
    expect(out.reason).toContain('<path>');
  });

  test('non-path reasons pass through', () => {
    const event: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 100,
      from: 'ready',
      to: 'refusing',
      reason: 'classifier_threw',
    };
    const out = scrubEvent(event) as StateTransitionEvent;
    expect(out.reason).toBe('classifier_threw');
  });

  test('redactPaths=false keeps paths in reason', () => {
    const event: StateTransitionEvent = {
      kind: 'state.transition',
      ts: 100,
      from: 'ready',
      to: 'degraded',
      reason: 'failed at /etc/agent/policy.yaml',
    };
    const out = scrubEvent(event, { redactPaths: false }) as StateTransitionEvent;
    expect(out.reason).toBe('failed at /etc/agent/policy.yaml');
  });
});

describe('scrubEvent — chain.verify_failed + classifier.unavailable', () => {
  test('chain.verify_failed passes through (only hashes + counts)', () => {
    const event: ChainVerifyFailedEvent = {
      kind: 'chain.verify_failed',
      ts: 100,
      install_id: 'install-abc',
      broken_at: 42,
      reason: 'this_hash_mismatch',
      expected: 'sha256:expected',
      actual: 'sha256:actual',
      accepted: false,
    };
    const out = scrubEvent(event);
    expect(out).toEqual(event);
  });

  test('classifier.unavailable passes through (no PII fields)', () => {
    const event: ClassifierUnavailableEvent = {
      kind: 'classifier.unavailable',
      ts: 100,
      tool: 'bash',
      classifier_hash: 'v1',
      reason: 'threw',
      strict: false,
    };
    const out = scrubEvent(event);
    expect(out).toEqual(event);
  });
});

describe('createScrubbingTelemetrySink', () => {
  test('forwards every event through scrubEvent before reaching the inner sink', () => {
    const inner = createRecordingTelemetrySink();
    const sink = createScrubbingTelemetrySink(inner);
    sink.emit(
      basePermissionEvent({
        capabilities: ['read-fs:/home/john/secrets'],
      }),
    );
    const events = inner.events();
    expect(events).toHaveLength(1);
    const event = events[0] as PermissionDecisionEvent;
    expect(event.capabilities).toEqual(['read-fs:<path>']);
  });

  test('inner.emit throwing propagates (slice does not add its own try/catch)', () => {
    const throwingInner = {
      emit: (_event: TelemetryEvent) => {
        throw new Error('inner blew up');
      },
    };
    const sink = createScrubbingTelemetrySink(throwingInner);
    expect(() => sink.emit(basePermissionEvent())).toThrow('inner blew up');
  });

  test('options forward to scrubEvent', () => {
    const inner = createRecordingTelemetrySink();
    const sink = createScrubbingTelemetrySink(inner, { redactPaths: false });
    sink.emit(
      basePermissionEvent({
        capabilities: ['read-fs:/x'],
      }),
    );
    const event = inner.events()[0] as PermissionDecisionEvent;
    expect(event.capabilities[0]).toBe('read-fs:/x');
  });

  test('default options scrub both paths AND hosts', () => {
    const inner = createRecordingTelemetrySink();
    const sink = createScrubbingTelemetrySink(inner);
    sink.emit(
      basePermissionEvent({
        capabilities: ['read-fs:/x', 'net-egress:foo.com'],
      }),
    );
    const event = inner.events()[0] as PermissionDecisionEvent;
    expect(event.capabilities).toEqual(['read-fs:<path>', 'net-egress:<host>']);
  });
});
