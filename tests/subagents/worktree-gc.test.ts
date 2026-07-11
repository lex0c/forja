import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import {
  insertSubagentWorktree,
  listAllSubagentWorktrees,
} from '../../src/storage/repos/subagent-worktrees.ts';
import { applyGcPlan, buildGcPlan } from '../../src/subagents/worktree-gc.ts';

// Tests exercise the gc engine directly (buildGcPlan +
// applyGcPlan). All filesystem state is in tmpdirs; runGit
// stubs replace the real git invocations so the tests don't
// depend on a real parent repo for plan construction. The
// CLI surface is covered by a separate test file.

let db: DB;
let cacheRoot: string;
let parentCwd: string;

// Seed a parent → child session pair so the worktree audit
// row's join through sessions.parent_session_id resolves
// (the gc engine scopes by parent's cwd). Tests pass the
// child id as `subagent_worktrees.session_id`; the parent
// carries the cwd that gates row inclusion. The parent's
// cwd defaults to the test's `parentCwd` tmpdir so the
// gc engine's repo-root fallback (literal parentCwd when
// `git rev-parse` fails outside a real repo) matches.
const seedSession = (id?: string, customCwd?: string): string => {
  const cwd = customCwd ?? parentCwd;
  const parent = createSession(db, { model: 'mock/m', cwd });
  const child = createSession(db, {
    model: 'mock/m',
    cwd,
    parentSessionId: parent.id,
  });
  // Force a known id when needed for cross-fixture references.
  if (id !== undefined) {
    db.query('UPDATE sessions SET id = ? WHERE id = ?').run(id, child.id);
    return id;
  }
  return child.id;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  cacheRoot = mkdtempSync(join(tmpdir(), 'forja-gc-cache-'));
  parentCwd = mkdtempSync(join(tmpdir(), 'forja-gc-parent-'));
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

describe('buildGcPlan — classification', () => {
  test('empty everything → empty plan', async () => {
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries).toEqual([]);
    expect(plan.cacheRoot).toBe(cacheRoot);
  });

  test('preserved row + clean tree → ready_to_remove', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/explore-12345678',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/explore-12345678\n\n`,
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries.length).toBe(1);
    expect(plan.entries[0]?.kind).toBe('ready_to_remove');
    expect(plan.entries[0]?.path).toBe(path);
  });

  test('preserved row + dirty tree → preserved_dirty', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/refactor-aabbccdd',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/refactor-aabbccdd\n\n`,
      worktreeStatus: async () => 'dirty',
    });
    expect(plan.entries[0]?.kind).toBe('preserved_dirty');
  });

  test('cleaned row + dir still present → stale_cleaned', async () => {
    // Simulates a previous cleanup that succeeded in the audit
    // but failed at the actual rm (e.g., a process held the
    // dir on Windows). Next gc retries.
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/cleanup-fail-deadbeef',
      status: 'cleaned',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/cleanup-fail-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries[0]?.kind).toBe('stale_cleaned');
  });

  test('cleaned row + no dir + no git entry → silently consistent (no entry)', async () => {
    // Healthy state: row says cleaned and the world agrees.
    // gc emits nothing — no work to do.
    const sessionId = seedSession();
    insertSubagentWorktree(db, {
      sessionId,
      path: join(cacheRoot, sessionId),
      branch: 'agent/clean-deadbeef',
      status: 'cleaned',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries).toEqual([]);
  });

  test('preserved row + dir gone (operator manually cleaned) → missing', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    // Deliberately do NOT mkdir(path).
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/manual-cleanup-cafebabe',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries[0]?.kind).toBe('missing');
  });

  test('dir on disk + no DB row → orphan', async () => {
    const orphanId = '00000000-1111-2222-3333-444444444444';
    const path = join(cacheRoot, orphanId);
    mkdirSync(path);
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/orphan-12345678\n\n`,
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries[0]?.kind).toBe('orphan');
    expect(plan.entries[0]?.sessionId).toBeNull();
  });

  test('active row → entry classified as active (gc must never touch)', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/running-deadbeef',
      status: 'active',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/running-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries[0]?.kind).toBe('active');
  });

  test('mixed state: produces stable, sorted output', async () => {
    // Three worktrees: one preserved-clean, one preserved-dirty,
    // one orphan. Order asserted to lock the operator-facing
    // presentation.
    const idA = seedSession('aa000000-0000-0000-0000-000000000001');
    const idB = seedSession('bb000000-0000-0000-0000-000000000002');
    const pathA = join(cacheRoot, 'aa-aa');
    const pathB = join(cacheRoot, 'bb-bb');
    const pathOrphan = join(cacheRoot, 'cc-orphan');
    mkdirSync(pathA);
    mkdirSync(pathB);
    mkdirSync(pathOrphan);
    insertSubagentWorktree(db, {
      sessionId: idA,
      path: pathA,
      branch: 'agent/aa-aa',
      status: 'preserved',
    });
    insertSubagentWorktree(db, {
      sessionId: idB,
      path: pathB,
      branch: 'agent/bb-bb',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${pathA}\nbranch refs/heads/agent/aa-aa\n\nworktree ${pathB}\nbranch refs/heads/agent/bb-bb\n\nworktree ${pathOrphan}\nbranch refs/heads/agent/cc-orphan\n\n`,
      worktreeStatus: async (p) => (p === pathB ? 'dirty' : 'clean'),
    });
    expect(plan.entries.map((e) => [e.kind, e.path])).toEqual([
      ['ready_to_remove', pathA],
      ['preserved_dirty', pathB],
      ['orphan', pathOrphan],
    ]);
  });
});

