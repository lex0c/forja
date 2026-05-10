import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSbom, summarize } from '../../scripts/sbom.ts';

describe('generateSbom', () => {
  test('invokes bunx with the pinned cyclonedx-npm version and writes to dist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    try {
      const calls: { cmd: string; args: readonly string[] }[] = [];
      const fakeSpawn = (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        // Emulate cyclonedx-npm by writing a stub SBOM at the
        // location the script asks for.
        const outIdx = args.indexOf('--output-file');
        if (outIdx === -1) throw new Error('--output-file missing');
        const outPath = args[outIdx + 1];
        if (outPath === undefined) throw new Error('--output-file value missing');
        writeFileSync(
          outPath,
          JSON.stringify({
            bomFormat: 'CycloneDX',
            specVersion: '1.5',
            components: [{ name: 'string-width' }],
          }),
        );
        return { status: 0 };
      };
      const result = generateSbom({ distDir: dir, spawn: fakeSpawn });
      expect(result.path).toBe(join(dir, 'sbom.cdx.json'));
      expect(calls[0]?.cmd).toBe('bunx');
      const ver = calls[0]?.args[0];
      expect(ver).toMatch(/^@cyclonedx\/cyclonedx-npm@\d+\.\d+\.\d+$/);
      expect(calls[0]?.args).toContain('--omit');
      expect(calls[0]?.args).toContain('dev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on non-zero exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    try {
      const fakeSpawn = () => ({ status: 1 });
      expect(() => generateSbom({ distDir: dir, spawn: fakeSpawn })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarize', () => {
  test('returns a one-line summary with spec version and component count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    try {
      const path = join(dir, 'sbom.cdx.json');
      writeFileSync(
        path,
        JSON.stringify({
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          components: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        }),
      );
      const text = summarize(path);
      expect(text).toContain('CycloneDX 1.5');
      expect(text).toContain('3 component(s)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects non-CycloneDX documents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    try {
      const path = join(dir, 'sbom.cdx.json');
      writeFileSync(path, JSON.stringify({ bomFormat: 'SPDX' }));
      expect(() => summarize(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
