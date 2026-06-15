import { describe, expect, test } from 'bun:test';
import {
  type Capability,
  capabilityCovers,
  deriveParentCapabilities,
  formatCapability,
  intersectCapabilities,
  parseCapability,
} from '../../src/permissions/capabilities.ts';

const cap = (s: string): Capability => parseCapability(s);
const caps = (...ss: string[]): Capability[] => ss.map(cap);

describe('capabilityCovers — kind matching', () => {
  test('different kinds never cover', () => {
    expect(capabilityCovers(cap('read-fs:**'), cap('write-fs:foo'))).toBe(false);
    expect(capabilityCovers(cap('exec:shell'), cap('read-fs:foo'))).toBe(false);
    expect(capabilityCovers(cap('env-mutate'), cap('forja-mutate'))).toBe(false);
  });
});

describe('capabilityCovers — scope-less kinds', () => {
  test.each(['env-mutate', 'forja-mutate', 'host-passthrough'])('%s covers itself', (kind) => {
    expect(capabilityCovers(cap(kind), cap(kind))).toBe(true);
  });
});

describe('capabilityCovers — exec hierarchy', () => {
  test('exec:arbitrary covers every other exec class', () => {
    expect(capabilityCovers(cap('exec:arbitrary'), cap('exec:shell'))).toBe(true);
    expect(capabilityCovers(cap('exec:arbitrary'), cap('exec:python'))).toBe(true);
    expect(capabilityCovers(cap('exec:arbitrary'), cap('exec:node'))).toBe(true);
    expect(capabilityCovers(cap('exec:arbitrary'), cap('exec:arbitrary'))).toBe(true);
  });

  test('non-arbitrary exec only covers itself', () => {
    expect(capabilityCovers(cap('exec:shell'), cap('exec:shell'))).toBe(true);
    expect(capabilityCovers(cap('exec:shell'), cap('exec:python'))).toBe(false);
    expect(capabilityCovers(cap('exec:python'), cap('exec:node'))).toBe(false);
    // Non-arbitrary does NOT cover arbitrary (the umbrella).
    expect(capabilityCovers(cap('exec:shell'), cap('exec:arbitrary'))).toBe(false);
  });
});

describe('capabilityCovers — wildcard universals', () => {
  test('`**` covers any scope', () => {
    expect(capabilityCovers(cap('read-fs:**'), cap('read-fs:src/index.ts'))).toBe(true);
    expect(capabilityCovers(cap('read-fs:**'), cap('read-fs:/etc/hosts'))).toBe(true);
    expect(capabilityCovers(cap('net-egress:**'), cap('net-egress:api.example.com'))).toBe(true);
  });

  test('`*` covers any scope (treated as universal for cap matching)', () => {
    expect(capabilityCovers(cap('write-fs:*'), cap('write-fs:foo'))).toBe(true);
    expect(capabilityCovers(cap('net-egress:*'), cap('net-egress:github.com'))).toBe(true);
  });
});

describe('capabilityCovers — literal equality', () => {
  test('identical scopes match', () => {
    expect(capabilityCovers(cap('read-fs:src/index.ts'), cap('read-fs:src/index.ts'))).toBe(true);
    expect(
      capabilityCovers(cap('net-egress:api.github.com'), cap('net-egress:api.github.com')),
    ).toBe(true);
    expect(capabilityCovers(cap('git-write:/work/proj'), cap('git-write:/work/proj'))).toBe(true);
  });

  test('non-identical literal scopes do NOT match', () => {
    expect(capabilityCovers(cap('read-fs:src/a.ts'), cap('read-fs:src/b.ts'))).toBe(false);
    expect(capabilityCovers(cap('net-egress:github.com'), cap('net-egress:gitlab.com'))).toBe(
      false,
    );
  });
});

describe('capabilityCovers — prefix glob', () => {
  test('parent `<prefix>/**` covers child `<prefix>` and `<prefix>/...`', () => {
    expect(capabilityCovers(cap('read-fs:src/**'), cap('read-fs:src'))).toBe(true);
    expect(capabilityCovers(cap('read-fs:src/**'), cap('read-fs:src/index.ts'))).toBe(true);
    expect(capabilityCovers(cap('read-fs:src/**'), cap('read-fs:src/deep/nested/x.ts'))).toBe(true);
  });

  test('prefix does NOT cover siblings', () => {
    expect(capabilityCovers(cap('read-fs:src/**'), cap('read-fs:tests/x.ts'))).toBe(false);
    expect(capabilityCovers(cap('read-fs:src/**'), cap('read-fs:srcfoo'))).toBe(false);
  });

  test('parent `prefix/**` does NOT cover non-prefix paths', () => {
    expect(capabilityCovers(cap('read-fs:/work/proj/**'), cap('read-fs:/etc/passwd'))).toBe(false);
  });

  test('mid-pattern wildcards are NOT recognized (slice 9 minimal-but-sound)', () => {
    // `src/*/x` is a more complex pattern. The minimal solver
    // doesn't expand it; coverage is restricted to literal or
    // `<prefix>/**` shapes. Tighter patterns work via literal.
    expect(capabilityCovers(cap('read-fs:src/*/x'), cap('read-fs:src/a/x'))).toBe(false);
  });
});

