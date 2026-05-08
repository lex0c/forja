import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleProjectPointer,
  composeWithProjectPointer,
} from '../../src/cli/project-pointer.ts';

// Pin the contract spec/CONTEXT_TUNING.md §2.0 establishes:
//   - pointer eager, body lazy
//   - pointer suppressed unless the advertised path is trusted
//     AND present
//   - emitted text references AGENTS.md by path so the model knows
//     which read_file argument to use
// Bumping any of these is a public-contract change that should
// surface here at PR review, not as quiet behavior drift.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-project-pointer-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Helper: default both trust flags to `true` so existing tests
// stay readable. Tests exercising the trust gates set the flags
// explicitly. Mirrors the typical "trust the whole repo" workflow
// where bootstrap reports both flags true (cwd === repoRoot or
// the operator trusted both directories independently).
const trusted = (overrides: {
  cwd: string;
  repoRoot: string;
  isCwdTrusted?: boolean;
  isRepoRootTrusted?: boolean;
}) => ({
  cwd: overrides.cwd,
  repoRoot: overrides.repoRoot,
  isCwdTrusted: overrides.isCwdTrusted ?? true,
  isRepoRootTrusted: overrides.isRepoRootTrusted ?? true,
});

describe('assembleProjectPointer', () => {
  test('returns empty section when AGENTS.md is absent at both cwd and repoRoot', () => {
    const out = assembleProjectPointer(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.text).toBe('');
    expect(out.agentsMdPath).toBeUndefined();
  });

  test('returns empty section when cwd is untrusted, even if AGENTS.md exists', () => {
    // Untrusted cwd suppresses the pointer entirely. We don't
    // emit "AGENTS.md exists at <path> — but you can't read it"
    // because the trust gate is at the directory level; the
    // pointer's purpose is to nudge the model to read, and
    // there's nothing useful to nudge toward when reads through
    // the permission engine will be gated anyway.
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
    const out = assembleProjectPointer(
      trusted({ cwd: dir, repoRoot: dir, isCwdTrusted: false, isRepoRootTrusted: false }),
    );
    expect(out.text).toBe('');
    expect(out.agentsMdPath).toBeUndefined();
  });

  test('emits a pointer section with the absolute AGENTS.md path when both gates pass', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
    const out = assembleProjectPointer(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
    // Header pinned so a softening rewrite shows up at review.
    expect(out.text).toContain('# Project context');
    // Path advertised — the model needs the exact argument for
    // read_file. Without it, the pointer becomes "consult the
    // file somewhere" and the model has to grep.
    expect(out.text).toContain(join(dir, 'AGENTS.md'));
    // The verb pinned: nudges the model toward the lazy-read
    // path explicitly. A regression that drops this would let
    // the section degenerate into "AGENTS.md exists" with no
    // action verb — model is more likely to skip.
    expect(out.text).toContain('read_file');
  });

  test('pointer text stays small (~50 tokens / a few hundred chars)', () => {
    // Spec amendment estimate is ~50 tokens. Tokens vary by
    // model; chars are a deterministic proxy. 700 chars is a
    // generous ceiling — pointer must NOT grow into a paragraph
    // that re-introduces the eager-content cost the
    // amendment exists to avoid.
    writeFileSync(join(dir, 'AGENTS.md'), '');
    const out = assembleProjectPointer(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.text.length).toBeLessThan(700);
  });

  test('cwd-first probe — cwd-specific AGENTS.md wins over repoRoot one', () => {
    // Per-area AGENTS.md (e.g. `src/AGENTS.md` for the engine,
    // `web/AGENTS.md` for the frontend). The cwd-specific file
    // is more relevant to the current task than the repo-level
    // one when the operator scoped the session at that subdir.
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# repo-wide');
    writeFileSync(join(subdir, 'AGENTS.md'), '# subdir-specific');
    const out = assembleProjectPointer(trusted({ cwd: subdir, repoRoot: dir }));
    expect(out.agentsMdPath).toBe(join(subdir, 'AGENTS.md'));
  });

  test('falls back to repoRoot when AGENTS.md is missing at cwd subdir AND repoRoot is also trusted', () => {
    // The common case: operator runs `agent` from a subdir but
    // trusted the whole repo (typical workflow). cwd probe
    // misses, repoRoot fallback hits because BOTH trust flags
    // are true. Without the fallback this slice would regress
    // the common operator workflow — pointer would simply not
    // appear for any subdir invocation.
    const subdir = join(dir, 'src', 'cli');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectPointer(trusted({ cwd: subdir, repoRoot: dir }));
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
  });

  test('cwd === repoRoot collapses to a single probe (no double-check, no false hit)', () => {
    // When `agent` is run from the project root, cwd and
    // repoRoot are equal. The implementation guards against
    // probing the same path twice; this test pins the behavior
    // (presence detected, single resolved path).
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectPointer(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
  });
});

describe('assembleProjectPointer — trust boundary (security)', () => {
  test('does NOT advertise repoRoot AGENTS.md when only the cwd subdir is trusted', () => {
    // Threat model: operator trusted only `/repo/src/`, not
    // `/repo/`. Trust storage is exact-path membership, so the
    // repoRoot is NOT implicitly trusted. The trust modal at
    // boot probed `/repo/src/AGENTS.md` (absent) — operator
    // never saw "AGENTS.md present" warning for the repoRoot
    // file. Falling back to advertise `/repo/AGENTS.md` would
    // surface conventions outside the explicit trust grant;
    // the gate prevents that.
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# repo-wide secrets disclosure rules');
    // No AGENTS.md at the trusted subdir; repoRoot has one.
    const out = assembleProjectPointer({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: true,
      isRepoRootTrusted: false,
    });
    expect(out.text).toBe('');
    expect(out.agentsMdPath).toBeUndefined();
  });

  test('does NOT advertise cwd AGENTS.md when only repoRoot is trusted (defense in depth)', () => {
    // The mirror case: operator trusted `/repo/` but `agent`
    // was somehow invoked from an untrusted `/repo/src/`. cwd
    // probe should be skipped — even though the file exists,
    // the cwd itself is not in the trust list. (In practice
    // bootstrap exits before this state is reached, but the
    // helper is total — pin the gate so a future caller that
    // bypasses bootstrap can't slip an untrusted advertisement
    // through.)
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'AGENTS.md'), '# subdir rules');
    const out = assembleProjectPointer({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: false,
      isRepoRootTrusted: true,
    });
    // No AGENTS.md at repoRoot, so the fallback also misses
    // (existsSync false). Net: empty section. The point of this
    // test is the cwd probe SKIPS even with the file present.
    expect(out.text).toBe('');
  });

  test('repoRoot fallback is taken only when repoRoot is trusted and the cwd probe misses', () => {
    // Composite: operator trusted both, cwd has no AGENTS.md,
    // repoRoot has one. Fallback advertises repoRoot path.
    // Pin so the typical "trust the whole repo" workflow keeps
    // working — the gates aren't a regression in the happy
    // path, only in the narrow security boundary above.
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectPointer({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: true,
      isRepoRootTrusted: true,
    });
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
  });
});

