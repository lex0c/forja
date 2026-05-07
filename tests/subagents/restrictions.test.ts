import { describe, expect, test } from 'bun:test';
import {
  RESTRICTION_ERROR_CODE,
  checkRestriction,
  enforceBashRestriction,
  enforcePathRestriction,
  matchAny,
  toRestrictionError,
  wrapToolWithRestrictions,
} from '../../src/subagents/restrictions.ts';
import { type Tool, type ToolContext, isToolError } from '../../src/tools/types.ts';

describe('matchAny — glob/prefix matcher (no regex)', () => {
  test('literal pattern requires an exact match', () => {
    expect(matchAny('git status', ['git status'])).toEqual({
      matched: true,
      pattern: 'git status',
    });
    expect(matchAny('git statu', ['git status'])).toEqual({ matched: false });
    expect(matchAny('git status x', ['git status'])).toEqual({ matched: false });
  });

  test('trailing star matches as prefix', () => {
    expect(matchAny('git diff main..HEAD', ['git diff *'])).toEqual({
      matched: true,
      pattern: 'git diff *',
    });
    // The pattern `git diff *` requires a SPACE then any tail —
    // `git diff` (no trailing space) does NOT match. The author
    // who wants both must write `git diff*` (no space). This is
    // the standard glob semantics; encoding the alternative
    // (PathMatchSpec, etc.) would invite ambiguity.
    expect(matchAny('git diff', ['git diff *'])).toEqual({ matched: false });
    expect(matchAny('git diff', ['git diff*'])).toEqual({
      matched: true,
      pattern: 'git diff*',
    });
    // Non-matching prefix
    expect(matchAny('git status', ['git diff *'])).toEqual({ matched: false });
  });

  test('star in the middle backtracks', () => {
    expect(matchAny('git diff --stat foo', ['git * foo'])).toEqual({
      matched: true,
      pattern: 'git * foo',
    });
    expect(matchAny('git diff bar', ['git * foo'])).toEqual({ matched: false });
  });

  test('star matches across slashes (no globstar distinction)', () => {
    expect(matchAny('src/foo/bar.ts', ['src/**'])).toEqual({
      matched: true,
      pattern: 'src/**',
    });
    expect(matchAny('src/foo.ts', ['src/*'])).toEqual({
      matched: true,
      pattern: 'src/*',
    });
    expect(matchAny('lib/foo.ts', ['src/*'])).toEqual({ matched: false });
  });

  test('multiple stars in a pattern still match', () => {
    expect(matchAny('npm run build:prod', ['npm * build:*'])).toEqual({
      matched: true,
      pattern: 'npm * build:*',
    });
    expect(matchAny('npm test', ['npm test*'])).toEqual({
      matched: true,
      pattern: 'npm test*',
    });
    expect(matchAny('npm test --watch', ['npm test*'])).toEqual({
      matched: true,
      pattern: 'npm test*',
    });
  });

  test('star alone matches any input including empty', () => {
    expect(matchAny('', ['*'])).toEqual({ matched: true, pattern: '*' });
    expect(matchAny('anything', ['*'])).toEqual({ matched: true, pattern: '*' });
  });

  test('empty pattern only matches empty input', () => {
    expect(matchAny('', [''])).toEqual({ matched: true, pattern: '' });
    expect(matchAny('x', [''])).toEqual({ matched: false });
  });

  test('returns the FIRST matching pattern when multiple match', () => {
    // The first pattern that matches wins — operators reading the
    // refusal hint expect to see the rule that triggered, not a
    // later one that would also match.
    const result = matchAny('git diff main', ['git diff *', 'git *']);
    expect(result).toEqual({ matched: true, pattern: 'git diff *' });
  });

  test('empty pattern list never matches', () => {
    expect(matchAny('anything', [])).toEqual({ matched: false });
  });
});