describe('intersectCapabilities — empty inputs', () => {
  test('empty declared → empty effective and empty excess', () => {
    const r = intersectCapabilities(caps('read-fs:**', 'exec:shell'), []);
    expect(r.effective).toEqual([]);
    expect(r.excess).toEqual([]);
  });

  test('empty parent + non-empty declared → every declared is excess', () => {
    const r = intersectCapabilities([], caps('read-fs:x', 'env-mutate'));
    expect(r.effective).toEqual([]);
    expect(r.excess.map(formatCapability)).toEqual(['read-fs:x', 'env-mutate']);
  });

  test('empty both → empty both', () => {
    const r = intersectCapabilities([], []);
    expect(r.effective).toEqual([]);
    expect(r.excess).toEqual([]);
  });
});

describe('intersectCapabilities — coverage results', () => {
  test('declared ⊆ parent → all effective, no excess', () => {
    const parent = caps('read-fs:**', 'exec:arbitrary', 'env-mutate');
    const declared = caps('read-fs:src/a.ts', 'exec:python', 'env-mutate');
    const r = intersectCapabilities(parent, declared);
    expect(r.effective.map(formatCapability)).toEqual([
      'read-fs:src/a.ts',
      'exec:python',
      'env-mutate',
    ]);
    expect(r.excess).toEqual([]);
  });

  test('declared ⊃ parent → declared splits into effective + excess', () => {
    const parent = caps('read-fs:src/**');
    const declared = caps('read-fs:src/foo.ts', 'write-fs:src/foo.ts');
    const r = intersectCapabilities(parent, declared);
    expect(r.effective.map(formatCapability)).toEqual(['read-fs:src/foo.ts']);
    expect(r.excess.map(formatCapability)).toEqual(['write-fs:src/foo.ts']);
  });

  test('preserves declared order in effective and excess', () => {
    const parent = caps('read-fs:**');
    const declared = caps('read-fs:a', 'write-fs:b', 'read-fs:c', 'exec:shell', 'read-fs:d');
    const r = intersectCapabilities(parent, declared);
    expect(r.effective.map(formatCapability)).toEqual(['read-fs:a', 'read-fs:c', 'read-fs:d']);
    expect(r.excess.map(formatCapability)).toEqual(['write-fs:b', 'exec:shell']);
  });

  test('partial overlap with multiple parent caps', () => {
    const parent = caps('read-fs:src/**', 'exec:shell', 'env-mutate');
    const declared = caps('read-fs:src/x', 'exec:shell', 'exec:python', 'env-mutate');
    const r = intersectCapabilities(parent, declared);
    expect(r.effective.map(formatCapability)).toEqual([
      'read-fs:src/x',
      'exec:shell',
      'env-mutate',
    ]);
    expect(r.excess.map(formatCapability)).toEqual(['exec:python']);
  });
});

