import { describe, expect, test } from 'bun:test';
import {
  type Capability,
  capabilityCovers,
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
    expect(capabilityCovers(cap('env-mutate'), cap('agent-mutate'))).toBe(false);
  });
});

describe('capabilityCovers — scope-less kinds', () => {
  test.each(['env-mutate', 'agent-mutate', 'host-passthrough'])('%s covers itself', (kind) => {
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
