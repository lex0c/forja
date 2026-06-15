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
import {
  createScrubbingTelemetrySink,
  scrubEvent,
  scrubFreeformText,
} from '../../src/telemetry/scrubbing.ts';

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
    // Slice 99 (R10 #51): `exec-fs` was dead code — no such
    // CapabilityKind exists. The execution kind is `exec` with a
    // fixed-enum scope (shell/python/node/arbitrary) that carries
    // no path content. Dropped from the kind list AND from this
    // fixture.
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: [
          'read-fs:/home/john/secrets.env',
          'write-fs:/Users/jane/proj/db.sqlite',
          'delete-fs:/var/log/x',
          'git-write:/work/private-repo',
        ],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual([
      'read-fs:<path>',
      'write-fs:<path>',
      'delete-fs:<path>',
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
      reason: 'failed at /etc/forja/policy.yaml',
    };
    const out = scrubEvent(event, { redactPaths: false }) as StateTransitionEvent;
    expect(out.reason).toBe('failed at /etc/forja/policy.yaml');
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

// Slice 99 — R10 scrubbing hardening. Four coordinated fixes
// land here: secret-access joins the path-axis kinds (#46),
// net-ingress joins the host-axis kinds (#47), PATH_REGEX
// covers Windows + tilde shapes alongside posix (#49), and
// scrubReason now also redacts hosts via URL + IPv4 patterns
// (#50). The pre-slice `exec-fs` entry in FS_KINDS was dead
// code — no such CapabilityKind exists — and is removed (#51).
describe('scrubEvent — slice 99 R10 hardening', () => {
  test('secret-access scope scrubs as path (R10 #46)', () => {
    // The scope of a secret-access cap is a vault namespace or
    // credential path. Pre-slice this leaked verbatim to the
    // metric stream — an external observer could see WHICH
    // credential store the operator authorized and target it.
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: [
          'secret-access:/run/secrets/db_password',
          'secret-access:vault://prod/api-keys',
        ],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual(['secret-access:<path>', 'secret-access:<path>']);
  });

  test('net-ingress scope scrubs as host (R10 #47)', () => {
    // The port number alone reveals service identity (5432 =
    // postgres, 6443 = k8s API). Pre-slice this passed through.
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['net-ingress:5432', 'net-ingress:0.0.0.0:6443'],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual(['net-ingress:<host>', 'net-ingress:<host>']);
  });

  test('Windows-style paths in reason redact (R10 #49)', () => {
    // C:\Users\foo and UNC \\server\share both leak filesystem
    // layout. Pre-slice PATH_REGEX matched only posix `/...`.
    const out = scrubEvent({
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'config at C:\\Users\\admin\\config.toml or \\\\fileserver\\share\\policy.toml',
    } satisfies StateTransitionEvent) as StateTransitionEvent;
    expect(out.reason).not.toContain('C:\\Users');
    expect(out.reason).not.toContain('\\\\fileserver');
    expect(out.reason).toContain('<path>');
  });

  test('tilde-rooted paths in reason redact (R10 #49)', () => {
    // Reasons emitted by operator-quoted shells may carry
    // unexpanded `~/...` forms. Pre-slice these slipped through.
    const out = scrubEvent({
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'credential file ~/.ssh/id_rsa unreadable; also ~admin/.aws/credentials',
    } satisfies StateTransitionEvent) as StateTransitionEvent;
    expect(out.reason).not.toContain('~/.ssh');
    expect(out.reason).not.toContain('~admin');
    expect(out.reason).toContain('<path>');
  });

  test('URL with scheme in reason redacts as host (R10 #50)', () => {
    // The original scrubReason ignored hosts entirely; a reason
    // quoting an internal corp URL leaked infrastructure detail.
    const out = scrubEvent({
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'fetch from https://internal.corp.example.com/api/secret failed',
    } satisfies StateTransitionEvent) as StateTransitionEvent;
    expect(out.reason).not.toContain('internal.corp.example.com');
    expect(out.reason).toContain('<host>');
  });

  test('IPv4 address in reason redacts as host', () => {
    // 192.168.x.y / 10.x.x.x / 172.16-31.x.x are RFC 1918 internal
    // ranges; surfacing them in metrics leaks the operator's
    // private network layout to the OTEL backend.
    const out = scrubEvent({
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'bwrap couldn’t reach 10.0.0.5:5432 (postgres)',
    } satisfies StateTransitionEvent) as StateTransitionEvent;
    expect(out.reason).not.toContain('10.0.0.5');
    expect(out.reason).toContain('<host>');
  });

  test('host scrubbing honors redactHosts=false (pure host shape)', () => {
    // Opting out of host redaction preserves bare IPs and bare
    // hostnames — used by local-only dev loops where the metric
    // stream doesn't leave the host. URLs containing paths still
    // get caught under the redactPaths axis (the URL has both a
    // host AND a path component); to test the host-axis toggle
    // cleanly, use a bare IPv4 with no path content.
    const out = scrubEvent(
      {
        kind: 'state.transition',
        ts: 1,
        from: 'ready',
        to: 'degraded',
        reason: 'connect to 10.0.0.5 failed',
      } satisfies StateTransitionEvent,
      { redactHosts: false },
    ) as StateTransitionEvent;
    expect(out.reason).toContain('10.0.0.5');
  });

  test('version strings are NOT misclassified as IPv4', () => {
    // "v1.2.3" has 3 dots but no leading word boundary that
    // matches the 4-octet pattern. Pin the false-positive
    // boundary so future tightening of the regex doesn't
    // regress.
    const out = scrubEvent({
      kind: 'state.transition',
      ts: 1,
      from: 'ready',
      to: 'degraded',
      reason: 'engine version 1.2.3 ready; build 99.99',
    } satisfies StateTransitionEvent) as StateTransitionEvent;
    expect(out.reason).toContain('1.2.3');
    expect(out.reason).toContain('99.99');
  });

  test('sandbox.degraded_active reason scrubs paths + hosts together', () => {
    // The slice-92 SandboxDegradedActive event surfaces operator-
    // facing reasons that often quote both. Verify both axes
    // fire on a single reason string.
    const out = scrubEvent({
      kind: 'sandbox.degraded_active',
      ts: 1,
      sessionId: 'sess',
      reason: 'bwrap at /usr/local/bin/bwrap rejected request from https://corp.example/api',
      firstEmission: true,
    }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
    expect(out.reason).not.toContain('/usr/local/bin/bwrap');
    expect(out.reason).not.toContain('corp.example');
  });

  // Slice 125 (R2 P1) + Slice 127 (R3 P1): URL_REGEX siblings —
  // IPv6 brackets, git SSH, domain:port. Pre-slice scrubReason
  // only matched http(s)://, IPv4, and the path family.
  describe('URL_REGEX siblings — IPv6 / git SSH / domain:port (slices 125 + 127)', () => {
    test('IPv6 bracketed scrubs', () => {
      const out = scrubEvent({
        kind: 'sandbox.degraded_active',
        ts: 1,
        sessionId: 'sess',
        reason: 'request to [::1]:8080 refused',
        firstEmission: true,
      }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
      expect(out.reason).not.toContain('[::1]:8080');
    });

    test('IPv6 longer address scrubs', () => {
      const out = scrubEvent({
        kind: 'sandbox.degraded_active',
        ts: 1,
        sessionId: 'sess',
        reason: 'gateway at [2001:db8::dead:beef]:443 unreachable',
        firstEmission: true,
      }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
      expect(out.reason).not.toContain('2001:db8');
    });

    test('git SSH (user@host:path) scrubs', () => {
      const out = scrubEvent({
        kind: 'sandbox.degraded_active',
        ts: 1,
        sessionId: 'sess',
        reason: 'clone from git@github.com:internal/private-repo.git refused',
        firstEmission: true,
      }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
      expect(out.reason).not.toContain('github.com');
      expect(out.reason).not.toContain('private-repo');
    });

    test('domain:port scrubs', () => {
      const out = scrubEvent({
        kind: 'sandbox.degraded_active',
        ts: 1,
        sessionId: 'sess',
        reason: 'db at internal.corp.example:5432 down',
        firstEmission: true,
      }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
      expect(out.reason).not.toContain('internal.corp.example');
    });

    test('single-token (no-dot) host is NOT scrubbed (DOMAIN_PORT_REGEX requires a dot)', () => {
      // Conservative trade-off documented in slice 125: avoid
      // false-positives on `tool.version:1.2.3` style strings.
      // `localhost:8080` passes through.
      const out = scrubEvent({
        kind: 'sandbox.degraded_active',
        ts: 1,
        sessionId: 'sess',
        reason: 'binding localhost:8080',
        firstEmission: true,
      }) as Extract<TelemetryEvent, { kind: 'sandbox.degraded_active' }>;
      expect(out.reason).toContain('localhost:8080');
    });
  });

  describe('scrubFreeformText — C0/C1 control char stripping (H3 retrieval review)', () => {
    test('strips ESC and ANSI SGR sequences (terminal cannot be manipulated)', () => {
      // A reason carrying ANSI clear-screen + colors would otherwise
      // execute when surfaced via /agent retrieval audit / replay.
      // Stripping the leading ESC neutralizes the whole sequence —
      // `[2J[31m` becomes literal text, not a control directive.
      const malicious = 'before \x1b[2Jmiddle \x1b[31mred\x1b[0m after';
      const cleaned = scrubFreeformText(malicious);
      expect(cleaned).not.toContain('\x1b');
      expect(cleaned).toBe('before [2Jmiddle [31mred[0m after');
    });

    test('strips OSC, BEL, NUL, DEL and other C0 controls', () => {
      const malicious = 'a\x00b\x07c\x1b]0;title\x07d\x7fe';
      const cleaned = scrubFreeformText(malicious);
      expect(cleaned).toBe('ab' + 'c]0;titlede');
      for (const code of [0x00, 0x07, 0x1b, 0x7f]) {
        expect(cleaned).not.toContain(String.fromCharCode(code));
      }
    });

    test('strips C1 controls (0x80-0x9F)', () => {
      const malicious = `a${String.fromCharCode(0x9b)}[31mb${String.fromCharCode(0x80)}c`;
      const cleaned = scrubFreeformText(malicious);
      expect(cleaned).toBe('a[31mbc');
    });

    test('preserves TAB / LF / CR (legitimate in stack traces and multi-line stderr)', () => {
      // `worker.crashed.stderr` legitimately carries stack traces
      // with newlines; reasons may include tab-formatted lists.
      // Whitespace controls aren't an attack vector for terminal
      // manipulation, so we leave them alone.
      const multiline = 'first line\nsecond line\twith\ttabs\rand cr';
      expect(scrubFreeformText(multiline)).toBe(multiline);
    });

    test('control stripping runs BEFORE path/host regex (no smuggling)', () => {
      // `\x1b/home/secrets` pre-strip would not match PATH_REGEX_POSIX
      // (the `\x1b` breaks word boundary). After stripping, the path
      // emerges and gets redacted. Verifies ordering.
      const sneaky = 'load \x1b/home/op/secrets.env now';
      const cleaned = scrubFreeformText(sneaky);
      expect(cleaned).not.toContain('/home/op/secrets.env');
      expect(cleaned).toContain('<path>');
    });

    test('ordinary text passes through unchanged (no controls, no path/host shapes)', () => {
      const benign = 'BM25 match — score 0.42 sealed';
      expect(scrubFreeformText(benign)).toBe(benign);
    });
  });

  test('exec-fs (removed dead code) no longer scrubs (R10 #51)', () => {
    // Defensive: ensure a hypothetical `exec-fs:<path>` cap
    // is NOT scrubbed — the kind isn't real and the entry was
    // removed from FS_KINDS. A future addition that re-introduces
    // it would have to land in CapabilityKind first; until then
    // the scrubber leaves it alone (passes through any unknown
    // kind unchanged).
    const out = scrubEvent(
      basePermissionEvent({
        capabilities: ['exec-fs:/usr/local/bin/script'],
      }),
    ) as PermissionDecisionEvent;
    expect(out.capabilities).toEqual(['exec-fs:/usr/local/bin/script']);
  });
});
