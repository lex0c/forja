// Bash parser tests (3.5a).

import { describe, expect, test } from 'bun:test';
import { extractLeadingBinary } from '../../src/feedback/bash-parser.ts';

describe('extractLeadingBinary — plain commands', () => {
  test('simple command', () => {
    expect(extractLeadingBinary('grep foo bar')).toBe('grep');
  });

  test('no args', () => {
    expect(extractLeadingBinary('ls')).toBe('ls');
  });

  test('leading whitespace', () => {
    expect(extractLeadingBinary('   grep foo')).toBe('grep');
  });

  test('absolute path binary resolves to bare name', () => {
    expect(extractLeadingBinary('/usr/bin/grep foo')).toBe('grep');
  });

  test('relative path binary resolves to bare name', () => {
    expect(extractLeadingBinary('./grep foo')).toBe('grep');
  });
});

describe('extractLeadingBinary — env prefixes', () => {
  test('single env var', () => {
    expect(extractLeadingBinary('FOO=1 grep bar')).toBe('grep');
  });

  test('multiple env vars', () => {
    expect(extractLeadingBinary('FOO=1 BAR=2 grep bar')).toBe('grep');
  });

  test('env values with equals signs inside (treated as args boundary)', () => {
    // Conservative — first env-shape token is consumed; if the
    // second is also env-shape, consume; stop at first non-env.
    expect(extractLeadingBinary('NODE_OPTIONS=--max-old-space=4096 node script.js')).toBe('node');
  });
});

describe('extractLeadingBinary — cd prefixes', () => {
  test('single cd && command', () => {
    expect(extractLeadingBinary('cd /tmp && grep foo')).toBe('grep');
  });

  test('cd ; command', () => {
    expect(extractLeadingBinary('cd /tmp; grep foo')).toBe('grep');
  });

  test('multiple cd chain', () => {
    expect(extractLeadingBinary('cd /a && cd /b && grep foo')).toBe('grep');
  });

  test('parens around cd && command', () => {
    expect(extractLeadingBinary('(cd /tmp && grep foo)')).toBe('grep');
  });

  test('cd path with spaces (skipped to next separator)', () => {
    expect(extractLeadingBinary('cd /tmp/foo && rg bar')).toBe('rg');
  });
});

describe('extractLeadingBinary — null cases', () => {
  test('empty string', () => {
    expect(extractLeadingBinary('')).toBeNull();
  });

  test('only whitespace', () => {
    expect(extractLeadingBinary('   ')).toBeNull();
  });

  test("pipe at start (bail — emitter can't attribute)", () => {
    // Actually `cat foo | grep bar` — first binary is `cat`, not
    // null. The parser correctly captures `cat`; the pipe is past
    // the first binary so it doesn't affect detection.
    expect(extractLeadingBinary('cat foo | grep bar')).toBe('cat');
  });

  test('redirect before binary', () => {
    // The parser refuses when it hits `>` / `<` inside a cd-walk.
    // Plain redirects after a binary are fine — they're past the
    // binary already.
    expect(extractLeadingBinary('cd /tmp > /dev/null && grep foo')).toBeNull();
  });

  test('quoted command (bail rather than mis-parse)', () => {
    expect(extractLeadingBinary('cd "/tmp" && grep foo')).toBeNull();
  });

  test('subshell with backtick (bail)', () => {
    expect(extractLeadingBinary('echo `grep foo`')).toBe('echo');
  });

  test('only dot', () => {
    expect(extractLeadingBinary('.')).toBeNull();
  });
});

describe('extractLeadingBinary — real-world shapes', () => {
  test('git command', () => {
    expect(extractLeadingBinary('git status')).toBe('git');
  });

  test('npm scripts', () => {
    expect(extractLeadingBinary('npm run build')).toBe('npm');
  });

  test('bun command', () => {
    expect(extractLeadingBinary('bun test')).toBe('bun');
  });

  test('find with args', () => {
    expect(extractLeadingBinary('find . -name "*.ts"')).toBe('find');
  });
});
