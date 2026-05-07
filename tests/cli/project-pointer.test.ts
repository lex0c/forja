import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleProjectPointer,
  composeWithProjectPointer,
} from '../../src/cli/project-pointer.ts';

// Pin the contract spec/CONTEXT_TUNING.md §2.0 establishes:
//   - pointer eager, body lazy
//   - pointer suppressed when AGENTS.md absent OR cwd untrusted
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

describe('assembleProjectPointer', () => {
  test('returns empty section when AGENTS.md is absent at both cwd and repoRoot', () => {
    const out = assembleProjectPointer({ cwd: dir, repoRoot: dir, isCwdTrusted: true });
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
    const out = assembleProjectPointer({ cwd: dir, repoRoot: dir, isCwdTrusted: false });
    expect(out.text).toBe('');
    expect(out.agentsMdPath).toBeUndefined();
  });

  test('emits a pointer section with the absolute AGENTS.md path when both gates pass', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
    const out = assembleProjectPointer({ cwd: dir, repoRoot: dir, isCwdTrusted: true });
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
    const out = assembleProjectPointer({ cwd: dir, repoRoot: dir, isCwdTrusted: true });
    expect(out.text.length).toBeLessThan(700);
  });

  test('cwd-first probe — cwd-specific AGENTS.md wins over repoRoot one', () => {
    // Per-area AGENTS.md (e.g. `src/AGENTS.md` for the engine,
    // `web/AGENTS.md` for the frontend). The cwd-specific file
    // is more relevant to the current task than the repo-level
    // one when the operator scoped the session at that subdir.
    const subdir = join(dir, 'src');
    require('node:fs').mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# repo-wide');
    writeFileSync(join(subdir, 'AGENTS.md'), '# subdir-specific');
    const out = assembleProjectPointer({ cwd: subdir, repoRoot: dir, isCwdTrusted: true });
    expect(out.agentsMdPath).toBe(join(subdir, 'AGENTS.md'));
  });

  test('falls back to repoRoot when AGENTS.md is missing at cwd subdir', () => {
    // The common case: operator runs `agent` from a subdir, but
    // AGENTS.md lives at the project root. cwd probe misses,
    // repoRoot fallback hits, pointer advertises the repoRoot
    // path. Without the fallback this slice would regress the
    // common operator workflow — pointer would simply not appear
    // for any subdir invocation.
    const subdir = join(dir, 'src', 'cli');
    require('node:fs').mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectPointer({ cwd: subdir, repoRoot: dir, isCwdTrusted: true });
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
  });

  test('cwd === repoRoot collapses to a single probe (no double-check, no false hit)', () => {
    // When `agent` is run from the project root, cwd and
    // repoRoot are equal. The implementation guards against
    // probing the same path twice; this test pins the behavior
    // (presence detected, single resolved path).
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectPointer({ cwd: dir, repoRoot: dir, isCwdTrusted: true });
    expect(out.agentsMdPath).toBe(join(dir, 'AGENTS.md'));
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
