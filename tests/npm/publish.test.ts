import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverPackages,
  publishAll,
  publishOrder,
  publishState,
  type Runner,
  type RunResult,
} from '../../scripts/npm-publish.ts';

const tmpDirs: string[] = [];
const freshDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// A fake dist-npm tree: <tree>/<scope>/<pkg>/package.json per entry.
const makeTree = (pkgs: { name: string; version: string }[]): string => {
  const tree = freshDir('forja-npm-tree-');
  for (const p of pkgs) {
    const dir = join(tree, ...p.name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: p.name, version: p.version }));
  }
  return tree;
};

const ALL = [
  { name: '@lex0c/forja', version: '2.0.0' },
  { name: '@lex0c/forja-linux-x64', version: '2.0.0' },
  { name: '@lex0c/forja-darwin-arm64', version: '2.0.0' },
];

describe('publishOrder', () => {
  test('launcher is forced last regardless of discovery order', () => {
    const ordered = publishOrder([
      { name: '@lex0c/forja', version: '2.0.0', dir: 'a' },
      { name: '@lex0c/forja-linux-x64', version: '2.0.0', dir: 'b' },
      { name: '@lex0c/forja-darwin-arm64', version: '2.0.0', dir: 'c' },
    ]);
    expect(ordered.map((p) => p.name).at(-1)).toBe('@lex0c/forja');
    expect(ordered.slice(0, -1).some((p) => p.name === '@lex0c/forja')).toBe(false);
  });
});

describe('discoverPackages', () => {
  test('reads name/version from each scoped manifest', () => {
    const tree = makeTree(ALL);
    expect(discoverPackages(tree).map((p) => p.name)).toEqual([
      '@lex0c/forja',
      '@lex0c/forja-darwin-arm64',
      '@lex0c/forja-linux-x64',
    ]);
  });

  test('throws when the tree is absent', () => {
    expect(() => discoverPackages(join(tmpdir(), 'forja-nope-does-not-exist'))).toThrow(
      /not found/,
    );
  });
});

describe('publishState', () => {
  test('published when npm view echoes the exact version', () => {
    const run: Runner = () => ({ status: 0, stdout: '2.0.0\n', stderr: '' });
    expect(publishState('@lex0c/forja', '2.0.0', run)).toBe('published');
  });

  test('absent on a genuine E404', () => {
    const run: Runner = () => ({ status: 1, stdout: '', stderr: 'npm error code E404' });
    expect(publishState('@lex0c/forja', '2.0.0', run)).toBe('absent');
  });

  test('absent when the package exists but this version does not (exit 0, empty stdout)', () => {
    const run: Runner = () => ({ status: 0, stdout: '\n', stderr: '' });
    expect(publishState('@lex0c/forja', '2.0.0', run)).toBe('absent');
  });

  test('unknown on a non-404 failure (network / 5xx / auth), never assumed absent', () => {
    const run: Runner = () => ({ status: 1, stdout: '', stderr: 'npm error network ETIMEDOUT' });
    expect(publishState('@lex0c/forja', '2.0.0', run)).toBe('unknown');
  });
});

describe('publishAll', () => {
  // A genuine E404 from `npm view` → publishState 'absent' → publish proceeds.
  const absent: RunResult = { status: 1, stdout: '', stderr: 'npm error code E404' };
  const ok: RunResult = { status: 0, stdout: '', stderr: '' };

  test('publishes platform packages first, launcher last', () => {
    const tree = makeTree(ALL);
    const run: Runner = (_cmd, args) => (args[0] === 'view' ? absent : ok);
    const outcomes = publishAll({ outDir: tree, dryRun: false, run });
    expect(outcomes.every((o) => o.action === 'published')).toBe(true);
    expect(outcomes.at(-1)?.name).toBe('@lex0c/forja');
  });

  test('skips packages already on the registry (idempotent re-dispatch)', () => {
    const tree = makeTree(ALL);
    const run: Runner = (_cmd, args) =>
      args[0] === 'view' ? { status: 0, stdout: '2.0.0\n', stderr: '' } : ok;
    const outcomes = publishAll({ outDir: tree, dryRun: false, run });
    expect(outcomes.every((o) => o.action === 'skipped')).toBe(true);
  });

  test('dry-run never invokes npm publish', () => {
    const tree = makeTree(ALL);
    const run: Runner = (_cmd, args) => {
      if (args[0] === 'view') return absent;
      throw new Error(`dry-run must not publish (got: npm ${args.join(' ')})`);
    };
    const outcomes = publishAll({ outDir: tree, dryRun: true, run });
    expect(outcomes.every((o) => o.action === 'dry-run')).toBe(true);
  });

  test('refuses to publish when registry state is unknown (npm view failed non-404)', () => {
    const tree = makeTree(ALL);
    const run: Runner = (_cmd, args) => {
      if (args[0] === 'view')
        return { status: 1, stdout: '', stderr: 'npm error network ETIMEDOUT' };
      throw new Error('must not publish when state is unknown');
    };
    expect(() => publishAll({ outDir: tree, dryRun: false, run })).toThrow(/could not determine/);
  });

  test('aborts when a platform publish fails, before reaching the launcher', () => {
    const tree = makeTree(ALL);
    const published: string[] = [];
    const run: Runner = (_cmd, args) => {
      if (args[0] === 'view') return absent;
      // Fail the very first publish (a platform package).
      published.push(args[1] as string);
      return { status: 1, stdout: '', stderr: 'boom' };
    };
    expect(() => publishAll({ outDir: tree, dryRun: false, run })).toThrow(/publish failed/);
    // Only one publish was attempted; the launcher was never reached.
    expect(published).toHaveLength(1);
  });
});
