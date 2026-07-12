import { describe, expect, test } from 'bun:test';
import { formatPermanent } from '../../src/tui/render/permanent.ts';
import { applyEvent, createInitialState } from '../../src/tui/state.ts';
import type { Capabilities } from '../../src/tui/term.ts';

const ascii: Capabilities = { isTTY: true, cols: 80, rows: 24, color: 'none', unicode: false };

describe('update:available', () => {
  test('reducer maps the event to an update-available permanent item', () => {
    const r = applyEvent(createInitialState(), {
      type: 'update:available',
      ts: 1,
      current: '0.1.3',
      latest: '0.2.0',
      command: 'npm i -g @lex0c/forja@latest',
    });
    expect(r.permanent).toEqual([
      {
        kind: 'update-available',
        current: '0.1.3',
        latest: '0.2.0',
        command: 'npm i -g @lex0c/forja@latest',
      },
    ]);
  });

  test('renders the accent headline then an indented origin-aware update command', () => {
    const lines = formatPermanent(
      {
        kind: 'update-available',
        current: '0.1.3',
        latest: '0.2.0',
        command: 'npm i -g @lex0c/forja@latest',
      },
      ascii,
    );
    expect(lines[0]?.trim()).toBe(''); // leading blank so it's its own block (UI §4.10.9)
    expect(lines.length).toBe(3); // blank + headline + command line
    const body = lines.join('\n');
    expect(body).toContain('Forja v0.2.0 available!');
    expect(body).toContain('Update: npm i -g @lex0c/forja@latest');
  });

  test('renders a long standalone command verbatim (item never truncates/wraps)', () => {
    const command = 'curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh';
    const lines = formatPermanent(
      { kind: 'update-available', current: '0.1.3', latest: '0.2.0', command },
      ascii,
    );
    expect(lines.length).toBe(3); // padFrame never wraps: a >80col command stays one copy-pasteable line
    expect(lines.join('\n')).toContain(`Update: ${command}`);
  });
});