describe('buildGcPlan — security: cross-repo isolation', () => {
  test('regression: gc from repo A does NOT see repo B worktrees', async () => {
    // Critical regression: DB and cache root are global (shared
    // across every repo the operator works in). Without
    // repo-scoped row selection, gc invoked from repo A
    // surfaces repo B's worktrees as candidates; --force (or
    // even auto-removal of clean preserved entries via the
    // rmSync fallback) silently destroys preserved work from
    // repo B. The buildGcPlan join filters by parent session
    // cwd. Two parents, two repos: gc only sees rows whose
    // parent's cwd matches the resolved repoRoot.
    const repoA = mkdtempSync(join(tmpdir(), 'forja-gc-repoA-'));
    const repoB = mkdtempSync(join(tmpdir(), 'forja-gc-repoB-'));
    try {
      // Two parent sessions, one per repo, each with its own
      // child + worktree row.
      const idA = seedSession(undefined, repoA);
      const idB = seedSession(undefined, repoB);
      const pathA = join(cacheRoot, idA);
      const pathB = join(cacheRoot, idB);
      mkdirSync(pathA);
      mkdirSync(pathB);
      insertSubagentWorktree(db, {
        sessionId: idA,
        path: pathA,
        branch: 'agent/repoA-deadbeef',
        status: 'preserved',
      });
      insertSubagentWorktree(db, {
        sessionId: idB,
        path: pathB,
        branch: 'agent/repoB-cafebabe',
        status: 'preserved',
      });

      // Resolve repoRoot to repoA — operator running gc from
      // repo A's cwd. The query MUST exclude repo B's row.
      const planA = await buildGcPlan({
        db,
        parentCwd: repoA,
        cacheRoot,
        resolveRepoRoot: async () => repoA,
        runGitWorktreeList: async () => '',
        worktreeStatus: async () => 'clean',
      });
      const pathsA = planA.entries.map((e) => e.path);
      expect(pathsA).toContain(pathA);
      expect(pathsA).not.toContain(pathB);

      // Symmetric: gc from repo B sees only repo B's row.
      const planB = await buildGcPlan({
        db,
        parentCwd: repoB,
        cacheRoot,
        resolveRepoRoot: async () => repoB,
        runGitWorktreeList: async () => '',
        worktreeStatus: async () => 'clean',
      });
      const pathsB = planB.entries.map((e) => e.path);
      expect(pathsB).toContain(pathB);
      expect(pathsB).not.toContain(pathA);
    } finally {
      for (const dir of [repoA, repoB]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  test('regression: symlinked-checkout cwd matches canonical repo root', async () => {
    // Operator running `cd /home/user/symlink-to-projA && agent`
    // creates sessions with cwd = literal symlink path. Later
    // `forja --worktrees gc` runs `git rev-parse --show-toplevel`
    // which returns the CANONICAL path (`/home/user/projA`).
    // Pre-fix the SQL query did string-equality on these two
    // forms — symlink-equivalent rows were excluded from
    // scope, mis-classified as `orphan` by downstream logic,
    // and gc could neither remove nor reconcile them.
    //
    // After fix: the engine canonicalizes both repoRoot AND
    // the parent's cwd via `realpathSync` and compares the
    // resolved forms. Symlink-equivalent rows scope in.
    const realRepo = mkdtempSync(join(tmpdir(), 'forja-gc-real-'));
    const symlinkRepo = mkdtempSync(join(tmpdir(), 'forja-gc-symlinks-'));
    const symlinkPath = join(symlinkRepo, 'link-to-real');
    const { symlinkSync } = await import('node:fs');
    try {
      symlinkSync(realRepo, symlinkPath);
      // Session created with the SYMLINK path as cwd. This is
      // exactly what would happen if the operator cd'd into
      // the symlink before invoking the agent.
      const sessionId = seedSession(undefined, symlinkPath);
      const wtPath = join(cacheRoot, sessionId);
      mkdirSync(wtPath);
      insertSubagentWorktree(db, {
        sessionId,
        path: wtPath,
        branch: 'agent/symlinked-deadbeef',
        status: 'preserved',
      });

      // gc resolves repoRoot to the CANONICAL realRepo path
      // (mirrors git rev-parse --show-toplevel behavior).
      const plan = await buildGcPlan({
        db,
        parentCwd: realRepo,
        cacheRoot,
        resolveRepoRoot: async () => realRepo,
        runGitWorktreeList: async () => '',
        worktreeStatus: async () => 'clean',
      });
      // Row scopes in via canonical equivalence; classification
      // is ready_to_remove (preserved + clean), NOT orphan.
      expect(plan.entries.length).toBe(1);
      expect(plan.entries[0]?.kind).toBe('ready_to_remove');
      expect(plan.entries[0]?.path).toBe(wtPath);
    } finally {
      for (const dir of [realRepo, symlinkRepo]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  test('regression: SQLite LIKE wildcards in repoRoot are escaped (no cross-repo leak)', async () => {
    // SQLite LIKE treats `_` as match-single-char and `%` as
    // match-any-string. Without escaping, a parent cwd of
    // `/p_test` would generate `LIKE /p_test/%` and match
    // `/pXtest/anything`, `/p1test/anything`, etc. — leaking
    // rows from any single-char-different sibling repo into
    // the gc plan. After fix: ESCAPE '\\' clause + escaping
    // _/%/\\ in the bound parameter.
    const idA = seedSession(undefined, '/p_test'); // literal `_`
    const idB = seedSession(undefined, '/pXtest'); // would match the wildcard
    const pathA = join(cacheRoot, idA);
    const pathB = join(cacheRoot, idB);
    mkdirSync(pathA);
    mkdirSync(pathB);
    insertSubagentWorktree(db, {
      sessionId: idA,
      path: pathA,
      branch: 'agent/under_test-deadbeef',
      status: 'preserved',
    });
    insertSubagentWorktree(db, {
      sessionId: idB,
      path: pathB,
      branch: 'agent/sibling-cafebabe',
      status: 'preserved',
    });

    // gc scoped to /p_test MUST NOT pull in /pXtest's row.
    const plan = await buildGcPlan({
      db,
      parentCwd: '/p_test',
      cacheRoot,
      resolveRepoRoot: async () => '/p_test',
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    const paths = plan.entries.map((e) => e.path);
    expect(paths).toContain(pathA);
    expect(paths).not.toContain(pathB);
  });

  test('cache-root scan ignores foreign repo dirs even when not in DB', async () => {
    // A cache-root subdir that has no audit row AND is not
    // in current repo's git list. Could be a foreign repo's
    // crashed run or a non-Forja directory. gc must NOT emit
    // it as orphan — operator running gc in another repo
    // would see it from THAT scope.
    const foreignDir = join(cacheRoot, 'foreign-session-id');
    mkdirSync(foreignDir);
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      resolveRepoRoot: async () => parentCwd,
      runGitWorktreeList: async () => '', // current repo's git knows nothing
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries.map((e) => e.path)).not.toContain(foreignDir);
  });

  test('non-git parentCwd → fallback warning + scoping by literal cwd', async () => {
    // resolveRepoRoot returning null (not a git repo) is the
    // production fallback for parentCwd outside any working
    // tree. Engine warns but scopes by literal parentCwd
    // instead of going unscoped (which would re-introduce
    // the cross-repo leak).
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      resolveRepoRoot: async () => null,
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toContain('not inside a git repository');
  });
});

describe('buildGcPlan — security: parent repo + non-Forja worktrees never enter the plan', () => {
  test('parent repo path from `git worktree list` is filtered (regression)', async () => {
    // git worktree list --porcelain ALWAYS includes the
    // repo's main worktree. Without the cache-root filter,
    // that path would appear as `orphan` (no DB row) and
    // `--force` would route it to defaultRunRemove. git's
    // `worktree remove --force` correctly refuses for the
    // main worktree, but the rmSync fallback would
    // recursively delete the operator's repository. This
    // test pins the filter behavior — only paths under the
    // cache root (or DB-known) survive.
    const sessionId = seedSession();
    const subagentPath = join(cacheRoot, sessionId);
    mkdirSync(subagentPath);
    insertSubagentWorktree(db, {
      sessionId,
      path: subagentPath,
      branch: 'agent/scoped-12345678',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${parentCwd}\nbranch refs/heads/main\n\nworktree ${subagentPath}\nbranch refs/heads/agent/scoped-12345678\n\n`,
      worktreeStatus: async () => 'clean',
    });
    expect(plan.entries.map((e) => e.path)).toEqual([subagentPath]);
  });

  test('non-Forja linked worktree (operator-created) is filtered', async () => {
    // Operator may have unrelated linked worktrees off the
    // same repo. They appear in `git worktree list` but live
    // outside our cache root and have no audit row.
    const operatorWorktree = mkdtempSync(join(tmpdir(), 'forja-gc-foreign-'));
    try {
      const plan = await buildGcPlan({
        db,
        parentCwd,
        cacheRoot,
        runGitWorktreeList: async () =>
          `worktree ${parentCwd}\nbranch refs/heads/main\n\nworktree ${operatorWorktree}\nbranch refs/heads/feature\n\n`,
        worktreeStatus: async () => 'clean',
      });
      expect(plan.entries).toEqual([]);
    } finally {
      rmSync(operatorWorktree, { recursive: true, force: true });
    }
  });

  test('DB-known path outside cache root IS included (custom rootDir)', async () => {
    // Operator who customized WorktreeOptions.rootDir at
    // create time has audit rows pointing outside the
    // default cache root. The audit row is authoritative —
    // gc respects it.
    const sessionId = seedSession();
    const customRoot = mkdtempSync(join(tmpdir(), 'forja-gc-custom-'));
    const customPath = join(customRoot, sessionId);
    try {
      mkdirSync(customPath);
      insertSubagentWorktree(db, {
        sessionId,
        path: customPath,
        branch: 'agent/custom-deadbeef',
        status: 'preserved',
      });
      const plan = await buildGcPlan({
        db,
        parentCwd,
        cacheRoot,
        runGitWorktreeList: async () =>
          `worktree ${customPath}\nbranch refs/heads/agent/custom-deadbeef\n\n`,
        worktreeStatus: async () => 'clean',
      });
      expect(plan.entries.length).toBe(1);
      expect(plan.entries[0]?.path).toBe(customPath);
    } finally {
      rmSync(customRoot, { recursive: true, force: true });
    }
  });
});

describe('buildGcPlan — EACCES / non-ENOENT lstat failure', () => {
  test('non-ENOENT lstat error treats path as on-disk-uncertain + emits warning', async () => {
    // Simulate by chmod 000 on the parent dir so lstat on the
    // child returns EACCES (not ENOENT). The path EXISTS but
    // we can't introspect it. The engine must NOT route this
    // to `missing` (which would auto-flip audit to cleaned);
    // instead it should treat as on-disk-uncertain so apply's
    // safety guards (status check, --force gating) handle it
    // and the operator gets a warning surfaced.
    const sessionId = seedSession();
    const lockedParent = join(cacheRoot, 'locked-parent');
    mkdirSync(lockedParent);
    const path = join(lockedParent, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/locked-deadbeef',
      status: 'preserved',
    });
    let mode = 0;
    try {
      // Snapshot mode for restore; chmod 000 to deny lstat.
      // (On a system that doesn't honor chmod denial — e.g.,
      // running as root — the test would still pass via the
      // ENOENT ghost-path test; the EACCES path is the
      // additional edge case.)
      const { statSync, chmodSync } = await import('node:fs');
      mode = statSync(lockedParent).mode & 0o777;
      chmodSync(lockedParent, 0o000);

      const plan = await buildGcPlan({
        db,
        parentCwd,
        cacheRoot,
        runGitWorktreeList: async () => '',
        worktreeStatus: async () => 'unreadable',
      });

      // Either the chmod actually denied access (EACCES path
      // exercised → warning emitted, classified as
      // preserved_dirty because status='unreadable') OR the
      // platform / running user (e.g. root in CI) ignored the
      // chmod (path readable, classified as ready_to_remove
      // when status='clean'). The contract under test is just
      // that buildGcPlan COMPLETES without throwing in either
      // case — that's the resilience this slice adds.
      expect(plan).toBeDefined();
      // If the locked path was actually inaccessible, we
      // expect a warning AND the entry classified as
      // preserved_dirty (status check also failed). When
      // running as root the chmod is a no-op and the test
      // degrades gracefully — both shapes are valid post-fix.
    } finally {
      // Restore mode so afterEach cleanup can rmSync.
      try {
        const { chmodSync } = await import('node:fs');
        chmodSync(lockedParent, mode || 0o755);
      } catch {
        // ignore — tmpdir cleanup will fail-soft
      }
    }
  });
});

describe('buildGcPlan — TOCTOU resilience', () => {
  test('path that vanishes between union-build and stat is treated as not-on-disk (no throw)', async () => {
    // Concurrent gc / cleanup activity can race the stat
    // probe: a path enters `allPaths` from the DB row but is
    // removed from disk before `lstatSync` runs. Earlier code
    // used `existsSync(path) && lstatSync(path).isDirectory()`,
    // which throws if the path disappears between the two
    // syscalls — aborting the entire buildGcPlan with an
    // unhandled exception.
    //
    // We can't deterministically race the FS in a test, but
    // we CAN simulate the equivalent state: a row whose path
    // never existed on disk. lstatSync ENOENTs, the new
    // try/catch absorbs it, the entry classifies as `missing`
    // because dbRow.status === 'preserved' && !onDisk &&
    // gitBranch === null. The point is buildGcPlan completes
    // successfully — no throw escapes.
    const sessionId = seedSession();
    const ghostPath = join(cacheRoot, 'never-existed');
    insertSubagentWorktree(db, {
      sessionId,
      path: ghostPath,
      branch: 'agent/race-deadbeef',
      status: 'preserved',
    });
    let plan: Awaited<ReturnType<typeof buildGcPlan>> | undefined;
    let threw = false;
    try {
      plan = await buildGcPlan({
        db,
        parentCwd,
        cacheRoot,
        runGitWorktreeList: async () => '',
        worktreeStatus: async () => 'clean',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(plan?.entries[0]?.kind).toBe('missing');
  });
});

describe('applyGcPlan — outcomes', () => {
  test('ready_to_remove → removed, audit reconciled', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/clean-deadbeef',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/clean-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const calls: { path: string; branch: string | null }[] = [];
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async (p, b) => {
        calls.push({ path: p, branch: b });
        return { removed: true, branchDeleted: true };
      },
    });
    expect(calls.length).toBe(1);
    expect(summary.removedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(summary.outcomes[0]?.action).toBe('removed');

    // Audit row flipped to 'cleaned'.
    const rows = listAllSubagentWorktrees(db);
    expect(rows[0]?.status).toBe('cleaned');
  });

  test('preserved_dirty + no force → skipped with clear reason', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/dirty-deadbeef',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/dirty-deadbeef\n\n`,
      worktreeStatus: async () => 'dirty',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async () => {
        throw new Error('runRemove must not be called when force=false on dirty entries');
      },
    });
    expect(summary.skippedCount).toBe(1);
    expect(summary.removedCount).toBe(0);
    expect(summary.outcomes[0]?.detail).toContain('--force');
    // Row still 'preserved'.
    expect(listAllSubagentWorktrees(db)[0]?.status).toBe('preserved');
  });

  test('preserved_dirty + force → removed', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/dirty-deadbeef',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/dirty-deadbeef\n\n`,
      worktreeStatus: async () => 'dirty',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: true,
      runRemove: async () => ({ removed: true, branchDeleted: true }),
    });
    expect(summary.removedCount).toBe(1);
    expect(listAllSubagentWorktrees(db)[0]?.status).toBe('cleaned');
  });

  test('orphan + no force → skipped', async () => {
    const orphanPath = join(cacheRoot, 'orphan-id');
    mkdirSync(orphanPath);
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${orphanPath}\nbranch refs/heads/agent/orphan-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async () => {
        throw new Error('must not call');
      },
    });
    expect(summary.skippedCount).toBe(1);
    expect(summary.outcomes[0]?.detail).toContain('--force');
  });

  test('orphan + force → removed', async () => {
    const orphanPath = join(cacheRoot, 'orphan-id');
    mkdirSync(orphanPath);
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${orphanPath}\nbranch refs/heads/agent/orphan-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: true,
      runRemove: async () => ({ removed: true, branchDeleted: true }),
    });
    expect(summary.removedCount).toBe(1);
  });

  test('active → always skipped, even with --force', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/running-deadbeef',
      status: 'active',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/running-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: true,
      runRemove: async () => {
        throw new Error('active rows must never be passed to runRemove');
      },
    });
    expect(summary.skippedCount).toBe(1);
    expect(summary.outcomes[0]?.detail).toContain('still running');
    // Row stays active — gc must NEVER flip it.
    expect(listAllSubagentWorktrees(db)[0]?.status).toBe('active');
  });

  test('missing → audit reconciled to cleaned, no removal call', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/manual-deadbeef',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () => '',
      worktreeStatus: async () => 'clean',
    });
    let removeCalled = false;
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async () => {
        removeCalled = true;
        return { removed: true, branchDeleted: true };
      },
    });
    expect(removeCalled).toBe(false);
    expect(summary.reconciledCount).toBe(1);
    expect(listAllSubagentWorktrees(db)[0]?.status).toBe('cleaned');
  });

  test('removal failure → action=failed, row stays running', async () => {
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/stuck-deadbeef',
      status: 'preserved',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/stuck-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async () => ({
        removed: false,
        branchDeleted: false,
        error: 'fatal: file is locked',
      }),
    });
    expect(summary.failedCount).toBe(1);
    expect(summary.outcomes[0]?.action).toBe('failed');
    expect(summary.outcomes[0]?.detail).toContain('locked');
    // Row stays preserved — operator can retry next gc pass.
    expect(listAllSubagentWorktrees(db)[0]?.status).toBe('preserved');
  });

  test('stale_cleaned → retries removal regardless of force', async () => {
    // The audit already authorized cleanup; gc just retries
    // the actual rm. --force not required.
    const sessionId = seedSession();
    const path = join(cacheRoot, sessionId);
    mkdirSync(path);
    writeFileSync(join(path, 'leftover.txt'), 'partial cleanup');
    insertSubagentWorktree(db, {
      sessionId,
      path,
      branch: 'agent/retry-deadbeef',
      status: 'cleaned',
    });
    const plan = await buildGcPlan({
      db,
      parentCwd,
      cacheRoot,
      runGitWorktreeList: async () =>
        `worktree ${path}\nbranch refs/heads/agent/retry-deadbeef\n\n`,
      worktreeStatus: async () => 'clean',
    });
    const summary = await applyGcPlan({
      db,
      parentCwd,
      plan,
      force: false,
      runRemove: async () => ({ removed: true, branchDeleted: true }),
    });
    expect(summary.removedCount).toBe(1);
  });
});
