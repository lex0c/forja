import { describe, expect, test } from 'bun:test';
import {
  firstMatchingCommand,
  firstMatchingHost,
  firstMatchingPath,
  matchCommand,
  matchHost,
  matchPath,
} from '../../src/permissions/matcher.ts';

const CWD = '/proj';

describe('matchPath', () => {
  test('exact relative match', () => {
    expect(matchPath('src/foo.ts', 'src/foo.ts', CWD)).toBe(true);
  });

  test('relative pattern matches relative target', () => {
    expect(matchPath('src/**', 'src/a/b.ts', CWD)).toBe(true);
  });

  test('relative pattern matches absolute target inside cwd', () => {
    expect(matchPath('src/**', '/proj/src/a/b.ts', CWD)).toBe(true);
  });

  test('relative pattern does NOT match path outside cwd', () => {
    expect(matchPath('src/**', '/etc/passwd', CWD)).toBe(false);
  });

  test('absolute pattern matches absolute target outside cwd', () => {
    expect(matchPath('/etc/**', '/etc/passwd', CWD)).toBe(true);
  });

  test('deny pattern with leading wildcard', () => {
    expect(matchPath('**/.env*', '.env.local', CWD)).toBe(true);
    expect(matchPath('**/.env*', 'src/.env.local', CWD)).toBe(true);
    expect(matchPath('**/.env*', 'src/foo.ts', CWD)).toBe(false);
  });

  test('dot-prefixed cwd-relative pattern', () => {
    expect(matchPath('./src/**', 'src/foo.ts', CWD)).toBe(true);
  });
});

describe('matchCommand', () => {
  test('exact match', () => {
    expect(matchCommand('git status', 'git status')).toBe(true);
  });

  test('exact pattern does NOT match suffix', () => {
    expect(matchCommand('git status', 'git statusxyz')).toBe(false);
  });

  test('trailing wildcard matches arguments', () => {
    expect(matchCommand('git push *', 'git push origin main')).toBe(true);
  });

  test('does NOT match different command with shared prefix', () => {
    expect(matchCommand('git status', 'gitstatus')).toBe(false);
  });

  test('trims input whitespace', () => {
    expect(matchCommand('ls', '  ls  ')).toBe(true);
  });

  test('* matches any character including spaces', () => {
    expect(matchCommand('rm -rf *', 'rm -rf / --no-preserve-root')).toBe(true);
  });

  test('* matches across newlines (multi-line bash commands)', () => {
    // bash tool accepts multi-line commands. Without dotAll, the `.`
    // in our regex would skip `\n` and policy rules like `*` or
    // `bash -c *` would fall through to default deny on heredocs and
    // multi-line scripts.
    expect(matchCommand('*', 'echo a\necho b')).toBe(true);
    expect(matchCommand('python -c *', 'python -c "for i in range(3):\n  print(i)"')).toBe(true);
    expect(matchCommand('cat <<EOF\n*\nEOF', 'cat <<EOF\nhello\nworld\nEOF')).toBe(true);
  });

  test('? matches a single character including newline', () => {
    expect(matchCommand('a?b', 'a\nb')).toBe(true);
  });
});

describe('matchHost', () => {
  test('exact host match', () => {
    expect(matchHost('localhost', 'localhost')).toBe(true);
    expect(matchHost('localhost', 'example.com')).toBe(false);
  });

  test('case-insensitive', () => {
    expect(matchHost('Example.COM', 'example.com')).toBe(true);
  });

  test('glob pattern for subdomains', () => {
    expect(matchHost('*.internal', 'api.internal')).toBe(true);
    expect(matchHost('*.internal', 'api.public.com')).toBe(false);
  });
});

describe('first* helpers', () => {
  test('firstMatchingPath returns the matching pattern', () => {
    expect(firstMatchingPath(['src/**', 'tests/**'], 'tests/a.ts', CWD)).toBe('tests/**');
    expect(firstMatchingPath(['src/**'], 'docs/a.md', CWD)).toBeNull();
  });

  test('firstMatchingCommand returns first match in order', () => {
    expect(firstMatchingCommand(['ls', 'ls *'], 'ls -la')).toBe('ls *');
  });

  test('firstMatchingHost returns null for empty patterns', () => {
    expect(firstMatchingHost(undefined, 'example.com')).toBeNull();
    expect(firstMatchingHost([], 'example.com')).toBeNull();
  });
});
