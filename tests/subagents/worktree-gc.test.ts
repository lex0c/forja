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

const seedSession = (id?: string): string => {
  const session = createSession(db, { model: 'mock/m', cwd: '/p' });
  // Force a known id when needed for cross-fixture references.
  if (id !== undefined) {
    db.query('UPDATE sessions SET id = ? WHERE id = ?').run(id, session.id);
    return id;
  }
  return session.id;
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
