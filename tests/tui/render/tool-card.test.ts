import { describe, expect, test } from 'bun:test';
import { renderToolCardLive, spinnerGlyph } from '../../../src/tui/render/tool-card.ts';
import type { ActiveTool } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const ascii: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: false,
};
const unicode: Capabilities = { ...ascii, unicode: true };

const tool = (preview: string[] = []): ActiveTool => ({
  toolId: 't1',
  name: 'bash',
  args: 'npm test',
  startedAt: 0,
  preview,
});

describe('spinnerGlyph', () => {
  test('Unicode rotates through 10 frames at 80ms intervals', () => {
    expect(spinnerGlyph(unicode, 0)).toBe('⠋');
    expect(spinnerGlyph(unicode, 80)).toBe('⠙');
    expect(spinnerGlyph(unicode, 80 * 9)).toBe('⠏');
    expect(spinnerGlyph(unicode, 80 * 10)).toBe('⠋');
  });

  test('ASCII rotates through 4 frames at 100ms intervals', () => {
    expect(spinnerGlyph(ascii, 0)).toBe('|');
    expect(spinnerGlyph(ascii, 100)).toBe('/');
    expect(spinnerGlyph(ascii, 200)).toBe('-');
    expect(spinnerGlyph(ascii, 300)).toBe('\\');
    expect(spinnerGlyph(ascii, 400)).toBe('|');
  });
});

describe('renderToolCardLive', () => {
  test('head line includes spinner, name, args, and elapsed', () => {
    const out = renderToolCardLive(tool(), unicode, 1234);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('bash');
    expect(out[0]).toContain('npm test');
    expect(out[0]).toContain('1.2s');
  });

  test('elapsed under 1s uses ms units', () => {
    expect(renderToolCardLive(tool(), unicode, 850)[0]).toContain('850ms');
  });

  test('elapsed clamps to 0s if now < startedAt', () => {
    const t: ActiveTool = { ...tool(), startedAt: 1000 };
    expect(renderToolCardLive(t, unicode, 500)[0]).toContain('0s');
  });

  test('head uses Unicode separator when available', () => {
    const out = renderToolCardLive(tool(), unicode, 0);
    expect(out[0]).toContain(' · ');
  });

  test('head uses ASCII separator when unicode disabled', () => {
    const out = renderToolCardLive(tool(), ascii, 0);
    expect(out[0]).toContain(' - ');
  });

  test('preview lines render below head with tree branches', () => {
    const out = renderToolCardLive(tool(['line1', 'line2', 'line3']), unicode, 0);
    expect(out).toHaveLength(4);
    // Mid-branches use ├, last uses └.
    expect(out[1]).toContain('├');
    expect(out[2]).toContain('├');
    expect(out[3]).toContain('└');
  });

  test('preview lines use ASCII branches when unicode disabled', () => {
    const out = renderToolCardLive(tool(['only']), ascii, 0);
    expect(out[1]).toContain('\\');
  });

  test('preview lines wrapped with dim SGR when color enabled', () => {
    const colorCaps = { ...unicode, color: 'basic' as const };
    const out = renderToolCardLive(tool(['hi']), colorCaps, 0);
    expect(out[1]).toBe(`${CSI}2m  └ hi${CSI}0m`);
  });

  test('no preview → only head line', () => {
    expect(renderToolCardLive(tool(), unicode, 0)).toHaveLength(1);
  });

  test('single preview line gets the closing branch', () => {
    const out = renderToolCardLive(tool(['solo']), unicode, 0);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('└');
    expect(out[1]).not.toContain('├');
  });
});
