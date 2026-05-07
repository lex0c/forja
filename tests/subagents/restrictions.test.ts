import { describe, expect, test } from 'bun:test';
import {
  RESTRICTION_ERROR_CODE,
  checkRestriction,
  enforceBashRestriction,
  enforcePathRestriction,
  matchAny,
  toRestrictionError,
} from '../../src/subagents/restrictions.ts';

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
  test('undefined restrictions → ok', () => {
    expect(checkRestriction('bash', { command: 'rm -rf /' }, undefined)).toEqual({ ok: true });
  });

  test('rule absent for the invoked tool → ok', () => {
    // Restrictions exist but only for write_file; bash is unguarded.
    const v = checkRestriction(
      'bash',
      { command: 'anything' },
      { write_file: { allowPaths: ['src/**'] } },
    );
    expect(v).toEqual({ ok: true });
  });

  test('bash rule applies via the command extractor', () => {
    const v = checkRestriction(
      'bash',
      { command: 'rm -rf /tmp' },
      { bash: { deny: ['rm -rf *'] } },
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
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('does not match');
  });

  test('args missing the expected field falls through to passthrough', () => {
    // `bash` invoked without a `command` arg — restrictions cannot
    // gate on what they cannot see. The underlying tool will
    // surface its own validation error; restrictions stay silent.
    const v = checkRestriction('bash', { wrong: 'shape' }, { bash: { deny: ['rm -rf *'] } });
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
    );
    expect(v).toEqual({ ok: true });
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
