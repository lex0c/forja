import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCheckpointSupport } from '../../src/checkpoints/detect.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forja-detect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const initRepo = async (cwd: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ['git', 'init', '-b', 'main'],
    cwd,
    env: { LC_ALL: 'C', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  await proc.exited;
};

describe('detectCheckpointSupport', () => {
  test('available=true inside a git repo', async () => {
    await initRepo(dir);
    const result = await detectCheckpointSupport(dir);
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
  });

  test('available=false outside a git repo with a clear reason', async () => {
    const result = await detectCheckpointSupport(dir);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('not a git repository');
    expect(result.reason).toContain(dir);
  });
});
