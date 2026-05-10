import { describe, expect, test } from 'bun:test';
import { TARGETS, assetName, findTarget } from '../../scripts/targets.ts';
import { targetById } from './_helpers.ts';

describe('targets registry', () => {
  test('contains the 5 spec-mandated targets', () => {
    const ids = TARGETS.map((t) => t.id).sort();
    expect(ids).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']);
  });

  test('Windows is the only target with .exe extension', () => {
    for (const t of TARGETS) {
      if (t.os === 'windows') expect(t.ext).toBe('.exe');
      else expect(t.ext).toBe('');
    }
  });

  test('size budgets match PERFORMANCE.md §18.2', () => {
    expect(findTarget('linux-x64')?.sizeMaxMiB).toBe(110);
    expect(findTarget('linux-arm64')?.sizeMaxMiB).toBe(110);
    expect(findTarget('darwin-x64')?.sizeMaxMiB).toBe(75);
    expect(findTarget('darwin-arm64')?.sizeMaxMiB).toBe(70);
    expect(findTarget('windows-x64')?.sizeMaxMiB).toBe(125);
  });

  test('assetName uses agent-<id> with extension', () => {
    expect(assetName(targetById('linux-x64'))).toBe('agent-linux-x64');
    expect(assetName(targetById('windows-x64'))).toBe('agent-windows-x64.exe');
  });

  test('findTarget returns undefined for unknown ids', () => {
    expect(findTarget('plan9-mips')).toBeUndefined();
  });

  test('every target has a Bun --target string', () => {
    for (const t of TARGETS) {
      expect(t.bunTarget).toMatch(/^bun-(linux|darwin|windows)-(x64|arm64)/);
    }
  });
});
