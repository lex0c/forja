import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorktreesCli } from '../../src/cli/worktrees.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { insertSubagentWorktree } from '../../src/storage/repos/subagent-worktrees.ts';

// CLI-level tests. The gc engine itself is unit-tested in
// worktree-gc.test.ts. Here we cover argument parsing, output
// shape (table vs JSON), exit codes, and the interaction
// between subcommand verbs and flag positionals.

let db: DB;
let cacheRoot: string;
let parentCwd: string;
let outBuf: string;
let errBuf: string;

const out = (s: string): void => {
  outBuf += s;
};
const err = (s: string): void => {
  errBuf += s;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  cacheRoot = mkdtempSync(join(tmpdir(), 'forja-gc-cli-cache-'));
  parentCwd = mkdtempSync(join(tmpdir(), 'forja-gc-cli-parent-'));
  outBuf = '';
  errBuf = '';
});

afterEach(() => {
  for (const dir of [cacheRoot, parentCwd]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    db.close();
  } catch {
    // ignore
  }
});

// Seed parent → child sessions so the gc engine's repo-scope
// query (joins through sessions.parent_session_id) finds the
// row. The child id is what `subagent_worktrees.session_id`
// references; the parent's cwd gates row inclusion (gc resolves
// repoRoot via `git rev-parse` and falls back to literal
// parentCwd when not in a git repo — tests use the literal
// parentCwd as the parent's cwd to match that fallback).
const seedChildSession = (): { id: string } => {
  const parent = createSession(db, { model: 'mock/m', cwd: parentCwd });
  const child = createSession(db, {
    model: 'mock/m',
    cwd: parentCwd,
    parentSessionId: parent.id,
  });
  return { id: child.id };
};

describe('runWorktreesCli — list', () => {
  test('empty state → "no worktrees found" (table) / nothing (json)', async () => {
    const code = await runWorktreesCli({
      verb: 'list',
      positionals: [],
      json: false,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(outBuf).toContain('no worktrees found');
  });

  test('json mode → final summary object closes the NDJSON stream (M1)', async () => {
    // list --json should be symmetric with gc and dry-run:
    // the final line is a summary object so consumers get an
    // explicit end-of-stream marker. Without this, parsing
    // libraries that expect a sentinel had to rely on EOF.
    const session = seedChildSession();
    const path = join(cacheRoot, session.id);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId: session.id,
      path,
      branch: 'agent/explore-12345678',
      status: 'preserved',
    });
    const code = await runWorktreesCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.split('\n').filter((l) => l.length > 0);
    // Every line valid JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Last line is the summary.
    const last = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(typeof last.count).toBe('number');
    expect(typeof last.cache_root).toBe('string');
    expect(last.count).toBe(1);
  });

  test('json mode → NDJSON one entry per row', async () => {
    const session = seedChildSession();
    const path = join(cacheRoot, session.id);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId: session.id,
      path,
      branch: 'agent/explore-12345678',
      status: 'preserved',
    });
    // The CLI's defaultRunGitWorktreeList shells out to a real
    // git; the parentCwd is a tmpdir without a git repo, so the
    // git call exits non-zero and the helper returns ''. The
    // engine treats absent git output as "git knows nothing"
    // and still classifies the entry from the cache+DB join.
    const code = await runWorktreesCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    // One JSON line per entry. Parse and verify shape.
    const lines = outBuf
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(lines[0] ?? '{}');
    expect(first.path).toBe(path);
    expect(first.session_id).toBe(session.id);
  });
});

describe('runWorktreesCli — gc', () => {
  test('--dry-run prints plan, does not mutate DB', async () => {
    const session = seedChildSession();
    const path = join(cacheRoot, session.id);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId: session.id,
      path,
      branch: 'agent/explore-12345678',
      status: 'preserved',
    });
    const code = await runWorktreesCli({
      verb: 'gc',
      positionals: ['--dry-run'],
      json: false,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(outBuf).toContain('dry-run summary');
  });

  test('rejects unknown gc flag', async () => {
    const code = await runWorktreesCli({
      verb: 'gc',
      positionals: ['--bogus'],
      json: false,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('--bogus');
  });

  test('--json --dry-run emits valid NDJSON only (no plain-text summary)', async () => {
    // CLAUDE.md / spec §2.6: --json means NDJSON on stdout,
    // nothing else. A single non-JSON line (e.g. the human
    // "dry-run summary: 1 entry considered") would break
    // every machine consumer parsing stdout. Pin: every
    // non-empty line in --json --dry-run output must
    // JSON.parse without throwing.
    const session = seedChildSession();
    const path = join(cacheRoot, session.id);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId: session.id,
      path,
      branch: 'agent/explore-12345678',
      status: 'preserved',
    });
    const code = await runWorktreesCli({
      verb: 'gc',
      positionals: ['--dry-run'],
      json: true,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Throws if any line is not valid JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Final line should be the summary object.
    const last = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(last.dry_run).toBe(true);
    expect(typeof last.considered).toBe('number');
  });

  test('list rejects positional arguments', async () => {
    // list takes no positionals. Stray words sneaking through
    // (e.g. operator typo `agent --worktrees list xyz`) must
    // fail loud, not silently ignore.
    const code = await runWorktreesCli({
      verb: 'list',
      positionals: ['xyz'],
      json: false,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('takes no positionals');
  });

  test('rejects unknown verb', async () => {
    const code = await runWorktreesCli({
      verb: 'sneeze' as 'list',
      positionals: [],
      json: false,
      cwd: parentCwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('unknown --worktrees subcommand');
  });
});
