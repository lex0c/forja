import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName } from '../../scripts/targets.ts';
import { formatRow, runCompress } from '../../scripts/upx-compress.ts';
import { targetById } from './_helpers.ts';

const buildSpawn =
  (handler: (args: readonly string[]) => number) => (_cmd: string, args: readonly string[]) => ({
    status: handler(args),
  });

describe('runCompress', () => {
  test('skips darwin-arm64 with reason "UPX does not support this target"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-upx-'));
    try {
      const t = targetById('darwin-arm64');
      writeFileSync(join(dir, assetName(t)), Buffer.alloc(1024));
      const spawn = buildSpawn(() => 0);
      const rows = runCompress({ distDir: dir, ids: ['darwin-arm64'], spawn });
      expect(rows[0]?.status).toBe('skipped');
      expect(rows[0]?.reason).toContain('UPX');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips with reason "asset missing" when the binary does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-upx-'));
    try {
      const spawn = buildSpawn(() => 0);
      const rows = runCompress({ distDir: dir, ids: ['linux-x64'], spawn });
      expect(rows[0]?.status).toBe('skipped');
      expect(rows[0]?.reason).toBe('asset missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports failed when UPX exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-upx-'));
    try {
      const t = targetById('linux-x64');
      writeFileSync(join(dir, assetName(t)), Buffer.alloc(1024));
      const spawn = buildSpawn(() => 2);
      const rows = runCompress({ distDir: dir, ids: ['linux-x64'], spawn });
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.reason).toContain('upx exited');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports ok with size delta when UPX succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-upx-'));
    try {
      const t = targetById('linux-x64');
      const path = join(dir, assetName(t));
      writeFileSync(path, Buffer.alloc(10 * 1024));
      const spawn = buildSpawn(() => {
        // Simulate UPX shrinking the file in-place.
        writeFileSync(path, Buffer.alloc(6 * 1024));
        return 0;
      });
      const rows = runCompress({ distDir: dir, ids: ['linux-x64'], spawn });
      expect(rows[0]?.status).toBe('ok');
      expect(rows[0]?.bytesBefore).toBe(10 * 1024);
      expect(rows[0]?.bytesAfter).toBe(6 * 1024);
      const first = rows[0];
      if (first === undefined) throw new Error('expected at least one row');
      expect(formatRow(first)).toContain('-40%');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
