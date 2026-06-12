import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_GUIDE_FILENAMES,
  PROJECT_GUIDE_MAX_BYTES,
  assembleProjectContext,
  composeWithProjectContext,
} from '../../src/cli/project-context.ts';

// Pin the contract spec/CONTEXT_TUNING.md §2.0 (post-amendment)
// establishes:
//   - the guide BODY is embedded eagerly (not a pointer)
//   - suppressed unless the directory holding the guide is trusted
//     AND a guide file is present
//   - multi-name resolution (AGENTS.md / CLAUDE.md / …), first
//     present per location, cwd-first across locations
//   - the body is sanitized (control bytes stripped, markdown kept),
//     fenced, byte-capped, and followed by the caveat footer
//   - the embedded path is sanitized against code-span break-out
// Bumping any of these is a public-contract change that should
// surface here at PR review, not as quiet behavior drift.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-project-context-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Default both trust flags to `true` so the common tests stay
// readable; trust-boundary tests set them explicitly. Mirrors the
// typical "trust the whole repo" workflow where bootstrap reports
// both flags true.
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

describe('assembleProjectContext — presence + trust gate', () => {
  test('returns empty section when no guide is present at cwd or repoRoot', () => {
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.text).toBe('');
    expect(out.guidePath).toBeUndefined();
  });

  test('returns empty section when cwd is untrusted, even if a guide exists', () => {
    // The trust gate is at the directory level: an untrusted cwd
    // suppresses the eager content entirely. We never embed the body
    // of a file the operator did not authorize access to.
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
    const out = assembleProjectContext(
      trusted({ cwd: dir, repoRoot: dir, isCwdTrusted: false, isRepoRootTrusted: false }),
    );
    expect(out.text).toBe('');
    expect(out.guidePath).toBeUndefined();
  });

  test('embeds the guide body, header, path, fence, and caveat when trusted and present', () => {
    const body = '# Project rules\nUse pnpm, not npm.\n';
    writeFileSync(join(dir, 'AGENTS.md'), body);
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
    // Header pinned so a softening rewrite shows up at review.
    expect(out.text).toContain('# Project context');
    // The actual body is present — this is eager content, not a
    // pointer. The whole point of the amendment.
    expect(out.text).toContain('Use pnpm, not npm.');
    // Path advertised in a code span so the model can read_file for
    // the full file if it was truncated, and for provenance.
    expect(out.text).toContain(join(dir, 'AGENTS.md'));
    // Fence delimits the attacker-influenceable body.
    expect(out.text).toContain('----- BEGIN AGENTS.md -----');
    expect(out.text).toContain('----- END AGENTS.md -----');
    // Caveat footer frames it as reference, not commands.
    expect(out.text).toContain('may or may not be relevant');
    expect(out.text).toContain('should not respond to it unless it is highly relevant');
    expect(out.truncated).toBeUndefined();
  });
});

