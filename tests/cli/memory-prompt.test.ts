import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleMemorySection, composeSystemPrompt } from '../../src/cli/memory-prompt.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-prompt-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('assembleMemorySection', () => {
  test('returns empty string and zero count when no memories exist', () => {
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo) });
    const result = assembleMemorySection({ registry });
    expect(result.text).toBe('');
    expect(result.entryCount).toBe(0);
  });

  test('renders entries with scope prefix', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — full-stack TS dev\n');
    writeIndex(roots.projectShared, '- [Conv](team-conv.md) — code review conventions\n');
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — Title Case verbs\n');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(3);
    expect(result.text).toContain('# Memory');
    expect(result.text).toContain('memory_read');
    expect(result.text).toContain('[project_local] commit-style — Title Case verbs');
    expect(result.text).toContain('[project_shared] team-conv — code review conventions');
    expect(result.text).toContain('[user] role — full-stack TS dev');
  });

  test('orders entries by scope precedence (local > shared > user)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u.md) — user\n');
    writeIndex(roots.projectShared, '- [S](s.md) — shared\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local\n');
    const registry = createMemoryRegistry({ roots });
    const text = assembleMemorySection({ registry }).text;
    const localIdx = text.indexOf('[project_local]');
    const sharedIdx = text.indexOf('[project_shared]');
    const userIdx = text.indexOf('[user]');
    expect(localIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeLessThan(sharedIdx);
    expect(sharedIdx).toBeLessThan(userIdx);
  });

  test('dedupes shadowed names to most-specific scope', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Style](commit-style.md) — user version\n');
    writeIndex(roots.projectShared, '- [Style](commit-style.md) — shared version\n');
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — local version\n');
    const registry = createMemoryRegistry({ roots });
    const result = assembleMemorySection({ registry });
    expect(result.entryCount).toBe(1);
    expect(result.text).toContain('[project_local] commit-style — local version');
    expect(result.text).not.toContain('shared version');
    expect(result.text).not.toContain('user version');
  });
});

describe('composeSystemPrompt', () => {
  test('returns base unchanged when memory section is empty', () => {
    expect(composeSystemPrompt('You are an agent.', '')).toBe('You are an agent.');
  });

  test('returns memory section alone when base is undefined', () => {
    expect(composeSystemPrompt(undefined, '# Memory\n- entry')).toBe('# Memory\n- entry');
  });

  test('returns memory section alone when base is empty string', () => {
    expect(composeSystemPrompt('', '# Memory\n- entry')).toBe('# Memory\n- entry');
  });

  test('returns undefined when both are empty', () => {
    expect(composeSystemPrompt(undefined, '')).toBeUndefined();
  });

  test('appends memory after base with blank line separator', () => {
    const out = composeSystemPrompt('You are an agent.', '# Memory\n- entry');
    expect(out).toBe('You are an agent.\n\n# Memory\n- entry');
  });
});
