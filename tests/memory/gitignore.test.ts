import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_GITIGNORE, ensureAgentGitignore } from '../../src/memory/gitignore.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-gitignore-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureAgentGitignore', () => {
  test('creates .forja/.gitignore with default contents on first call', () => {
    const repo = makeTmp();
    const result = ensureAgentGitignore(repo);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(repo, '.forja', '.gitignore'));
    expect(readFileSync(result.path, 'utf-8')).toBe(DEFAULT_AGENT_GITIGNORE);
  });

  test('default contents include the spec-mandated entries', () => {
    expect(DEFAULT_AGENT_GITIGNORE).toContain('sessions.db');
    expect(DEFAULT_AGENT_GITIGNORE).toContain('traces/');
    expect(DEFAULT_AGENT_GITIGNORE).toContain('checkpoints/');
    expect(DEFAULT_AGENT_GITIGNORE).toContain('memory/local/');
  });

  test('is idempotent: second call is a no-op', () => {
    const repo = makeTmp();
    const first = ensureAgentGitignore(repo);
    expect(first.created).toBe(true);
    const second = ensureAgentGitignore(repo);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test('never overwrites existing operator-edited .gitignore', () => {
    const repo = makeTmp();
    mkdirSync(join(repo, '.forja'), { recursive: true });
    const path = join(repo, '.forja', '.gitignore');
    writeFileSync(path, 'custom contents\n');
    const result = ensureAgentGitignore(repo);
    expect(result.created).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('custom contents\n');
  });

  test('creates the .forja parent directory when absent', () => {
    const repo = makeTmp();
    expect(existsSync(join(repo, '.forja'))).toBe(false);
    ensureAgentGitignore(repo);
    expect(existsSync(join(repo, '.forja'))).toBe(true);
  });
});
