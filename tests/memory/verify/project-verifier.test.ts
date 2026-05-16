// ProjectVerifier tests (S2/T2.3).
//
// Two layers:
//   1. Path extraction (pure function via `__testExtractPaths`) —
//      pins the bar: which strings count as paths, which don't.
//      False-positive extractions are the highest-impact bug class
//      in this verifier, so the extractor is pinned in isolation.
//   2. End-to-end verify against a real tmpdir — covers passed /
//      contradicted / unknown paths.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryFile } from '../../../src/memory/types.ts';
import {
  __testExtractPaths,
  createProjectVerifier,
} from '../../../src/memory/verify/project-verifier.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-verify-project-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const mkFile = (body: string): MemoryFile => ({
  frontmatter: {
    name: 'sample',
    description: 'sample',
    type: 'project',
    source: 'user_explicit',
  },
  body,
});

describe('extractPaths', () => {
  test('extracts paths under known prefixes', () => {
    expect(__testExtractPaths('memory lives in src/memory/types.ts')).toEqual([
      'src/memory/types.ts',
    ]);
    expect(__testExtractPaths('tests live in tests/memory/registry.test.ts')).toEqual([
      'tests/memory/registry.test.ts',
    ]);
    expect(__testExtractPaths('see docs/MEMORY.md for the spec')).toEqual(['docs/MEMORY.md']);
  });

  test('extracts multiple distinct paths in one body', () => {
    const body = 'the registry is in src/memory/registry.ts and tested in tests/memory/';
    const paths = __testExtractPaths(body);
    expect(paths).toContain('src/memory/registry.ts');
    expect(paths).toContain('tests/memory/');
  });

  test('dedupes repeated mentions of the same path', () => {
    const body = 'src/foo.ts is important. Always check src/foo.ts before editing.';
    expect(__testExtractPaths(body)).toEqual(['src/foo.ts']);
  });

  test('strips trailing punctuation (period, comma, quote, paren, backtick)', () => {
    expect(__testExtractPaths('see src/foo.ts.')).toEqual(['src/foo.ts']);
    expect(__testExtractPaths('see src/foo.ts,')).toEqual(['src/foo.ts']);
    expect(__testExtractPaths('see `src/foo.ts`')).toEqual(['src/foo.ts']);
    expect(__testExtractPaths('see (src/foo.ts)')).toEqual(['src/foo.ts']);
  });

  test('ignores paths with `..` traversal', () => {
    // A malicious memory body claiming `../etc/passwd` or
    // `src/../node_modules/foo` MUST NOT make the verifier
    // existsSync against system paths. The cleaner refuses.
    expect(__testExtractPaths('src/../etc/passwd lives here')).toEqual([]);
    expect(__testExtractPaths('see src/foo/../bar.ts')).toEqual([]);
  });

  test('ignores paths without known prefixes', () => {
    expect(__testExtractPaths('node_modules/foo/index.js')).toEqual([]);
    expect(__testExtractPaths('/etc/passwd is bad')).toEqual([]);
    expect(__testExtractPaths('config.ts at root')).toEqual([]);
    expect(__testExtractPaths('we use ./script.sh sometimes')).toEqual([]);
  });

  test('ignores prose with no path-shape content', () => {
    expect(__testExtractPaths('we use TypeScript strict mode')).toEqual([]);
    expect(__testExtractPaths('prefers functional style')).toEqual([]);
    expect(__testExtractPaths('')).toEqual([]);
  });
});

describe('createProjectVerifier — verify', () => {
  test('passed when every claimed path exists', async () => {
    const repo = makeTmp();
    mkdirSync(join(repo, 'src/memory'), { recursive: true });
    writeFileSync(join(repo, 'src/memory/types.ts'), '// types');
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: mkFile('memory types live in src/memory/types.ts'),
      repoRoot: repo,
    });
    expect(result.kind).toBe('passed');
  });

  test('contradicted when a claimed path does NOT exist', async () => {
    const repo = makeTmp();
    // Don't create the file.
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: mkFile('memory lives in src/memory/missing.ts'),
      repoRoot: repo,
    });
    expect(result.kind).toBe('contradicted');
    if (result.kind === 'contradicted') {
      expect(result.claim).toContain('src/memory/missing.ts');
      expect(result.observed).toContain('do not exist');
    }
  });

  test('contradicted reports ALL missing paths (not just the first)', async () => {
    const repo = makeTmp();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/exists.ts'), '');
    // src/missing-a.ts + src/missing-b.ts don't exist
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: mkFile('see src/exists.ts. but also src/missing-a.ts and src/missing-b.ts'),
      repoRoot: repo,
    });
    expect(result.kind).toBe('contradicted');
    if (result.kind === 'contradicted') {
      expect(result.observed).toContain('src/missing-a.ts');
      expect(result.observed).toContain('src/missing-b.ts');
      expect(result.observed).not.toContain('src/exists.ts'); // existing path NOT in the report
    }
  });

  test('unknown when no verifiable path claim is extractable (high bar)', async () => {
    const repo = makeTmp();
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: mkFile('we use TypeScript strict mode and Bun for builds'),
      repoRoot: repo,
    });
    expect(result.kind).toBe('unknown');
  });

  test('unknown when frontmatter type is not project (defensive)', async () => {
    // The factuality classifier gates this at the dispatcher layer,
    // but the verifier guards against direct mis-dispatch too.
    const repo = makeTmp();
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: {
        frontmatter: {
          name: 'mem',
          description: 'd',
          type: 'feedback',
          source: 'inferred',
        },
        body: 'src/foo.ts mentioned',
      },
      repoRoot: repo,
    });
    expect(result.kind).toBe('unknown');
  });

  test('directory mentions are verifiable (trailing slash form)', async () => {
    const repo = makeTmp();
    mkdirSync(join(repo, 'src/memory'), { recursive: true });
    const verifier = createProjectVerifier();
    const result = await verifier.verify({
      scope: 'user',
      name: 'mem',
      file: mkFile('memory subsystem lives in src/memory/'),
      repoRoot: repo,
    });
    expect(result.kind).toBe('passed');
  });
});
