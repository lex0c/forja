import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_INDEX_DEFAULT_EXCLUDES } from '../../src/code-index/privacy.ts';

// Privacy guard contract: the default exclude patterns must
// reject credential files anywhere in the tree, not only at the
// repo root. Monorepos with `apps/api/.env` are the canonical
// case where root-only globs leak. Bun.Glob requires `dot: true`
// to descend into dotfiles, which the walker (slice 4.3.1.b)
// MUST set; tests here exercise the same option to mirror walker
// semantics.

describe('CODE_INDEX_DEFAULT_EXCLUDES — credential patterns are recursive', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forja-privacy-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const matchesAny = async (relPath: string): Promise<string | null> => {
    for (const pat of CODE_INDEX_DEFAULT_EXCLUDES) {
      const g = new Bun.Glob(pat);
      for await (const m of g.scan({ cwd: root, dot: true })) {
        if (m === relPath) return pat;
      }
    }
    return null;
  };

  test('matches `.env` at root', () => {
    writeFileSync(join(root, '.env'), 'SECRET=1');
    expect(matchesAny('.env')).resolves.toBe('**/.env');
  });

  test('matches nested `.env` in monorepo (apps/api/.env)', () => {
    mkdirSync(join(root, 'apps/api'), { recursive: true });
    writeFileSync(join(root, 'apps/api/.env'), 'SECRET=1');
    expect(matchesAny('apps/api/.env')).resolves.toBe('**/.env');
  });

  test('matches `.env.*` (e.g. .env.local) anywhere', () => {
    mkdirSync(join(root, 'apps'), { recursive: true });
    writeFileSync(join(root, '.env.local'), 'X=1');
    writeFileSync(join(root, 'apps/.env.production'), 'X=2');
    expect(matchesAny('.env.local')).resolves.toBe('**/.env.*');
    expect(matchesAny('apps/.env.production')).resolves.toBe('**/.env.*');
  });

  test('matches `.envrc` at root and nested', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, '.envrc'), '');
    writeFileSync(join(root, 'pkg/.envrc'), '');
    expect(matchesAny('.envrc')).resolves.toBe('**/.envrc');
    expect(matchesAny('pkg/.envrc')).resolves.toBe('**/.envrc');
  });

  test('does not match unrelated files', () => {
    writeFileSync(join(root, 'env.txt'), '');
    writeFileSync(join(root, '.envtest'), '');
    expect(matchesAny('env.txt')).resolves.toBeNull();
    // `.envtest` is not `.env`, `.env.*`, or `.envrc` — should pass through.
    expect(matchesAny('.envtest')).resolves.toBeNull();
  });
});

describe('CODE_INDEX_DEFAULT_EXCLUDES — dependency/build globs are recursive', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forja-privacy-deps-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const matchesAny = async (relPath: string): Promise<string | null> => {
    for (const pat of CODE_INDEX_DEFAULT_EXCLUDES) {
      const g = new Bun.Glob(pat);
      for await (const m of g.scan({ cwd: root, dot: true })) {
        if (m === relPath) return pat;
      }
    }
    return null;
  };

  test('matches `node_modules` at root and in nested workspace packages', () => {
    // Monorepo case — packages/api/node_modules is the
    // canonical leak; root-only `node_modules/**` would miss it.
    mkdirSync(join(root, 'node_modules/lodash'), { recursive: true });
    mkdirSync(join(root, 'packages/api/node_modules/react'), { recursive: true });
    writeFileSync(join(root, 'node_modules/lodash/index.js'), '');
    writeFileSync(join(root, 'packages/api/node_modules/react/index.js'), '');
    expect(matchesAny('node_modules/lodash/index.js')).resolves.toBe('**/node_modules/**');
    expect(matchesAny('packages/api/node_modules/react/index.js')).resolves.toBe(
      '**/node_modules/**',
    );
  });

  test('matches Python `__pycache__` nested under service dirs', () => {
    mkdirSync(join(root, 'services/worker/__pycache__'), { recursive: true });
    writeFileSync(join(root, 'services/worker/__pycache__/main.cpython-312.pyc'), '');
    expect(matchesAny('services/worker/__pycache__/main.cpython-312.pyc')).resolves.toBe(
      '**/__pycache__/**',
    );
  });

  test('matches `dist` build outputs in monorepo packages', () => {
    mkdirSync(join(root, 'packages/foo/dist'), { recursive: true });
    writeFileSync(join(root, 'packages/foo/dist/bundle.js'), '');
    expect(matchesAny('packages/foo/dist/bundle.js')).resolves.toBe('**/dist/**');
  });

  test('matches nested `.venv` directories', () => {
    mkdirSync(join(root, 'tools/scripts/.venv/lib/python3.12/site-packages'), { recursive: true });
    writeFileSync(join(root, 'tools/scripts/.venv/lib/python3.12/site-packages/foo.py'), '');
    expect(matchesAny('tools/scripts/.venv/lib/python3.12/site-packages/foo.py')).resolves.toBe(
      '**/.venv/**',
    );
  });
});
