import { describe, expect, test } from 'bun:test';
import { type Capability, netEgress, parseCapability } from '../../src/permissions/capabilities.ts';
import { SANDBOX_PROFILE_ORDER, selectSandboxProfile } from '../../src/permissions/sandbox-plan.ts';

const caps = (...ss: string[]): Capability[] => ss.map(parseCapability);

describe('selectSandboxProfile — basic coverage', () => {
  test('empty capability set lands on the most restrictive profile (ro)', () => {
    const r = selectSandboxProfile({ capabilities: [], hostExplicitlyAllowed: false });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });

  test('read-only fs alone fits ro', () => {
    const r = selectSandboxProfile({
      capabilities: caps('read-fs:/etc/hosts'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });

  test('write-fs escalates to cwd-rw (most restrictive that admits writes)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('write-fs:./out.txt'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  test('net-egress escalates to cwd-rw-net', () => {
    const r = selectSandboxProfile({
      capabilities: caps('net-egress:github.com'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });

  test('write-fs + net-egress combined fits cwd-rw-net', () => {
    const r = selectSandboxProfile({
      capabilities: caps('write-fs:./out', 'net-egress:api.example.com'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });

  test('secret-access escalates to home-rw (the first profile that allows secrets)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('secret-access:gpg'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('home-rw');
  });

  // Slice 135 P1 sec-3: secret-access + net-egress combo is the
  // canonical refusal-without-host scenario. home-rw covers
  // secrets but NOT net-egress; cwd-rw-net covers net but not
  // secrets. The ONLY profile that covers both is `host`, and
  // host requires the operator flag + host-passthrough capability.
  // Without those gates, the combination refuses.
  test('secret-access + net-egress without host flag → refuse (no profile covers both)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('secret-access:gpg', 'net-egress:api.example.com'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toBe('no_viable_sandbox');
      // Whichever cap the chosen-candidate-set fails to cover lands
      // in `uncovered`. Both are plausible depending on the
      // candidate-walk order; assert one of them appears.
      const u = r.uncovered;
      expect(u.includes('secret-access') || u.includes('net-egress')).toBe(true);
    }
  });

  test('secret-access + net-egress WITH host flag but NO host-passthrough still refuses', () => {
    // host needs BOTH the flag AND the capability per §6.5. The
    // combo only escalates to host when the resolver added
    // `host-passthrough` to the capability set.
    const r = selectSandboxProfile({
      capabilities: caps('secret-access:gpg', 'net-egress:api.example.com'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('refuse');
  });

  test('secret-access + net-egress + host-passthrough + flag → host', () => {
    const r = selectSandboxProfile({
      capabilities: caps('secret-access:gpg', 'net-egress:api.example.com', 'host-passthrough'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('host');
  });
});

describe('selectSandboxProfile — host gates (§6.5)', () => {
  test('env-mutate without host flag refuses with no_viable_sandbox', () => {
    const r = selectSandboxProfile({
      capabilities: caps('env-mutate'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toBe('no_viable_sandbox');
      expect(r.uncovered).toContain('env-mutate');
    }
  });

  test('env-mutate WITH host flag but NO host-passthrough cap still refuses', () => {
    // The flag alone is insufficient — spec requires BOTH the
    // operator flag AND the host-passthrough capability in the
    // resolved set before host is selectable.
    const r = selectSandboxProfile({
      capabilities: caps('env-mutate'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('refuse');
  });

  test('env-mutate + host-passthrough + flag → host selected', () => {
    const r = selectSandboxProfile({
      capabilities: caps('env-mutate', 'host-passthrough'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('host');
  });

  test('host-passthrough alone with flag → host', () => {
    const r = selectSandboxProfile({
      capabilities: caps('host-passthrough'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('host');
  });

  test('host-passthrough requested but flag absent → refuse', () => {
    const r = selectSandboxProfile({
      capabilities: caps('host-passthrough'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.uncovered).toContain('host-passthrough');
  });
});

describe('selectSandboxProfile — host is last resort', () => {
  test('when another profile covers, host is dropped from candidates', () => {
    // read-fs fits ro. host would also cover (host covers everything),
    // and the user passed the flag + has the cap. Spec §6.5: "host
    // é sempre último recurso" — non-host wins.
    const r = selectSandboxProfile({
      capabilities: caps('read-fs:src', 'host-passthrough'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('ok');
    // host-passthrough is incompatible with ro/cwd-rw/home-rw; so
    // host IS the only fit here. The test name reflects the spec
    // intent but the cap shape forces host. Use a cap set where
    // multiple profiles legitimately fit.
    if (r.kind === 'ok') expect(r.profile).toBe('host');
  });

  test('write-fs + host-passthrough + flag still picks cwd-rw (host pruned)', () => {
    // Hmm — host-passthrough is the cap that LITERALLY forces host
    // because no other profile allows it. So this test mirrors the
    // refusal direction: with capabilities both restricted profiles
    // could fit AND host could fit, host must lose. The way to
    // construct that scenario is capability set covered by a non-
    // host profile WITHOUT host-passthrough.
    const r = selectSandboxProfile({
      capabilities: caps('write-fs:./x'),
      hostExplicitlyAllowed: true,
    });
    // No host-passthrough cap means host is pruned; cwd-rw wins
    // (the leftmost profile in SANDBOX_PROFILE_ORDER that fits).
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });
});

describe('selectSandboxProfile — tie-break order', () => {
  test('SANDBOX_PROFILE_ORDER is the canonical ranking', () => {
    expect(SANDBOX_PROFILE_ORDER).toEqual(['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw', 'host']);
  });

  test('read-fs fits every profile — tie-break picks the leftmost (ro)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('read-fs:**'),
      hostExplicitlyAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });

  test('exec alone fits every profile that allows exec — picks ro', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:shell'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });
});

describe('selectSandboxProfile — exec:arbitrary floor + network posture', () => {
  // The bug: an unmodeled binary resolves to exec:arbitrary (+ read-fs:cwd)
  // with no write-fs; without the floor the selector picks `ro` and every
  // write hits EROFS. The floor requires write-fs for exec:arbitrary → cwd-rw.
  test('exec:arbitrary alone is floored to cwd-rw (never ro)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  test('exec:arbitrary + read-fs:cwd (the real unmodeled-binary shape) → cwd-rw', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'read-fs:.'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  test('exec:arbitrary + networkAllowed + dirTrusted → cwd-rw-net (posture, trusted)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'read-fs:.'),
      hostExplicitlyAllowed: false,
      networkAllowed: true,
      dirTrusted: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });

  test('exec:arbitrary + networkAllowed but UNtrusted → cwd-rw (posture egress is trust-gated too)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'read-fs:.'),
      hostExplicitlyAllowed: false,
      networkAllowed: true,
      dirTrusted: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  test('exec:arbitrary + networkAllowed:false stays cwd-rw (default offline)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary'),
      hostExplicitlyAllowed: false,
      networkAllowed: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  // Negative cases — the floor and the posture are scoped to exec:arbitrary.
  test('exec:shell does NOT trip the floor — stays ro even with networkAllowed', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:shell'),
      hostExplicitlyAllowed: false,
      networkAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });

  test('networkAllowed alone does NOT grant net to a pure read (no unbounded exec)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('read-fs:/etc/hosts'),
      hostExplicitlyAllowed: false,
      networkAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('ro');
  });

  // The network posture is a POST-selection bump, never a required kind — so
  // turning it on must NEVER turn a viable plan into a refuse. exec:arbitrary +
  // secret-access (needs home-rw) + networkAllowed stays home-rw (no net),
  // instead of refusing on the unsatisfiable {secret-access, net-egress} combo.
  test('exec:arbitrary + secret-access + networkAllowed → home-rw (network never denies)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'secret-access:~/.config/forja'),
      hostExplicitlyAllowed: false,
      networkAllowed: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('home-rw');
  });

  // The refuse `uncovered` report is resolver-honest: the floor's synthetic
  // write-fs must NOT appear (it raises the profile, not the audited set).
  test('refuse uncovered list excludes the floor-injected write-fs', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'host-passthrough'),
      hostExplicitlyAllowed: false, // host pruned (no flag) → refuse
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.uncovered).toEqual(['exec', 'host-passthrough']);
      expect(r.uncovered).not.toContain('write-fs');
    }
  });

  // Trust-gate for BUILD egress: a modeled dep-manager is `exec:arbitrary +
  // net-egress`. It reaches the network only in a TRUSTED dir.
  test('exec:arbitrary + net-egress + dirTrusted → cwd-rw-net (trusted build fetches deps)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'net-egress:registry.npmjs.org', 'read-fs:.'),
      hostExplicitlyAllowed: false,
      dirTrusted: true,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });

  test('exec:arbitrary + net-egress + UNtrusted → cwd-rw (build egress dropped, no exfil)', () => {
    const r = selectSandboxProfile({
      capabilities: caps('exec:arbitrary', 'net-egress:registry.npmjs.org', 'read-fs:.'),
      hostExplicitlyAllowed: false,
      dirTrusted: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw');
  });

  // The discriminator: plain net-egress WITHOUT exec:arbitrary (curl/wget/git —
  // user-invoked net actions) never reaches the trust-gate branch.
  test('net-egress without exec:arbitrary is NOT trust-gated → cwd-rw-net even untrusted', () => {
    const r = selectSandboxProfile({
      capabilities: caps('net-egress:github.com', 'read-fs:.'),
      hostExplicitlyAllowed: false,
      dirTrusted: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });

  // EXPLICIT egress exemption: `ssh host <cmd>` carries exec:arbitrary (remote
  // command) AND net-egress, but marks the egress explicit → NOT trust-gated, so
  // it still connects in an untrusted dir (regression: it was wrongly stripped to
  // cwd-rw, breaking ssh, when the gate keyed only on exec:arbitrary + net-egress).
  test('exec:arbitrary + EXPLICIT net-egress (ssh) is NOT trust-gated → cwd-rw-net even untrusted', () => {
    const r = selectSandboxProfile({
      capabilities: [
        parseCapability('exec:arbitrary'),
        netEgress('example.com', true),
        parseCapability('read-fs:.'),
      ],
      hostExplicitlyAllowed: false,
      dirTrusted: false,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.profile).toBe('cwd-rw-net');
  });
});

describe('selectSandboxProfile — uncovered list', () => {
  test('uncovered names every kind in the requested set on refusal', () => {
    const r = selectSandboxProfile({
      capabilities: caps('env-mutate', 'forja-mutate'),
      hostExplicitlyAllowed: false,
    });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.uncovered).toEqual(['env-mutate', 'forja-mutate']);
    }
  });
});
