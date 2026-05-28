import { describe, expect, test } from 'bun:test';
import {
  type Capability,
  INVALID_SCOPE_SENTINEL,
  capabilityCovers,
  capabilityCoversCwdAware,
  capabilityEquals,
  effectiveCovers,
  exec,
  formatCapability,
  isCapabilityKind,
  netEgress,
  parseCapability,
  readFs,
  sortCapabilities,
  writeFs,
} from '../../src/permissions/capabilities.ts';

describe('isCapabilityKind', () => {
  test.each([
    'read-fs',
    'write-fs',
    'delete-fs',
    'exec',
    'net-egress',
    'net-ingress',
    'secret-access',
    'git-write',
    'env-mutate',
    'agent-mutate',
    'host-passthrough',
  ])('accepts %s', (s) => {
    expect(isCapabilityKind(s)).toBe(true);
  });
  test.each(['read', 'write', 'fs-read', 'unknown', ''])('rejects %s', (s) => {
    expect(isCapabilityKind(s)).toBe(false);
  });
});

describe('formatCapability + parseCapability', () => {
  test.each<[Capability, string]>([
    [{ kind: 'read-fs', scope: './src/**' }, 'read-fs:./src/**'],
    [{ kind: 'write-fs', scope: '/work/proj/dist' }, 'write-fs:/work/proj/dist'],
    [{ kind: 'delete-fs', scope: '/tmp/x' }, 'delete-fs:/tmp/x'],
    [{ kind: 'exec', scope: 'shell' }, 'exec:shell'],
    [{ kind: 'net-egress', scope: 'api.github.com' }, 'net-egress:api.github.com'],
    [{ kind: 'net-ingress', scope: '8080-9000' }, 'net-ingress:8080-9000'],
    [{ kind: 'secret-access', scope: 'aws' }, 'secret-access:aws'],
    [{ kind: 'git-write', scope: 'origin' }, 'git-write:origin'],
    [{ kind: 'env-mutate', scope: null }, 'env-mutate'],
    [{ kind: 'agent-mutate', scope: null }, 'agent-mutate'],
    [{ kind: 'host-passthrough', scope: null }, 'host-passthrough'],
  ])('round-trips %p', (cap, expected) => {
    expect(formatCapability(cap)).toBe(expected);
    expect(parseCapability(expected)).toEqual(cap);
  });

  test('scope containing colon is preserved verbatim', () => {
    const cap = parseCapability('net-ingress:8080:9000');
    expect(cap.scope).toBe('8080:9000');
    expect(formatCapability(cap)).toBe('net-ingress:8080:9000');
  });

  test('scope=null on scoped kind emits the invalid sentinel (not wildcard)', () => {
    // Programming-bug shape: resolver constructed
    // `{ kind: 'read-fs', scope: null }` instead of using `readFs(p)`.
    // Pre-fix the format coerced to `read-fs:*` (silent widen — a
    // permissive policy would have happily covered this). Post-fix
    // emits `<invalid>` sentinel: grepable in audit, refuse on
    // coverage (see capabilityCovers tests).
    const bug: Capability = { kind: 'read-fs', scope: null };
    expect(formatCapability(bug)).toBe(`read-fs:${INVALID_SCOPE_SENTINEL}`);
    const bugWrite: Capability = { kind: 'write-fs', scope: null };
    expect(formatCapability(bugWrite)).toBe(`write-fs:${INVALID_SCOPE_SENTINEL}`);
  });
});

describe('capabilityCovers — invalid-scope sentinel guard', () => {
  // The sentinel emitted by formatCapability when scope=null reaches
  // capabilityCovers via re-parsed audit rows / IPC marshaling.
  // Coverage MUST refuse on either side: a permissive parent like
  // `read-fs:**` must NOT cover the bug cap, and a bug parent must
  // NOT cover a legitimate child.
  const invalidCap = (kind: 'read-fs' | 'write-fs'): Capability => ({
    kind,
    scope: INVALID_SCOPE_SENTINEL,
  });

  test('permissive parent does NOT cover the invalid-scope child', () => {
    const parent = readFs('**');
    expect(capabilityCovers(parent, invalidCap('read-fs'))).toBe(false);
  });

  test('invalid-scope parent does NOT cover a legitimate child', () => {
    expect(capabilityCovers(invalidCap('read-fs'), readFs('src/x.ts'))).toBe(false);
  });

  test('invalid-scope on both sides does NOT cover', () => {
    expect(capabilityCovers(invalidCap('read-fs'), invalidCap('read-fs'))).toBe(false);
  });

  test('capabilityCoversCwdAware mirrors the guard for fs kinds', () => {
    expect(capabilityCoversCwdAware(readFs('**'), invalidCap('read-fs'), '/work')).toBe(false);
    expect(capabilityCoversCwdAware(invalidCap('read-fs'), readFs('src/x.ts'), '/work')).toBe(
      false,
    );
  });
});

