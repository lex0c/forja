import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSums, generate, parseSums, sha256File, verify } from '../../scripts/checksums.ts';
import { assetName } from '../../scripts/targets.ts';
import { targetById } from './_helpers.ts';

describe('sha256File', () => {
  test('matches the canonical hash of a known string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sha-'));
    try {
      const path = join(dir, 'fixed.bin');
      writeFileSync(path, 'hello\n');
      // sha256("hello\n") = the well-known constant below.
      expect(sha256File(path)).toBe(
        '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatSums / parseSums', () => {
  test('round-trips a stable, alphabetized list', () => {
    const text = formatSums([
      { filename: 'agent-linux-x64', sha256: 'a'.repeat(64) },
      { filename: 'agent-darwin-arm64', sha256: 'b'.repeat(64) },
    ]);
    const lines = text.trimEnd().split('\n');
    // Alphabetical: darwin-arm64 first.
    expect(lines[0]).toBe(`${'b'.repeat(64)}  agent-darwin-arm64`);
    expect(lines[1]).toBe(`${'a'.repeat(64)}  agent-linux-x64`);
    expect(parseSums(text)).toEqual([
      { filename: 'agent-darwin-arm64', sha256: 'b'.repeat(64) },
      { filename: 'agent-linux-x64', sha256: 'a'.repeat(64) },
    ]);
  });

  test('parseSums rejects malformed lines', () => {
    expect(() => parseSums('not-a-hash  agent-foo\n')).toThrow();
  });

  test('parseSums tolerates trailing newline and skips blank lines', () => {
    const sum = `${'c'.repeat(64)}  agent-linux-x64`;
    const text = `\n${sum}\n\n`;
    const parsed = parseSums(text);
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.filename).toBe('agent-linux-x64');
  });
});

describe('generate / verify', () => {
  const setupDist = (
    entries: { id: string; content: string }[],
    extras: { name: string; content: string }[] = [],
  ): string => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sums-'));
    for (const e of entries) {
      const t = targetById(e.id);
      writeFileSync(join(dir, assetName(t)), e.content);
    }
    for (const ex of extras) writeFileSync(join(dir, ex.name), ex.content);
    return dir;
  };

  test('generate writes SHA256SUMS covering every release asset present', () => {
    const dir = setupDist(
      [
        { id: 'linux-x64', content: 'binary-linux' },
        { id: 'darwin-arm64', content: 'binary-darwin' },
      ],
      // sourcemap should be excluded; sbom.cdx.json should be included.
      [
        { name: 'agent-linux-x64.map', content: '{}' },
        { name: 'sbom.cdx.json', content: '{"bomFormat":"CycloneDX"}' },
      ],
    );
    try {
      generate(dir);
      const text = readFileSync(join(dir, 'SHA256SUMS'), 'utf-8');
      expect(text).toContain('agent-linux-x64');
      expect(text).toContain('agent-darwin-arm64');
      expect(text).toContain('sbom.cdx.json');
      expect(text).not.toContain('agent-linux-x64.map');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generate throws when no release assets exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sums-'));
    try {
      expect(() => generate(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify returns ok=true on round trip', () => {
    const dir = setupDist([{ id: 'linux-x64', content: 'binary-linux' }]);
    try {
      generate(dir);
      const result = verify(dir);
      expect(result.ok).toBe(true);
      expect(result.failed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify reports tampered files', () => {
    const dir = setupDist([{ id: 'linux-x64', content: 'binary-linux' }]);
    try {
      generate(dir);
      writeFileSync(join(dir, 'agent-linux-x64'), 'tampered');
      const result = verify(dir);
      expect(result.ok).toBe(false);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0]?.filename).toBe('agent-linux-x64');
      expect(result.failed[0]?.actual).not.toBe(result.failed[0]?.expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify reports missing files', () => {
    const dir = setupDist([{ id: 'linux-x64', content: 'binary-linux' }]);
    try {
      generate(dir);
      rmSync(join(dir, 'agent-linux-x64'));
      const result = verify(dir);
      expect(result.ok).toBe(false);
      expect(result.failed[0]?.actual).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
