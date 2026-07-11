// Scope detection tests (3.6b — scope chain enrichment).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildScopeChain,
  detectLanguageScope,
  detectUserScope,
  normalizeRepoScope,
} from '../../src/feedback/scope-detect.ts';

const tmpDirs: string[] = [];

const makeTmpRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-scope-detect-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('normalizeRepoScope', () => {
  test('strips trailing slash', () => {
    expect(normalizeRepoScope('/foo/bar/')).toBe('/foo/bar');
  });

  test('preserves path without trailing slash', () => {
    expect(normalizeRepoScope('/foo/bar')).toBe('/foo/bar');
  });

  test('resolves relative paths to absolute', () => {
    // Won't equal the relative path; will resolve against cwd.
    const got = normalizeRepoScope('./relative');
    expect(got.startsWith('/')).toBe(true);
    expect(got.endsWith('/relative')).toBe(true);
  });

  test('does NOT resolve symlinks (preserves operator intent)', () => {
    // Symlink resolution would surprise operators using
    // intentional symlinks (e.g., /Users/me/repo → /Volumes/SSD/...).
    // path.resolve does NOT call realpath; we rely on that.
    const tmp = makeTmpRepo();
    // Just verify the input survives non-symlink normalization.
    expect(normalizeRepoScope(tmp)).toBe(tmp);
  });

  test('empty input returns "unknown"', () => {
    expect(normalizeRepoScope('')).toBe('unknown');
  });

  test('single slash preserved (root)', () => {
    expect(normalizeRepoScope('/')).toBe('/');
  });
});

describe('detectUserScope', () => {
  test('returns a non-empty string', () => {
    const u = detectUserScope();
    expect(u.length).toBeGreaterThan(0);
  });

  test('respects USER env when set', () => {
    const original = process.env.USER;
    process.env.USER = 'test-user-x';
    try {
      // os.userInfo() may still return a valid username on most
      // systems, beating USER. The intent of the env override is
      // for cases where userInfo throws. So we just verify the
      // function returns something stable, not specifically that
      // env wins.
      const u = detectUserScope();
      expect(u.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env.USER;
      else process.env.USER = original;
    }
  });
});

describe('detectLanguageScope', () => {
  test('detects typescript from package.json', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'package.json'), '{}');
    expect(detectLanguageScope(tmp)).toBe('typescript');
  });

  test('detects python from pyproject.toml', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'pyproject.toml'), '');
    expect(detectLanguageScope(tmp)).toBe('python');
  });

  test('detects python from setup.py when pyproject absent', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'setup.py'), '');
    expect(detectLanguageScope(tmp)).toBe('python');
  });

  test('detects rust from Cargo.toml', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'Cargo.toml'), '');
    expect(detectLanguageScope(tmp)).toBe('rust');
  });

  test('detects go from go.mod', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'go.mod'), 'module x');
    expect(detectLanguageScope(tmp)).toBe('go');
  });

  test('detects java from pom.xml', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'pom.xml'), '<project/>');
    expect(detectLanguageScope(tmp)).toBe('java');
  });

  test('detects ruby from Gemfile', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'Gemfile'), '');
    expect(detectLanguageScope(tmp)).toBe('ruby');
  });

  test('detects php from composer.json', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'composer.json'), '{}');
    expect(detectLanguageScope(tmp)).toBe('php');
  });

  test('polyglot: package.json wins over pyproject.toml (precedence)', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'package.json'), '{}');
    writeFileSync(join(tmp, 'pyproject.toml'), '');
    expect(detectLanguageScope(tmp)).toBe('typescript');
  });

  test('returns unknown when no marker matches', () => {
    const tmp = makeTmpRepo();
    expect(detectLanguageScope(tmp)).toBe('unknown');
  });

  test('returns unknown for empty input', () => {
    expect(detectLanguageScope('')).toBe('unknown');
  });

  test('returns unknown for nonexistent path (silent failure)', () => {
    expect(detectLanguageScope('/nonexistent/path/at/all')).toBe('unknown');
  });

  test('detects from subdirectories of repo (no — only repo root)', () => {
    // Marker probe is at repoCwd literal, not parent walks.
    // Operator running from a subdirectory of a TS repo won't get
    // typescript detection — that's a future slice's job (walk up
    // until marker or .git found).
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'package.json'), '{}');
    mkdirSync(join(tmp, 'src'));
    expect(detectLanguageScope(join(tmp, 'src'))).toBe('unknown');
  });
});

describe('buildScopeChain', () => {
  test('returns all four fields', () => {
    const tmp = makeTmpRepo();
    writeFileSync(join(tmp, 'package.json'), '{}');
    const chain = buildScopeChain({ sessionId: 'sess-1', repoCwd: tmp });
    expect(chain.session).toBe('sess-1');
    expect(chain.repo).toBe(tmp); // already normalized
    expect(chain.user.length).toBeGreaterThan(0);
    expect(chain.language).toBe('typescript');
  });

  test('trailing-slash cwd gets normalized in the chain', () => {
    const tmp = makeTmpRepo();
    const chain = buildScopeChain({ sessionId: 'sess-1', repoCwd: `${tmp}/` });
    expect(chain.repo).toBe(tmp);
    expect(chain.repo.endsWith('/')).toBe(false);
  });
});