describe('deriveParentCapabilities — §10 policy-based parent set (slice 25)', () => {
  // Helper to satisfy Policy shape; tests focus on policy.tools.
  const policyOf = (
    tools: Record<string, unknown>,
  ): Parameters<typeof deriveParentCapabilities>[0] =>
    ({ defaults: {}, tools }) as unknown as Parameters<typeof deriveParentCapabilities>[0];

  test('empty tools section → no parent capabilities', () => {
    expect(deriveParentCapabilities(policyOf({}))).toEqual([]);
  });

  test('bash with allow rules emits the full footprint', () => {
    const caps = deriveParentCapabilities(policyOf({ bash: { allow: ['ls *'] } }));
    expect(caps.map(formatCapability).sort()).toEqual([
      'delete-fs:**',
      // exec uses `arbitrary` (umbrella class), not `**` —
      // capabilityCovers's exec branch treats `arbitrary` as the
      // hierarchy root; `**` wouldn't cover `shell`/`python`/`node`.
      'exec:arbitrary',
      'git-write:**',
      'net-egress:**',
      'read-fs:**',
      'write-fs:**',
    ]);
  });

  test('bash with ONLY confirm/deny → empty (no allow rule, no delegation)', () => {
    const caps = deriveParentCapabilities(
      policyOf({ bash: { confirm: ['git push *'], deny: ['rm -rf *'] } }),
    );
    expect(caps).toEqual([]);
  });

  test('read_file with allow_paths narrows read-fs to the path', () => {
    const caps = deriveParentCapabilities(policyOf({ read_file: { allow_paths: ['src/**'] } }));
    expect(caps.map(formatCapability)).toEqual(['read-fs:src/**']);
  });

  test('write_file/edit_file emit read-fs + write-fs per allow_path', () => {
    const caps = deriveParentCapabilities(
      policyOf({
        write_file: { allow_paths: ['./out'] },
        edit_file: { allow_paths: ['./src'] },
      }),
    );
    expect(caps.map(formatCapability).sort()).toEqual([
      'read-fs:./out',
      'read-fs:./src',
      'write-fs:./out',
      'write-fs:./src',
    ]);
  });

  test('fetch_url with allow_hosts narrows net-egress to the host', () => {
    const caps = deriveParentCapabilities(policyOf({ fetch_url: { allow_hosts: ['github.com'] } }));
    expect(caps.map(formatCapability)).toEqual(['net-egress:github.com']);
  });

  test('section with empty allow array → no delegation (operator declared NO rules)', () => {
    const caps = deriveParentCapabilities(policyOf({ bash: { allow: [] } }));
    expect(caps).toEqual([]);
  });

  test('multi-section dedupe: bash + write_file both touching read-fs/write-fs emit each once', () => {
    const caps = deriveParentCapabilities(
      policyOf({
        bash: { allow: ['ls *'] },
        write_file: { allow_paths: ['./out'] },
      }),
    );
    const kinds = caps.map((c) => c.kind);
    // Each kind appears at most once.
    expect(new Set(kinds).size).toBe(kinds.length);
    // bash footprint is fully covered; write_file contributes nothing new.
    expect(kinds.sort()).toEqual([
      'delete-fs',
      'exec',
      'git-write',
      'net-egress',
      'read-fs',
      'write-fs',
    ]);
  });

  test('derived set covers intersection of typical declared subagent capabilities', () => {
    // End-to-end sanity: a parent policy with bash+allow + read_file
    // gives a subagent enough headroom to declare `read-fs:src/x`
    // and `exec:python` and have both survive intersection.
    const parent = deriveParentCapabilities(
      policyOf({ bash: { allow: ['*'] }, read_file: { allow_paths: ['**'] } }),
    );
    const declared = ['read-fs:src/index.ts', 'exec:python'].map(parseCapability);
    const { effective, excess } = intersectCapabilities(parent, declared);
    expect(effective.map(formatCapability)).toEqual(['read-fs:src/index.ts', 'exec:python']);
    expect(excess).toEqual([]);
  });
});