describe('enforceBashRestriction', () => {
  test('absent allow + absent deny passes through', () => {
    expect(enforceBashRestriction('git push origin', {})).toEqual({ ok: true });
  });

  test('deny match refuses with the matched pattern', () => {
    const v = enforceBashRestriction('rm -rf /tmp', { deny: ['rm -rf *'] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('denied');
    expect(v.reason).toContain('rm -rf *');
    expect(v.matchedPattern).toBe('rm -rf *');
  });

  test('deny takes precedence over allow', () => {
    // Both allow and deny match: deny wins. Without this rule a
    // cleverly-crafted overlap would let the allow leak.
    const v = enforceBashRestriction('rm -rf /tmp', {
      allow: ['rm *'],
      deny: ['rm -rf *'],
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.matchedPattern).toBe('rm -rf *');
  });

  test('allow match passes', () => {
    expect(enforceBashRestriction('git diff main', { allow: ['git diff *'] })).toEqual({
      ok: true,
    });
  });

  test('allow miss refuses with allow list in the reason', () => {
    const v = enforceBashRestriction('curl example.com', {
      allow: ['git *', 'rg *'],
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('does not match');
    expect(v.reason).toContain('git *');
    expect(v.reason).toContain('rg *');
  });

  test('empty allow array refuses every command', () => {
    // `allow: []` is a deliberate "deny everything via this gate".
    // The author who blanked the list expects refusal, not pass.
    const v = enforceBashRestriction('any command', { allow: [] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('(empty allow list)');
  });

  test('absent allow but present deny — passes when deny does not match', () => {
    expect(enforceBashRestriction('git status', { deny: ['rm *'] })).toEqual({ ok: true });
  });

  test('leading whitespace does not bypass deny pattern', () => {
    // Regression: the matcher does literal char-by-char comparison
    // anchored at position 0, so a leading space made
    // ` rm -rf /tmp` slip past `deny: ["rm -rf *"]` even though
    // the shell would tokenize that whitespace away before
    // executing. Normalization (trim + collapse) closes the gap.
    const v = enforceBashRestriction(' rm -rf /tmp', { deny: ['rm -rf *'] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.matchedPattern).toBe('rm -rf *');
  });

  test('trailing whitespace and embedded tabs/newlines normalize before match', () => {
    // Tab/newline within and around the command — normalized to
    // single-space form, which then matches the canonical pattern.
    const variants = [
      'rm -rf /tmp ',
      'rm -rf /tmp\n',
      '\trm -rf /tmp',
      'rm\t-rf /tmp',
      'rm  -rf  /tmp',
      'rm\n-rf\n/tmp',
    ];
    for (const cmd of variants) {
      const v = enforceBashRestriction(cmd, { deny: ['rm -rf *'] });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.matchedPattern).toBe('rm -rf *');
    }
  });

  test('whitespace normalization is symmetric — pattern with double-space still matches single-space command', () => {
    // The author wrote `rm  -rf *` (two spaces, likely a typo).
    // Normalizing only the input would still miss commands written
    // with one space — patterns get the same treatment so a typo
    // does not silently shrink coverage.
    const v = enforceBashRestriction('rm -rf /tmp', { deny: ['rm  -rf *'] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    // matchedPattern surfaces the ORIGINAL author text (not the
    // normalized projection), so the operator can locate it in the
    // .md frontmatter.
    expect(v.matchedPattern).toBe('rm  -rf *');
  });

  test('leading whitespace cannot fake a match against an allow list', () => {
    // Inverse of the deny-bypass: an allow list's match window
    // is also anchored at position 0, so leading whitespace
    // pre-fix made a clean command miss its own allow rule.
    const v = enforceBashRestriction('  git diff main', { allow: ['git diff *'] });
    expect(v).toEqual({ ok: true });
  });
});

describe('enforcePathRestriction', () => {
  test('allow_paths match passes', () => {
    expect(enforcePathRestriction('src/auth.ts', { allowPaths: ['src/**'] })).toEqual({
      ok: true,
    });
  });

  test('allow_paths miss refuses', () => {
    const v = enforcePathRestriction('node_modules/foo', { allowPaths: ['src/**'] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('does not match');
    expect(v.reason).toContain('src/**');
  });

  test('deny_paths beats allow_paths', () => {
    const v = enforcePathRestriction('src/secret/key.ts', {
      allowPaths: ['src/**'],
      denyPaths: ['src/secret/**'],
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.matchedPattern).toBe('src/secret/**');
  });

  test('absent paths gates pass through', () => {
    expect(enforcePathRestriction('anywhere/file.ts', {})).toEqual({ ok: true });
  });
});

describe('checkRestriction (tool dispatch hook)', () => {
  // Stable cwd for test inputs. Path-shape rules canonicalize the
  // arg against this before pattern-matching, so all path tests
  // express their intent relative to `/proj`.
  const CWD = '/proj';

  test('undefined restrictions → ok', () => {
    expect(checkRestriction('bash', { command: 'rm -rf /' }, undefined, CWD)).toEqual({
      ok: true,
    });
  });

  test('rule absent for the invoked tool → ok', () => {
    // Restrictions exist but only for write_file; bash is unguarded.
    const v = checkRestriction(
      'bash',
      { command: 'anything' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v).toEqual({ ok: true });
  });

  test('bash rule applies via the command extractor', () => {
    const v = checkRestriction(
      'bash',
      { command: 'rm -rf /tmp' },
      { bash: { deny: ['rm -rf *'] } },
      CWD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.matchedPattern).toBe('rm -rf *');
  });

  test('write_file rule applies via the path extractor', () => {
    const v = checkRestriction(
      'write_file',
      { path: 'node_modules/x.ts', content: '' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('does not match');
  });

  test('args missing the expected field falls through to passthrough', () => {
    // `bash` invoked without a `command` arg — restrictions cannot
    // gate on what they cannot see. The underlying tool will
    // surface its own validation error; restrictions stay silent.
    const v = checkRestriction('bash', { wrong: 'shape' }, { bash: { deny: ['rm -rf *'] } }, CWD);
    expect(v).toEqual({ ok: true });
  });

  test('unknown tool with a declared rule → ok (forward-compat)', () => {
    // The loader accepts arbitrary tool names in tool_restrictions
    // (slice 1 — forward-compat for future tools). Until the
    // runtime registers an extractor for that tool, the check
    // passes through. The whitelist in `tools[]` remains the floor.
    const v = checkRestriction(
      'future_tool_xyz',
      { foo: 'bar' },
      { future_tool_xyz: { allow: ['*'] } },
      CWD,
    );
    expect(v).toEqual({ ok: true });
  });

  test('path canonicalization: `..` traversal cannot escape allow_paths', () => {
    // Regression: `write_file`/`edit_file` resolve `args.path`
    // against `ctx.cwd` before writing. Matching the raw arg let
    // the model write to `secrets.txt` even though only `src/**`
    // was allowed — the raw `src/../secrets.txt` matches the
    // glob, but the canonical write target is outside `src/`.
    const v = checkRestriction(
      'write_file',
      { path: 'src/../secrets.txt', content: '' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    // Canonical form is `secrets.txt` (relative to cwd) — refused
    // by the allow-list miss, NOT silently allowed by the raw-arg
    // match against `src/**`.
    expect(v.reason).toContain('does not match');
  });

  test('path canonicalization: `./` redundant segments still match', () => {
    // The author wrote `./src/auth.ts` — the canonical form is
    // `src/auth.ts`, which DOES match `src/**`. The runtime
    // should accept it; refusing here would punish honest
    // arg shapes.
    const v = checkRestriction(
      'write_file',
      { path: './src/auth.ts', content: '' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v).toEqual({ ok: true });
  });

  test('path canonicalization: absolute path inside cwd is matched relative', () => {
    // `/proj/src/auth.ts` canonicalizes to `src/auth.ts` (relative
    // to `/proj`). Matches `src/**` cleanly.
    const v = checkRestriction(
      'write_file',
      { path: '/proj/src/auth.ts', content: '' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v).toEqual({ ok: true });
  });

  test('path canonicalization: absolute path OUTSIDE cwd is refused as escape', () => {
    // `/etc/passwd` canonicalizes to a relative `../etc/passwd`
    // (or absolute depending on platform). Either way it escapes
    // the sandbox; folding it into the matcher would invite
    // pattern authors to over-grant. The escape gate refuses
    // unconditionally with an explicit reason.
    const v = checkRestriction(
      'write_file',
      { path: '/etc/passwd', content: '' },
      { write_file: { allowPaths: ['src/**'] } },
      CWD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('outside the session cwd');
  });

  test('path canonicalization: deny_paths still applies after canonicalization', () => {
    // Mirror of the deny gate: a canonical path inside
    // `src/secret/**` is refused even if it was supplied as
    // `src/./secret/key.ts` (canonical form unchanged) or via
    // a redundant traversal that lands back inside.
    const v = checkRestriction(
      'write_file',
      { path: 'src/./secret/key.ts', content: '' },
      { write_file: { allowPaths: ['src/**'], denyPaths: ['src/secret/**'] } },
      CWD,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.matchedPattern).toBe('src/secret/**');
  });
});

describe('wrapToolWithRestrictions — integration with ToolContext.cwd', () => {
  // End-to-end: the wrapper threads `ctx.cwd` into checkRestriction,
  // and a traversal arg that bypassed the raw-arg matcher is
  // refused at the wrapper boundary, BEFORE the underlying tool
  // sees it. Production wires this in `subagent-child.ts` via
  // `wrapToolWithRestrictions(tool, restrictions)` over every
  // child-registered tool.
  const makeFakeWriteFile = (recorded: { path?: string }): Tool<
    { path: string },
    { ok: boolean }
  > => ({
    name: 'write_file',
    description: 'fake write_file used for restriction-wrapper integration tests',
    metadata: { category: 'fs.write', writes: true, idempotent: false },
    inputSchema: { type: 'object', properties: {} },
    execute: async (args) => {
      recorded.path = args.path;
      return { ok: true };
    },
  });

  const makeCtx = (cwd: string): ToolContext =>
    ({
      cwd,
      sessionId: 'sess-test',
      stepId: 'step-1',
      signal: new AbortController().signal,
      permissions: {} as ToolContext['permissions'],
    }) as ToolContext;

  test('traversal arg refused at wrapper, underlying tool never invoked', async () => {
    const recorded: { path?: string } = {};
    const wrapped = wrapToolWithRestrictions(makeFakeWriteFile(recorded), {
      write_file: { allowPaths: ['src/**'] },
    });
    const result = await wrapped.execute({ path: 'src/../secrets.txt' }, makeCtx('/proj'));
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe(RESTRICTION_ERROR_CODE);
    // Underlying tool never ran — no path was recorded.
    expect(recorded.path).toBeUndefined();
  });

  test('honest path inside cwd reaches the underlying tool', async () => {
    const recorded: { path?: string } = {};
    const wrapped = wrapToolWithRestrictions(makeFakeWriteFile(recorded), {
      write_file: { allowPaths: ['src/**'] },
    });
    const result = await wrapped.execute({ path: 'src/auth.ts' }, makeCtx('/proj'));
    expect(isToolError(result)).toBe(false);
    expect(recorded.path).toBe('src/auth.ts');
  });
});

describe('toRestrictionError', () => {
  test('produces the canonical refusal envelope', () => {
    const err = toRestrictionError('bash', 'command is denied', 'rm *');
    expect(err.is_error).toBe(true);
    if (err.is_error !== true) return;
    expect(err.error_code).toBe(RESTRICTION_ERROR_CODE);
    expect(err.error_code).toBe('policy.tool_restricted');
    expect(err.error_message).toContain("tool 'bash'");
    expect(err.error_message).toContain('command is denied');
    expect(err.retryable).toBe(false);
    expect(err.hint).toBeDefined();
    expect(err.details).toEqual({ matched_pattern: 'rm *' });
  });

  test('omits matched_pattern detail when missing', () => {
    const err = toRestrictionError('bash', 'command does not match any allow');
    if (err.is_error !== true) return;
    expect(err.details).toBeUndefined();
  });
});
