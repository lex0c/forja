import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBytes, formatRow, runCheck } from '../../scripts/check-size.ts';
import { TARGETS, assetName } from '../../scripts/targets.ts';
import { targetById } from './_helpers.ts';

const MIB = 1024 * 1024;

describe('classifyBytes', () => {
  test('strictly under budget is ok', () => {
    expect(classifyBytes(40 * MIB, 50)).toBe('ok');
  });

  test('exact budget hit is warn (spec §18.2)', () => {
    expect(classifyBytes(50 * MIB, 50)).toBe('warn');
  });

  test('within +20% is warn', () => {
    expect(classifyBytes(55 * MIB, 50)).toBe('warn');
    expect(classifyBytes(60 * MIB, 50)).toBe('warn');
  });

  test('over +20% blocks the release', () => {
    expect(classifyBytes(60 * MIB + 1, 50)).toBe('block');
    expect(classifyBytes(75 * MIB, 50)).toBe('block');
  });
});

describe('formatRow', () => {
  test('renders verdict tag, target, size, budget', () => {
    const target = targetById('linux-x64');
    const row = { target, bytes: 30 * MIB, verdict: 'ok' as const };
    const text = formatRow(row);
    expect(text).toContain('OK');
    expect(text).toContain('linux-x64');
    expect(text).toContain('30.0 MiB');
    expect(text).toContain('budget 50 MiB');
  });
});

describe('runCheck', () => {
  const setupDist = (entries: { id: string; bytes: number }[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-checksize-'));
    for (const e of entries) {
      const t = targetById(e.id);
      writeFileSync(join(dir, assetName(t)), Buffer.alloc(e.bytes));
    }
    return dir;
  };

  test('returns exit 0 when every present asset is under budget', () => {
    const dir = setupDist([{ id: 'linux-x64', bytes: 10 * MIB }]);
    try {
      const result = runCheck({ distDir: dir, ids: ['linux-x64'] });
      expect(result.exitCode).toBe(0);
      expect(result.rows[0]?.verdict).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns exit 0 with verdict=warn for an at-budget asset (warning, not block)', () => {
    const dir = setupDist([{ id: 'linux-x64', bytes: 50 * MIB }]);
    try {
      const result = runCheck({ distDir: dir, ids: ['linux-x64'] });
      expect(result.exitCode).toBe(0);
      expect(result.rows[0]?.verdict).toBe('warn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns exit 1 when any asset is over the block threshold', () => {
    const dir = setupDist([
      { id: 'linux-x64', bytes: 10 * MIB },
      // linux-arm64: 50 MiB budget; +20% block at 60 MiB; 70 MiB blocks.
      { id: 'linux-arm64', bytes: 70 * MIB },
    ]);
    try {
      const result = runCheck({
        distDir: dir,
        ids: ['linux-x64', 'linux-arm64'],
      });
      expect(result.exitCode).toBe(1);
      const blocked = result.rows.find((r) => r.verdict === 'block');
      expect(blocked?.target.id).toBe('linux-arm64');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing assets fail by default', () => {
    const dir = setupDist([]);
    try {
      const result = runCheck({ distDir: dir });
      expect(result.exitCode).toBe(1);
      expect(result.missing.length).toBe(TARGETS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing assets are tolerated under allowMissing', () => {
    const dir = setupDist([{ id: 'linux-x64', bytes: 10 * MIB }]);
    try {
      const result = runCheck({ distDir: dir, allowMissing: true });
      expect(result.exitCode).toBe(0);
      expect(result.rows.length).toBe(1);
      expect(result.missing.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
