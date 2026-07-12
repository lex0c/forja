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
      url: 'https://github.com/lex0c/forja/releases/latest',
    });
    expect(r.permanent).toEqual([
      {
        kind: 'update-available',
        current: '0.1.3',
        latest: '0.2.0',
        url: 'https://github.com/lex0c/forja/releases/latest',
      },
    ]);
  });

  test('renders an accent line after a leading blank, pointing at `forja update`', () => {
    const lines = formatPermanent(
      {
        kind: 'update-available',
        current: '0.1.3',
        latest: '0.2.0',
        url: 'https://github.com/lex0c/forja/releases/latest',
      },
      ascii,
    );
    expect(lines[0]?.trim()).toBe(''); // leading blank so it's its own line (UI §4.10.9)
    const body = lines.join('\n');
    expect(body).toContain('Forja v0.2.0 available!');
    expect(body).toContain('Update: https://github.com/lex0c/forja/releases/latest');
  });
});