describe('assembleProjectPointer — prompt-injection hardening', () => {
  // The trust modal authorizes ACCESS to a directory; it does
  // NOT cleanse the path STRING of bytes that would break out of
  // the surrounding code span and inject attacker-controlled
  // instructions at system-prompt priority. The pointer text MUST
  // sanitize the path it embeds even when the operator explicitly
  // trusted the directory. Realistic exploit shapes:
  //   - `cd /tmp/$(crafted)` pre-`agent` invocation
  //   - `git clone target/dir-with-newlines/...`
  //   - shared-volume mount where another user named a directory
  //     with backticks or control bytes

  test('a backtick in the cwd path does not break out of the code span', () => {
    // Build a real directory with a backtick in its name so
    // existsSync probes return true for the AGENTS.md inside.
    // POSIX permits the byte; the test assumes a Linux/macOS
    // filesystem (CI default).
    const evilCwd = mkdtempSync(join(dir, 'a`b-'));
    writeFileSync(join(evilCwd, 'AGENTS.md'), '# Malicious\n');
    const out = assembleProjectPointer(trusted({ cwd: evilCwd, repoRoot: evilCwd }));
    // The advertised path text must contain exactly two backticks
    // (open + close of the code span); the value's own backtick
    // was replaced by an apostrophe.
    const pointerLine = out.text.split('\n').find((l) => l.includes('AGENTS.md at'));
    expect(pointerLine).toBeDefined();
    expect((pointerLine?.match(/`/g) ?? []).length).toBe(2);
    // The on-disk path returned for observability stays raw — it
    // IS the real filesystem path, callers might want to read or
    // log it as-is.
    expect(out.agentsMdPath).toBe(join(evilCwd, 'AGENTS.md'));
  });

  test('newlines in the cwd path do not inject extra prompt lines', () => {
    // Build a directory whose name contains a newline. POSIX
    // permits this; on filesystems that reject the byte the test
    // skips by aborting at mkdir time — that's a platform fact,
    // not a regression.
    let evilCwd: string;
    try {
      evilCwd = mkdtempSync(join(dir, 'a\nb-'));
    } catch {
      // Filesystem rejected the byte (some setups do). The
      // sanitizer still has to handle the case in case some
      // OTHER source (a `--cwd` flag from a wrapper script)
      // delivers a newline byte; the env-prompt unit tests
      // already pin that. Skip the integration arm cleanly.
      return;
    }
    writeFileSync(join(evilCwd, 'AGENTS.md'), '# x\n');
    const out = assembleProjectPointer(trusted({ cwd: evilCwd, repoRoot: evilCwd }));
    // No standalone H2 line — the would-be injected header was
    // folded into the pointer line via U+23CE.
    expect(out.text).not.toMatch(/^## SYSTEM/m);
    // The pointer line itself stays a single line with two
    // backticks.
    const pointerLines = out.text.split('\n').filter((l) => l.includes('AGENTS.md at'));
    expect(pointerLines).toHaveLength(1);
    expect((pointerLines[0]?.match(/`/g) ?? []).length).toBe(2);
  });
});

describe('composeWithProjectPointer', () => {
  test('returns base unchanged when pointer is empty', () => {
    expect(composeWithProjectPointer('base prompt', '')).toBe('base prompt');
    expect(composeWithProjectPointer(undefined, '')).toBeUndefined();
  });

  test('appends pointer to a non-empty base with a blank-line separator', () => {
    const out = composeWithProjectPointer('base prompt', 'POINTER');
    expect(out).toBe('base prompt\n\nPOINTER');
  });

  test('returns pointer alone when base is undefined or empty', () => {
    expect(composeWithProjectPointer(undefined, 'POINTER')).toBe('POINTER');
    expect(composeWithProjectPointer('', 'POINTER')).toBe('POINTER');
  });
});
