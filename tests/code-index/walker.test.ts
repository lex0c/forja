import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkProject } from '../../src/code-index/scanner/walker.ts';

// Walker contract: lists supported files relative to project
// root, applying privacy excludes, gitignore (when present),
// extension filter, and size cap. Reading file contents happens
// in the pipeline — walker only stats.

const writeFile = (root: string, rel: string, content = ''): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('walkProject', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forja-walker-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns supported files relative to project root', async () => {
    writeFile(root, 'src/auth.ts', 'export const X = 1;');
    writeFile(root, 'src/util.js', 'export const Y = 2;');
    writeFile(root, 'README.md', '# unsupported extension');
    const files = await walkProject({ projectRoot: root, respectGitignore: false });
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(['src/auth.ts', 'src/util.js']);
    const ts = files.find((f) => f.relPath === 'src/auth.ts');
    expect(ts?.language).toBe('typescript');
    expect(ts?.absPath).toBe(join(root, 'src/auth.ts'));
    expect(ts?.sizeBytes).toBeGreaterThan(0);
  });

  test('drops files in default exclude patterns', async () => {
    writeFile(root, 'src/app.ts', '');
    writeFile(root, 'node_modules/lodash/index.js', '');
    writeFile(root, 'packages/api/node_modules/react/index.js', '');
    writeFile(root, 'dist/bundle.js', '');
    writeFile(root, '.env', 'SECRET=1');
    const files = await walkProject({ projectRoot: root, respectGitignore: false });
    expect(files.map((f) => f.relPath).sort()).toEqual(['src/app.ts']);
  });

  test('honors additionalExcludes on top of defaults', async () => {
    writeFile(root, 'src/app.ts', '');
    writeFile(root, 'src/generated/model.ts', '');
    const files = await walkProject({
      projectRoot: root,
      respectGitignore: false,
      additionalExcludes: ['src/generated/**'],
    });
    expect(files.map((f) => f.relPath)).toEqual(['src/app.ts']);
  });

  test('drops files larger than maxFileSizeBytes', async () => {
    writeFile(root, 'src/big.ts', 'x'.repeat(2000));
    writeFile(root, 'src/small.ts', '');
    const files = await walkProject({
      projectRoot: root,
      respectGitignore: false,
      maxFileSizeBytes: 1000,
    });
    expect(files.map((f) => f.relPath)).toEqual(['src/small.ts']);
  });

  test('respects .gitignore when project root is a git repo', async () => {
    // Init a git repo and stage some files. ls-files with
    // --cached --others --exclude-standard returns the union of
    // tracked files and untracked-but-not-ignored files; ignored
    // files are dropped. We exercise that path here.
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    writeFile(root, '.gitignore', 'src/ignored.ts\n');
    writeFile(root, 'src/keep.ts', '');
    writeFile(root, 'src/ignored.ts', '');
    spawnSync('git', ['-C', root, 'add', 'src/keep.ts', '.gitignore'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
    const files = await walkProject({ projectRoot: root, respectGitignore: true });
    expect(files.map((f) => f.relPath).sort()).toEqual(['src/keep.ts']);
  });

  test('falls back to manual walk when not a git repo', async () => {
    writeFile(root, 'src/app.ts', '');
    writeFile(root, 'src/util.ts', '');
    const files = await walkProject({ projectRoot: root, respectGitignore: true });
    expect(files.map((f) => f.relPath).sort()).toEqual(['src/app.ts', 'src/util.ts']);
  });

  test('skips non-regular files (symlinks, dirs)', async () => {
    writeFile(root, 'src/real.ts', '');
    mkdirSync(join(root, 'src/subdir.ts'), { recursive: true }); // a directory named like a TS file
    const files = await walkProject({ projectRoot: root, respectGitignore: false });
    expect(files.map((f) => f.relPath)).toEqual(['src/real.ts']);
  });

  test('skips symlinks even when target is a regular .ts file', async () => {
    // CODE_INDEX.md §8.2 sets follow_symlinks=false as the
    // spec default. The walker uses lstat (not stat) so a
    // symlink whose target is a real .ts file does NOT pass
    // the s.isFile() check via the resolved target.
    writeFile(root, 'src/real.ts', 'export const real = 1;');
    writeFile(root, 'shared/source.ts', 'export const shared = 1;');
    symlinkSync(join(root, 'shared/source.ts'), join(root, 'src/alias.ts'));
    const files = await walkProject({ projectRoot: root, respectGitignore: false });
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(['shared/source.ts', 'src/real.ts']);
    expect(paths).not.toContain('src/alias.ts');
  });

  test('populates mtimeMs from filesystem stat', async () => {
    writeFile(root, 'src/app.ts', '');
    const before = Date.now();
    const files = await walkProject({ projectRoot: root, respectGitignore: false });
    const after = Date.now();
    expect(files[0]?.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(files[0]?.mtimeMs).toBeLessThanOrEqual(after + 1000);
  });
});
