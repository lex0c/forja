import { describe, expect, test } from 'bun:test';
import {
  type Capability,
  capabilityEquals,
  formatCapability,
  isCapabilityKind,
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