describe('parseCapability — errors', () => {
  test('rejects empty input', () => {
    expect(() => parseCapability('')).toThrow();
  });
  test('rejects unknown kind', () => {
    expect(() => parseCapability('bogus:x')).toThrow(/unknown kind/);
    expect(() => parseCapability('unknownkind')).toThrow(/unknown kind/);
  });
  test('scoped kind missing scope throws', () => {
    expect(() => parseCapability('read-fs:')).toThrow(/non-empty scope/);
  });
  test('scope-less kind with scope throws', () => {
    expect(() => parseCapability('env-mutate:nope')).toThrow(/must not carry a scope/);
  });
  test('scoped kind without colon throws', () => {
    expect(() => parseCapability('read-fs')).toThrow(/requires a scope/);
  });
});

describe('capabilityEquals', () => {
  test('exact match', () => {
    expect(capabilityEquals(readFs('./src'), readFs('./src'))).toBe(true);
  });
  test('different scope', () => {
    expect(capabilityEquals(readFs('./src'), readFs('./tests'))).toBe(false);
  });
  test('different kind', () => {
    expect(capabilityEquals(readFs('./src'), writeFs('./src'))).toBe(false);
  });
  test('scope-less kinds', () => {
    expect(
      capabilityEquals({ kind: 'env-mutate', scope: null }, { kind: 'env-mutate', scope: null }),
    ).toBe(true);
  });
});

describe('sortCapabilities', () => {
  test('lex-sorts by formatted form', () => {
    const caps = [
      writeFs('./dist'),
      readFs('./src'),
      { kind: 'env-mutate' as const, scope: null },
      { kind: 'net-egress' as const, scope: 'api.example.com' },
    ];
    const sorted = sortCapabilities(caps);
    expect(sorted.map(formatCapability)).toEqual([
      'env-mutate',
      'net-egress:api.example.com',
      'read-fs:./src',
      'write-fs:./dist',
    ]);
  });

  test('order-independent: two permutations sort identically', () => {
    const a = [readFs('./src'), writeFs('./dist'), { kind: 'env-mutate' as const, scope: null }];
    const b = [writeFs('./dist'), { kind: 'env-mutate' as const, scope: null }, readFs('./src')];
    expect(sortCapabilities(a).map(formatCapability)).toEqual(
      sortCapabilities(b).map(formatCapability),
    );
  });

  test('does not mutate input', () => {
    const caps = [writeFs('./dist'), readFs('./src')];
    const before = caps.map(formatCapability);
    sortCapabilities(caps);
    expect(caps.map(formatCapability)).toEqual(before);
  });
});

// Slice 95 — PERMISSION_ENGINE.md §10.1 child-engine evaluation
// stage. The cwd-aware coverage variant bridges the relative-
// vs-absolute scope asymmetry between the operator-authored
// envelope (declared by the model, persisted as `read-fs:src/**`)
// and the resolver-emitted target (absolute, `read-fs:/abs/cwd/
// src/auth/login.ts`). Verified against the spec's three
// invariants: literal-equality short-circuit, universal-`**`
// short-circuit, and `matchPath` for everything else.
describe('capabilityCoversCwdAware (slice 95)', () => {
  const CWD = '/work/proj';

  test('relative prefix glob covers absolute target inside cwd', () => {
    const parent: Capability = { kind: 'read-fs', scope: 'src/**' };
    const child: Capability = { kind: 'read-fs', scope: '/work/proj/src/auth/login.ts' };
    expect(capabilityCoversCwdAware(parent, child, CWD)).toBe(true);
  });

  test('relative prefix glob does NOT cover absolute target outside cwd', () => {
    const parent: Capability = { kind: 'read-fs', scope: 'src/**' };
    const child: Capability = { kind: 'read-fs', scope: '/etc/passwd' };
    expect(capabilityCoversCwdAware(parent, child, CWD)).toBe(false);
  });

  test('universal `**` covers any fs target (including outside cwd)', () => {
    // Slice-9 contract: `**` and `*` are universal — preserved
    // here even when the target is absolute and outside cwd.
    // Same semantics as policy YAML `allow_paths: ['**']`.
    const parent: Capability = { kind: 'read-fs', scope: '**' };
    const insideCwd: Capability = { kind: 'read-fs', scope: '/work/proj/src/x.ts' };
    const outsideCwd: Capability = { kind: 'read-fs', scope: '/etc/passwd' };
    expect(capabilityCoversCwdAware(parent, insideCwd, CWD)).toBe(true);
    expect(capabilityCoversCwdAware(parent, outsideCwd, CWD)).toBe(true);
  });

  test('literal equality short-circuit (relative vs relative)', () => {
    const parent: Capability = { kind: 'read-fs', scope: 'src/index.ts' };
    const child: Capability = { kind: 'read-fs', scope: 'src/index.ts' };
    expect(capabilityCoversCwdAware(parent, child, CWD)).toBe(true);
  });

  test('different kinds never cover', () => {
    expect(capabilityCoversCwdAware(readFs('src/**'), writeFs('/work/proj/src/x.ts'), CWD)).toBe(
      false,
    );
  });

  test('non-fs kinds defer to capabilityCovers (exec hierarchy)', () => {
    // `exec:arbitrary` umbrella covers `exec:shell`; `exec:shell`
    // does NOT cover `exec:python`. Same contract as
    // `capabilityCovers` — no cwd resolution applies.
    expect(capabilityCoversCwdAware(exec('arbitrary'), exec('shell'), CWD)).toBe(true);
    expect(capabilityCoversCwdAware(exec('shell'), exec('python'), CWD)).toBe(false);
    expect(capabilityCoversCwdAware(exec('shell'), exec('shell'), CWD)).toBe(true);
  });

  test('non-fs kinds defer to capabilityCovers (net-egress)', () => {
    expect(capabilityCoversCwdAware(netEgress('*'), netEgress('github.com'), CWD)).toBe(true);
    expect(capabilityCoversCwdAware(netEgress('github.com'), netEgress('evil.com'), CWD)).toBe(
      false,
    );
  });

  test('write-fs and delete-fs use cwd-aware matching like read-fs', () => {
    const writeParent: Capability = { kind: 'write-fs', scope: 'dist/**' };
    const writeInside: Capability = { kind: 'write-fs', scope: '/work/proj/dist/bundle.js' };
    const writeOutside: Capability = { kind: 'write-fs', scope: '/etc/passwd' };
    expect(capabilityCoversCwdAware(writeParent, writeInside, CWD)).toBe(true);
    expect(capabilityCoversCwdAware(writeParent, writeOutside, CWD)).toBe(false);

    const delParent: Capability = { kind: 'delete-fs', scope: 'tmp/**' };
    const delInside: Capability = { kind: 'delete-fs', scope: '/work/proj/tmp/scratch.txt' };
    const delOutside: Capability = { kind: 'delete-fs', scope: '/work/proj/src/index.ts' };
    expect(capabilityCoversCwdAware(delParent, delInside, CWD)).toBe(true);
    expect(capabilityCoversCwdAware(delParent, delOutside, CWD)).toBe(false);
  });

  test('null scopes on either side fail safely (no false positive)', () => {
    // Scoped kinds with `scope: null` are programmer errors — the
    // helper should refuse rather than admit a malformed pair.
    const malformed: Capability = { kind: 'read-fs', scope: null };
    const good: Capability = { kind: 'read-fs', scope: 'src/**' };
    expect(capabilityCoversCwdAware(malformed, good, CWD)).toBe(false);
    expect(capabilityCoversCwdAware(good, malformed, CWD)).toBe(false);
  });
});

