import { describe, expect, test } from 'bun:test';
import { shortenCwd } from '../../../src/tui/render/cwd.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const unicode: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...unicode, unicode: false };

const HOME = '/home/lex';

describe('shortenCwd', () => {
  test('elides the noisy middle of a removable-drive mount, keeping head + repo', () => {
    // The motivating case: a working copy on a /run/media/<uuid>/<user>
    // mount. The uuid + user are noise; keep `/run/media` (where) and
    // `Workspaces/forja` (what).
    const cwd = '/run/media/lex/728c6e4f-56b6-4bf8-903c-838aeaaf2690/Workspaces/forja';
    expect(shortenCwd(cwd, HOME, unicode)).toBe('/run/media/…/Workspaces/forja');
  });

  test('collapses $HOME to ~ and leaves it intact when under budget', () => {
    expect(shortenCwd('/home/lex/Workspaces/forja', HOME, unicode)).toBe('~/Workspaces/forja');
  });

  test('bare home collapses to ~', () => {
    expect(shortenCwd('/home/lex', HOME, unicode)).toBe('~');
  });

  test('elides a deep home path past budget, keeping ~ anchor + last two components', () => {
    const cwd = '/home/lex/dev/aaaa/bbbb/cccc/dddd/eeee/ffff/some-long-project-name';
    expect(shortenCwd(cwd, HOME, unicode)).toBe('~/…/ffff/some-long-project-name');
  });

  test('home collapse is boundary-anchored (a sibling dir is not mangled)', () => {
    // `/home/lexicon` must NOT become `~icon` under home `/home/lex`.
    expect(shortenCwd('/home/lexicon/forja', HOME, unicode)).toBe('/home/lexicon/forja');
  });

  test('a short absolute path under budget passes through untouched', () => {
    expect(shortenCwd('/usr/local/forja', HOME, unicode)).toBe('/usr/local/forja');
  });

  test('no home provided → no collapse, but long paths still elide', () => {
    const cwd = '/run/media/lex/728c6e4f-56b6-4bf8-903c-838aeaaf2690/Workspaces/forja';
    expect(shortenCwd(cwd, '', unicode)).toBe('/run/media/…/Workspaces/forja');
  });

  test('ASCII caps use the ... ellipsis fallback', () => {
    const cwd = '/run/media/lex/728c6e4f-56b6-4bf8-903c-838aeaaf2690/Workspaces/forja';
    expect(shortenCwd(cwd, HOME, ascii)).toBe('/run/media/.../Workspaces/forja');
  });

  test('a long path with too few components to drop returns the collapsed form', () => {
    // 4 components = headKeep(2) + tailKeep(2): nothing meaningful to elide,
    // so it stays whole even past the budget (truncateToWidth clips later).
    const cwd = `/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccccc/${'d'.repeat(20)}`;
    expect(shortenCwd(cwd, HOME, unicode)).toBe(cwd);
  });
});