describe('deriveParentCapabilities — §10 scope narrowing (slice 26)', () => {
  const policyOf = (
    tools: Record<string, unknown>,
  ): Parameters<typeof deriveParentCapabilities>[0] =>
    ({ defaults: {}, tools }) as unknown as Parameters<typeof deriveParentCapabilities>[0];

  test('multiple allow_paths emit one cap per path (no spurious universal)', () => {
    const caps = deriveParentCapabilities(
      policyOf({ read_file: { allow_paths: ['src/**', 'tests/**'] } }),
    );
    expect(caps.map(formatCapability).sort()).toEqual(['read-fs:src/**', 'read-fs:tests/**']);
  });

  test('multiple allow_hosts emit one cap per host', () => {
    const caps = deriveParentCapabilities(
      policyOf({ fetch_url: { allow_hosts: ['github.com', 'api.example.com'] } }),
    );
    expect(caps.map(formatCapability).sort()).toEqual([
      'net-egress:api.example.com',
      'net-egress:github.com',
    ]);
  });

  test('bash + read_file: bash universal subsumes narrower read_file cap', () => {
    // bash brings read-fs:** (and the rest of its footprint); the
    // narrower read-fs:src/** from read_file is covered by bash and
    // gets dropped by subsumption — keeps the rendered set readable.
    const caps = deriveParentCapabilities(
      policyOf({
        bash: { allow: ['ls *'] },
        read_file: { allow_paths: ['src/**'] },
      }),
    );
    const formatted = caps.map(formatCapability).sort();
    expect(formatted).toContain('read-fs:**');
    expect(formatted).not.toContain('read-fs:src/**');
  });

  test('universal `**` in allow_paths subsumes narrower siblings in same section', () => {
    const caps = deriveParentCapabilities(
      policyOf({ read_file: { allow_paths: ['**', 'src/foo'] } }),
    );
    expect(caps.map(formatCapability)).toEqual(['read-fs:**']);
  });

  test('cross-section dedupe: read_file + glob with same path emit one cap', () => {
    const caps = deriveParentCapabilities(
      policyOf({
        read_file: { allow_paths: ['src/**'] },
        glob: { allow_paths: ['src/**'] },
      }),
    );
    expect(caps.map(formatCapability)).toEqual(['read-fs:src/**']);
  });

  test('prefix-glob in allow_paths subsumes literal sibling under same prefix', () => {
    // `src/**` covers `src/index.ts` per capabilityCovers rule 4.c —
    // subsumption drops the literal so /perms inspect shows the
    // broader rule.
    const caps = deriveParentCapabilities(
      policyOf({ read_file: { allow_paths: ['src/**', 'src/index.ts'] } }),
    );
    expect(caps.map(formatCapability)).toEqual(['read-fs:src/**']);
  });

  test('narrow parent rejects declared outside path scope (excess)', () => {
    // Operator authorized `src/**` only. A subagent that declares
    // `/etc/passwd` should NOT slip through just because the kind
    // (read-fs) is allowed somewhere.
    const parent = deriveParentCapabilities(policyOf({ read_file: { allow_paths: ['src/**'] } }));
    const declared = ['read-fs:src/index.ts', 'read-fs:/etc/passwd'].map(parseCapability);
    const { effective, excess } = intersectCapabilities(parent, declared);
    expect(effective.map(formatCapability)).toEqual(['read-fs:src/index.ts']);
    expect(excess.map(formatCapability)).toEqual(['read-fs:/etc/passwd']);
  });

  test('narrow net-egress parent rejects declared host outside allow_hosts', () => {
    const parent = deriveParentCapabilities(
      policyOf({ fetch_url: { allow_hosts: ['github.com'] } }),
    );
    const declared = ['net-egress:github.com', 'net-egress:evil.example.com'].map(parseCapability);
    const { effective, excess } = intersectCapabilities(parent, declared);
    expect(effective.map(formatCapability)).toEqual(['net-egress:github.com']);
    expect(excess.map(formatCapability)).toEqual(['net-egress:evil.example.com']);
  });

  test('bash footprint kinds without policy projection stay universal (delete-fs/exec/git-write)', () => {
    // Only path sections — no bash. Footprint emits read-fs/write-fs
    // narrowed; delete-fs/exec/git-write/net-egress NOT in any path
    // section's footprint, so they don't appear at all.
    const caps = deriveParentCapabilities(policyOf({ write_file: { allow_paths: ['./out'] } }));
    const kinds = new Set(caps.map((c) => c.kind));
    expect(kinds.has('read-fs')).toBe(true);
    expect(kinds.has('write-fs')).toBe(true);
    expect(kinds.has('delete-fs')).toBe(false);
    expect(kinds.has('exec')).toBe(false);
    expect(kinds.has('git-write')).toBe(false);
    expect(kinds.has('net-egress')).toBe(false);
  });
});

describe('deriveParentCapabilities — bypass mode (subagent capability fix)', () => {
  const bypassPolicy = (
    tools: Record<string, unknown> = {},
  ): Parameters<typeof deriveParentCapabilities>[0] =>
    ({ defaults: { mode: 'bypass' }, tools }) as unknown as Parameters<
      typeof deriveParentCapabilities
    >[0];

  test('bypass with NO allow rules → universal tool footprints (not empty)', () => {
    // Bug fix: bypass permits every tool, so the parent envelope must be the
    // universal footprint — the old empty set made every subagent capability
    // escalate. secret-access / host-passthrough are NOT tool-derived, so
    // they stay out even under bypass.
    const got = deriveParentCapabilities(bypassPolicy()).map(formatCapability).sort();
    expect(got).toEqual([
      'delete-fs:**',
      'exec:arbitrary',
      'git-write:**',
      'net-egress:**',
      'read-fs:**',
      'write-fs:**',
    ]);
  });

  test('a subagent can declare read-fs under bypass without escalating', () => {
    const parent = deriveParentCapabilities(bypassPolicy());
    const { effective, excess } = intersectCapabilities(parent, caps('read-fs:.'));
    expect(excess).toEqual([]);
    expect(effective.map(formatCapability)).toEqual(['read-fs:.']);
  });

  test('bypass does NOT grant non-tool-derived caps (secret-access still escalates)', () => {
    const parent = deriveParentCapabilities(bypassPolicy());
    const { excess } = intersectCapabilities(parent, caps('secret-access:**'));
    expect(excess.map(formatCapability)).toEqual(['secret-access:**']);
  });

  test('non-bypass mode unchanged: no allow rules → empty envelope', () => {
    const strict = { defaults: { mode: 'strict' }, tools: {} } as unknown as Parameters<
      typeof deriveParentCapabilities
    >[0];
    expect(deriveParentCapabilities(strict)).toEqual([]);
  });
});