describe('effectiveCovers (slice 95)', () => {
  const CWD = '/work/proj';

  test('empty resolved trivially covered regardless of effective', () => {
    // Misc-category tools produce no resolved capabilities; the
    // effective bound never blocks them.
    expect(effectiveCovers([], [], CWD)).toEqual({ covered: [], uncovered: [] });
    expect(effectiveCovers([readFs('src/**')], [], CWD)).toEqual({
      covered: [],
      uncovered: [],
    });
  });

  test('empty effective rejects every non-empty resolved (pure-LLM contract)', () => {
    // Spec §10.1: "declared_caps vazio → subagent recebe nenhuma
    // capability". A pure-LLM child trying ANY side-effect tool
    // surfaces every resolved cap as uncovered.
    const resolved = [readFs('/work/proj/src/x.ts'), writeFs('/work/proj/dist/y.js')];
    const result = effectiveCovers([], resolved, CWD);
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual(resolved);
  });

  test('narrowed envelope: some covered, some not', () => {
    const effective = [readFs('src/**')];
    const resolved = [
      readFs('/work/proj/src/auth/login.ts'),
      readFs('/etc/passwd'),
      writeFs('/work/proj/src/x.ts'),
    ];
    const result = effectiveCovers(effective, resolved, CWD);
    expect(result.covered.map(formatCapability)).toEqual(['read-fs:/work/proj/src/auth/login.ts']);
    expect(result.uncovered.map(formatCapability)).toEqual([
      'read-fs:/etc/passwd',
      'write-fs:/work/proj/src/x.ts',
    ]);
  });

  test('all covered: covered=resolved, uncovered=[]', () => {
    const effective = [readFs('**'), exec('shell')];
    const resolved = [readFs('/etc/passwd'), exec('shell')];
    const result = effectiveCovers(effective, resolved, CWD);
    expect(result.uncovered).toEqual([]);
    expect(result.covered).toEqual(resolved);
  });

  test('preserves resolved order in both partitions', () => {
    // Stable iteration matters for the audit row's capabilities_json
    // — slice 9 docstring says effective preserves declared order
    // through sortCapabilities at the boundary. The partition
    // itself stays input-ordered.
    const effective = [readFs('src/**')];
    const resolved = [
      readFs('/etc/a'), // uncovered, index 0
      readFs('/work/proj/src/b'), // covered, index 1
      readFs('/etc/c'), // uncovered, index 2
      readFs('/work/proj/src/d'), // covered, index 3
    ];
    const { covered, uncovered } = effectiveCovers(effective, resolved, CWD);
    expect(covered.map((c) => c.scope)).toEqual(['/work/proj/src/b', '/work/proj/src/d']);
    expect(uncovered.map((c) => c.scope)).toEqual(['/etc/a', '/etc/c']);
  });
});
