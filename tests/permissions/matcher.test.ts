import { describe, expect, test } from 'bun:test';
import {
  containsShellInjection,
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

describe('containsShellInjection', () => {
  test('plain commands are not flagged', () => {
    expect(containsShellInjection('ls')).toBe(false);
    expect(containsShellInjection('git status')).toBe(false);
    expect(containsShellInjection('git log --oneline -10')).toBe(false);
    expect(containsShellInjection('rm -rf ./build')).toBe(false);
  });

  test('semicolon flags', () => {
    expect(containsShellInjection('ls; rm -rf .')).toBe(true);
    expect(containsShellInjection('git status; pwd')).toBe(true);
  });

  test('logical AND/OR chain flags', () => {
    expect(containsShellInjection('test -f x && rm x')).toBe(true);
    expect(containsShellInjection('mkdir -p dir || echo skip')).toBe(true);
  });

  test('pipe flags', () => {
    expect(containsShellInjection('git log | head')).toBe(true);
    expect(containsShellInjection('cat file | grep foo')).toBe(true);
  });

  test('command substitution flags', () => {
    expect(containsShellInjection('echo $(whoami)')).toBe(true);
    expect(containsShellInjection('cat $(find . -name secret)')).toBe(true);
    expect(containsShellInjection('rm `which dangerous`')).toBe(true);
  });

  test('metachars inside single quotes are NOT flagged', () => {
    // git commit -m "fix; bug" — semicolon is literal inside the
    // quoted message. Single quotes preserve everything.
    expect(containsShellInjection("echo 'foo; bar'")).toBe(false);
    expect(containsShellInjection("echo 'a | b'")).toBe(false);
    expect(containsShellInjection("echo 'a && b'")).toBe(false);
  });

  test('metachars inside double quotes are NOT flagged', () => {
    // Double-quoted strings still allow $(...) expansion in real
    // bash, but for the policy decision we treat double-quoted
    // segments as opaque content. The deny path catches the
    // catastrophic shapes regardless; this guard is the defense
    // for accidental compounds, not a sandbox.
    expect(containsShellInjection('echo "foo; bar"')).toBe(false);
    expect(containsShellInjection('git commit -m "fix; close #1"')).toBe(false);
  });

  test('escaped metachars are NOT flagged', () => {
    expect(containsShellInjection('echo foo\\; bar')).toBe(false);
    expect(containsShellInjection('echo a\\|b')).toBe(false);
  });

  test('mixed quote / unquoted: unquoted metachar still flags', () => {
    // The injection IS the unquoted part — operator must see
    // this on the modal.
    expect(containsShellInjection('echo "safe text"; rm -rf .')).toBe(true);
    expect(containsShellInjection("git status -m 'msg' && rm")).toBe(true);
  });

  test('lone & does NOT flag (background marker, not chain)', () => {
    // Single `&` backgrounds a process; we don't treat it as
    // injection because the matcher's job is policy gate, not
    // bash-mode enforcement. The deny rules catch the
    // dangerous shapes anyway.
    expect(containsShellInjection('sleep 30 &')).toBe(false);
  });

  test('newline as command separator flags', () => {
    // Bash treats `\n` like `;`. The matcher compiles glob `*` to
    // regex `.*` with dotAll, so an allow pattern like
    // `git status -*` would otherwise match
    // `git status -s\nrm -rf /tmp/pwn` and silently authorize the
    // second line. The guard must catch raw newline regardless of
    // how the agent emitted the command (multi-line literal,
    // string-marshaled `\n`, etc.).
    expect(containsShellInjection('git status -s\nrm -rf /tmp/pwn')).toBe(true);
    expect(containsShellInjection('ls\necho pwned')).toBe(true);
    expect(containsShellInjection('foo\rbar')).toBe(true);
    expect(containsShellInjection('foo\r\nbar')).toBe(true);
  });

  test('newline inside single quotes does NOT flag (literal multi-line string)', () => {
    // Bash preserves newlines inside single-quoted strings as
    // literal characters, not separators. A multi-line commit
    // message via -m '...' should not trip the detector.
    expect(containsShellInjection("git commit -m 'line1\nline2'")).toBe(false);
  });

  test('newline inside double quotes does NOT flag (literal multi-line string)', () => {
    // Same property as single quotes for newline. Bash still
    // performs $() expansion inside double quotes, but the
    // detector already covers `$(` separately.
    expect(containsShellInjection('echo "line1\nline2"')).toBe(false);
  });

  test('backslash-newline (line continuation) does NOT flag', () => {
    // `\\\n` is the standard bash line-continuation: the joined
    // line is one logical command. The escape rule consumes the
    // backslash + newline together, so the scanner sees a
    // continuous unquoted run with no separator. Operator's
    // `git status -s \\\n  --porcelain` should pass without a
    // false-positive confirm.
    expect(containsShellInjection('git status -s \\\n  --porcelain')).toBe(false);
  });

  test('escaped newline in unquoted context does NOT flag', () => {
    // The escape rule applies to any character following `\\`,
    // including the literal sequence `\\\n` in the source string.
    expect(containsShellInjection('echo foo\\\nbar')).toBe(false);
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