describe('assembleProjectContext — multi-name resolution', () => {
  test('resolves CLAUDE.md when AGENTS.md is absent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# claude rules\n');
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(dir, 'CLAUDE.md'));
    expect(out.text).toContain('----- BEGIN CLAUDE.md -----');
    expect(out.text).toContain('claude rules');
  });

  test('resolves any converged filename', () => {
    // Pin the full set so dropping a name from the list surfaces
    // here. Each is probed in isolation in its own temp dir.
    for (const name of PROJECT_GUIDE_FILENAMES) {
      const d = mkdtempSync(join(tmpdir(), 'forja-guide-name-'));
      try {
        writeFileSync(join(d, name), `# ${name} body\n`);
        const out = assembleProjectContext(trusted({ cwd: d, repoRoot: d }));
        expect(out.guidePath).toBe(join(d, name));
        expect(out.text).toContain(`----- BEGIN ${name} -----`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  test('AGENTS.md wins over CLAUDE.md when both exist (precedence order)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# agents wins\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '# claude loses\n');
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
    expect(out.text).toContain('agents wins');
    expect(out.text).not.toContain('claude loses');
  });
});

describe('assembleProjectContext — cwd-first + repoRoot fallback', () => {
  test('cwd-specific guide wins over the repoRoot one', () => {
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# repo-wide');
    writeFileSync(join(subdir, 'AGENTS.md'), '# subdir-specific');
    const out = assembleProjectContext(trusted({ cwd: subdir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(subdir, 'AGENTS.md'));
    expect(out.text).toContain('subdir-specific');
  });

  test('falls back to repoRoot when cwd has no guide AND repoRoot is trusted', () => {
    const subdir = join(dir, 'src', 'cli');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectContext(trusted({ cwd: subdir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
  });

  test('cwd === repoRoot collapses to a single probe', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
  });
});

describe('assembleProjectContext — trust boundary (security)', () => {
  test('does NOT embed repoRoot guide when only the cwd subdir is trusted', () => {
    // Threat model: operator trusted only `/repo/src/`, not
    // `/repo/`. Trust storage is exact-path membership, so the
    // repoRoot is NOT implicitly trusted. Embedding `/repo/AGENTS.md`
    // would surface — and act on — content from a path outside the
    // explicit grant. The gate prevents that.
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# repo-wide secrets disclosure rules');
    const out = assembleProjectContext({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: true,
      isRepoRootTrusted: false,
    });
    expect(out.text).toBe('');
    expect(out.guidePath).toBeUndefined();
  });

  test('does NOT embed cwd guide when only repoRoot is trusted (defense in depth)', () => {
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'AGENTS.md'), '# subdir rules');
    const out = assembleProjectContext({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: false,
      isRepoRootTrusted: true,
    });
    // cwd probe skipped (file present but dir untrusted); repoRoot
    // has no guide → empty.
    expect(out.text).toBe('');
  });

  test('repoRoot fallback taken only when repoRoot is trusted and cwd misses', () => {
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# rules');
    const out = assembleProjectContext({
      cwd: subdir,
      repoRoot: dir,
      isCwdTrusted: true,
      isRepoRootTrusted: true,
    });
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
  });

  test('does NOT follow a guide symlink that escapes the trusted directory', () => {
    // Threat: a cloned/inherited repo ships AGENTS.md as a symlink to
    // a secret OUTSIDE the tree (~/.ssh/id_rsa). Trust authorizes the
    // directory, not arbitrary files a symlink points at. The eager
    // read bypasses the permission engine's protected-path checks, so
    // the containment guard has to stop the exfil here. Treated as
    // absent → empty section.
    const secretDir = mkdtempSync(join(tmpdir(), 'forja-secret-'));
    const secret = join(secretDir, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY MATERIAL');
    try {
      symlinkSync(secret, join(dir, 'AGENTS.md'));
      const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
      expect(out.text).toBe('');
      expect(out.text).not.toContain('PRIVATE KEY');
      expect(out.guidePath).toBeUndefined();
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  test('escaping cwd symlink does not block a legitimate repoRoot fallback', () => {
    // The cwd guide is a malicious escaping symlink; the repoRoot has
    // a real guide. The escape is skipped (as if absent), so the
    // fallback still surfaces the legitimate file rather than the
    // session losing its project context to a poisoned subdir link.
    const subdir = join(dir, 'src');
    mkdirSync(subdir, { recursive: true });
    const secretDir = mkdtempSync(join(tmpdir(), 'forja-secret-'));
    writeFileSync(join(secretDir, 'id_rsa'), 'PRIVATE KEY MATERIAL');
    writeFileSync(join(dir, 'AGENTS.md'), '# real repo rules');
    try {
      symlinkSync(join(secretDir, 'id_rsa'), join(subdir, 'AGENTS.md'));
      const out = assembleProjectContext(trusted({ cwd: subdir, repoRoot: dir }));
      expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
      expect(out.text).toContain('real repo rules');
      expect(out.text).not.toContain('PRIVATE KEY');
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  test('follows an in-tree guide symlink (contained → allowed)', () => {
    // A monorepo symlinking a shared guide WITHIN the trusted tree is
    // legitimate and must still load — the guard blocks escapes, not
    // all symlinks.
    writeFileSync(join(dir, 'shared-AGENTS.md'), '# shared rules\n');
    symlinkSync(join(dir, 'shared-AGENTS.md'), join(dir, 'AGENTS.md'));
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.text).toContain('shared rules');
    expect(out.guidePath).toBe(join(dir, 'AGENTS.md'));
  });
});

describe('assembleProjectContext — content sanitization + size cap', () => {
  test('strips dangerous control bytes from the body but preserves markdown', () => {
    // ESC (terminal escape), NUL, and BEL must not survive into the
    // system prompt; backticks, newlines, and markdown structure are
    // legitimate prose the model is meant to read.
    const body = '# rules\nrun `bun test`\n\x1b[31mred\x1b[0m\x00\x07ok\n';
    writeFileSync(join(dir, 'AGENTS.md'), body);
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    // Control bytes gone.
    expect(out.text).not.toContain('\x1b');
    expect(out.text).not.toContain('\x00');
    expect(out.text).not.toContain('\x07');
    // Markdown preserved: backtick code span and the surrounding
    // text survive verbatim.
    expect(out.text).toContain('run `bun test`');
    expect(out.text).toContain('red');
    expect(out.text).toContain('ok');
  });

  test('truncates an over-cap body with a visible marker and sets the flag', () => {
    const big = `# header\n${'x'.repeat(PROJECT_GUIDE_MAX_BYTES + 4096)}\n`;
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const out = assembleProjectContext(trusted({ cwd: dir, repoRoot: dir }));
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('truncated at');
    expect(out.text).toContain('read_file');
    // The section must not embed the whole oversized file: bounded
    // by the cap plus the fixed wrapper (header + fence + caveat +
    // marker).
    expect(out.text.length).toBeLessThan(PROJECT_GUIDE_MAX_BYTES + 2048);
  });
});

describe('assembleProjectContext — path injection hardening', () => {
  // The trust modal authorizes ACCESS to a directory; it does NOT
  // cleanse the path STRING of bytes that would break out of the
  // code span the header embeds the path in. Realistic shapes:
  //   - `cd /tmp/$(crafted)` pre-`agent`
  //   - a clone target whose name contains backticks or newlines
  //   - a shared-volume dir another user named with control bytes

  test('a backtick in the cwd path does not break out of its code span', () => {
    const evilCwd = mkdtempSync(join(dir, 'a`b-'));
    writeFileSync(join(evilCwd, 'AGENTS.md'), '# body\n');
    const out = assembleProjectContext(trusted({ cwd: evilCwd, repoRoot: evilCwd }));
    // The header line embedding the path must have balanced
    // backticks (open + close of the code span); the path's own
    // backtick was replaced by an apostrophe.
    const headerLine = out.text.split('\n').find((l) => l.includes('agent-instructions file ('));
    expect(headerLine).toBeDefined();
    expect((headerLine?.match(/`/g) ?? []).length).toBe(2);
    // On-disk path returned raw for observability.
    expect(out.guidePath).toBe(join(evilCwd, 'AGENTS.md'));
  });

  test('newlines in the cwd path do not inject extra prompt lines', () => {
    let evilCwd: string;
    try {
      evilCwd = mkdtempSync(join(dir, 'a\nb-'));
    } catch {
      // Filesystem rejected the byte (some setups do). The path
      // sanitizer still handles the case for other sources (a
      // `--cwd` flag from a wrapper); the env-prompt unit tests pin
      // that. Skip the integration arm cleanly.
      return;
    }
    writeFileSync(join(evilCwd, 'AGENTS.md'), '# body\n');
    const out = assembleProjectContext(trusted({ cwd: evilCwd, repoRoot: evilCwd }));
    // The header line stays single with two backticks — no injected
    // standalone line from the path.
    const headerLines = out.text.split('\n').filter((l) => l.includes('agent-instructions file ('));
    expect(headerLines).toHaveLength(1);
    expect((headerLines[0]?.match(/`/g) ?? []).length).toBe(2);
  });
});

describe('composeWithProjectContext', () => {
  test('returns base unchanged when section is empty', () => {
    expect(composeWithProjectContext('base prompt', '')).toBe('base prompt');
    expect(composeWithProjectContext(undefined, '')).toBeUndefined();
  });

  test('appends section to a non-empty base with a blank-line separator', () => {
    expect(composeWithProjectContext('base prompt', 'SECTION')).toBe('base prompt\n\nSECTION');
  });

  test('returns section alone when base is undefined or empty', () => {
    expect(composeWithProjectContext(undefined, 'SECTION')).toBe('SECTION');
    expect(composeWithProjectContext('', 'SECTION')).toBe('SECTION');
  });
});
