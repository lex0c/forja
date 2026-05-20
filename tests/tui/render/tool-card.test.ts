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

const tool = (preview: string[] = [], subject: string | null = 'npm test'): ActiveTool => ({
  toolId: 't1',
  name: 'bash',
  activeVerb: 'Executing',
  finalVerb: 'Executed',
  subject,
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

describe('renderToolCardLive (operation chip, active state — UI.md §4.10.5)', () => {
  test('head line is `<spinner> <activeVerb>…  [<elapsed>]`', () => {
    const out = renderToolCardLive(tool(), unicode, 1234);
    // [chip head, sub-content]
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Executing…');
    expect(out[0]).toContain('[1.2s]');
    // Spinner glyph leads the head — the specific frame depends on
    // now (covered in spinnerGlyph tests); here we just check the
    // first char is one of the cycle's frames.
    const firstChar = (out[0] ?? '').charAt(0);
    expect(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']).toContain(firstChar);
  });

  test('elapsed under 1s uses ms units in the bracket', () => {
    expect(renderToolCardLive(tool(), unicode, 850)[0]).toContain('[850ms]');
  });

  test('elapsed clamps to 0ms if now < startedAt', () => {
    const t: ActiveTool = { ...tool(), startedAt: 1000 };
    expect(renderToolCardLive(t, unicode, 500)[0]).toContain('[0ms]');
  });

  test('subject renders as sub-content under `└─ ` (Unicode)', () => {
    const out = renderToolCardLive(tool([], '/foo.ts'), unicode, 0);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(
      `${CSI}2m└─ /foo.ts${CSI}0m`.replace(`${CSI}2m`, '').replace(`${CSI}0m`, ''),
    );
    // Color: 'none' for `unicode` here, so SGR strips off above; just
    // assert the connector + subject content.
    expect(out[1]).toBe('└─ /foo.ts');
  });

  test('subject sub-content uses `\\- ` connector under ASCII', () => {
    const out = renderToolCardLive(tool([], '/foo.ts'), ascii, 0);
    expect(out[1]).toBe('\\- /foo.ts');
  });

  test('null subject drops the sub-content line entirely', () => {
    const out = renderToolCardLive(tool([], null), unicode, 0);
    expect(out).toHaveLength(1);
  });

  test('preview lines render below subject with tree branches', () => {
    const out = renderToolCardLive(tool(['line1', 'line2', 'line3']), unicode, 0);
    // [chip head, subject, branch+, branch+, branch└]
    expect(out).toHaveLength(5);
    expect(out[2]).toContain('├');
    expect(out[3]).toContain('├');
    expect(out[4]).toContain('└');
  });

  test('preview lines use ASCII branches when unicode disabled', () => {
    const out = renderToolCardLive(tool(['only']), ascii, 0);
    expect(out[2]).toContain('\\');
  });

  test('chip head wrapped with warn SGR when color enabled', () => {
    const colorCaps = { ...unicode, color: 'basic' as const };
    const out = renderToolCardLive(tool(), colorCaps, 0);
    // warn = CSI 33 m
    expect(out[0]).toContain(`${CSI}33m`);
  });

  test('subject uses secondary SGR (visibly grey); preview stays dim', () => {
    // Sub-content carries the path / arg the operator scans for and
    // needs to be readable; SGR 90 (bright-black) renders as grey in
    // default terminals, while SGR 2 (faint) is frequently invisible.
    // Preview output keeps SGR 2 — it's bulk streaming content, not a
    // primary signal.
    const colorCaps = { ...unicode, color: 'basic' as const };
    const out = renderToolCardLive(tool(['hi']), colorCaps, 0);
    expect(out[1]).toContain(`${CSI}90m`); // sub-content secondary
    expect(out[2]).toContain(`${CSI}2m`); // preview dim
  });
});
