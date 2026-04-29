import { describe, expect, test } from 'bun:test';
import { defaultPolicy, loadPolicyFromString, parsePolicy } from '../../src/permissions/config.ts';

describe('parsePolicy', () => {
  test('accepts a full valid policy', () => {
    const p = parsePolicy({
      defaults: { mode: 'acceptEdits' },
      tools: {
        bash: { allow: ['git status'], confirm: ['git push *'], deny: ['rm -rf *'] },
        write_file: { allow_paths: ['src/**'], deny_paths: ['**/.env*'] },
        fetch_url: { allow_hosts: ['*.public.com'] },
      },
    });
    expect(p.defaults.mode).toBe('acceptEdits');
    expect(p.tools.bash?.allow).toEqual(['git status']);
    expect(p.tools.write_file?.deny_paths).toEqual(['**/.env*']);
    expect(p.tools.fetch_url?.allow_hosts).toEqual(['*.public.com']);
  });

  test('preserves mode-omitted as undefined (engine/resolver applies the default downstream)', () => {
    // parsePolicy used to inject mode='strict' as a default. Doing
    // so made "user file silent on mode" indistinguishable from
    // "user file said strict explicitly", which then produced
    // phantom lock-conflicts when a higher layer locked mode at
    // a non-strict value. Now ms is preserved as undefined; the
    // engine reads `mode ?? 'strict'` and the hierarchy resolver
    // applies the default at merge-emit time.
    expect(parsePolicy({}).defaults.mode).toBeUndefined();
    expect(parsePolicy({ tools: {} }).defaults.mode).toBeUndefined();
    expect(parsePolicy({ defaults: { mode: 'strict' } }).defaults.mode).toBe('strict');
  });

  test('rejects unknown keys (typo defense)', () => {
    // Typo `allow_path` (singular) used to silently turn into a
    // no-op section that allows everything by virtue of having no
    // declared rules. parsePolicy now rejects unknown keys to
    // catch these at config load time.
    expect(() => parsePolicy({ tools: { write_file: { allow_path: ['./src/**'] } } })).toThrow(
      /unknown key 'allow_path'/,
    );
    expect(() => parsePolicy({ tools: { bash: { lockd: true } } })).toThrow(/unknown key 'lockd'/);
    expect(() => parsePolicy({ defaults: { lcoked: true } })).toThrow(/unknown key 'lcoked'/);
  });

  test('rejects invalid mode', () => {
    expect(() => parsePolicy({ defaults: { mode: 'lax' } })).toThrow(/defaults.mode/);
  });

  test('rejects non-mapping top-level', () => {
    expect(() => parsePolicy(null)).toThrow(/YAML mapping/);
    expect(() => parsePolicy('a string')).toThrow(/YAML mapping/);
    expect(() => parsePolicy(['array'])).toThrow(/YAML mapping/);
    expect(() => parsePolicy(123)).toThrow(/YAML mapping/);
  });

  test('rejects mistyped allow_paths (not array of strings)', () => {
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: 'src/**' } } })).toThrow(
      /allow_paths/,
    );
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: [1, 2] } } })).toThrow();
  });

  test('rejects mistyped bash deny rules', () => {
    expect(() => parsePolicy({ tools: { bash: { deny: 'rm *' } } })).toThrow(/bash.deny/);
  });

  test('rejects malformed tools section', () => {
    expect(() => parsePolicy({ tools: 'not a map' })).toThrow(/tools/);
  });
});

describe('loadPolicyFromString', () => {
  test('parses a YAML document', () => {
    const yaml = `
defaults:
  mode: strict

tools:
  bash:
    allow:
      - "git status"
    deny:
      - "rm -rf *"
  write_file:
    allow_paths:
      - "src/**"
`;
    const p = loadPolicyFromString(yaml);
    expect(p.defaults.mode).toBe('strict');
    expect(p.tools.bash?.allow).toEqual(['git status']);
    expect(p.tools.write_file?.allow_paths).toEqual(['src/**']);
  });

  test('throws on YAML syntax errors', () => {
    expect(() => loadPolicyFromString('defaults: { mode: [unterminated')).toThrow();
  });
});

describe('defaultPolicy', () => {
  test('strict mode + empty rules', () => {
    const p = defaultPolicy();
    expect(p.defaults.mode).toBe('strict');
    expect(p.tools).toEqual({});
  });
});
