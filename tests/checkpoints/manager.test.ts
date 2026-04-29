import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRef, sessionRef } from '../../src/checkpoints/git.ts';
import { createCheckpointManager } from '../../src/checkpoints/manager.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { insertCheckpoint, listCheckpointsBySession } from '../../src/storage/repos/checkpoints.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: {
      LC_ALL: 'C',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return stdout;
};

const initRepoWithSeed = async (cwd: string): Promise<void> => {
  await runGit(cwd, ['init', '-b', 'main']);
  await writeFile(join(cwd, 'seed.txt'), 'seed\n');
  await runGit(cwd, ['add', '.']);
  await runGit(cwd, ['commit', '-m', 'seed']);
};

let repo: string;
let db: DB;
let sessionId: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'forja-mgr-'));
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: repo }).id;
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('CheckpointManager — unavailable mode', () => {
  test('snapshot returns nulls without touching the DB', async () => {
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: false });
    const result = await mgr.snapshot({ stepId: 'm1', hadBash: false });
    expect(result.checkpointId).toBeNull();
    expect(result.gitRef).toBeNull();
    expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
  });

  test('restore throws with a clear reason', async () => {
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: false });
    expect(mgr.restore('any')).rejects.toThrow(/not available/);
  });

  test('diff throws with a clear reason', async () => {
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: false });
    expect(mgr.diff('any')).rejects.toThrow(/not available/);
  });

  test('list still works (DB-only path)', async () => {
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: false });
    insertCheckpoint(db, { sessionId, stepId: 'm', gitRef: 'abc', hadBash: false });
    const list = await mgr.list(sessionId);
    expect(list).toHaveLength(1);
  });

  test('purge with sessionId drops DB rows even without git', async () => {
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: false });
    insertCheckpoint(db, { sessionId, stepId: 'm1', gitRef: 'a', hadBash: false });
    insertCheckpoint(db, { sessionId, stepId: 'm2', gitRef: 'b', hadBash: false });
    const deleted = await mgr.purge({ sessionId });
    expect(deleted).toBe(2);
  });
});

describe('CheckpointManager — available mode', () => {
  test('snapshot creates a row, updates the ref, returns ids', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'one\n');
    const result = await mgr.snapshot({ stepId: 'msg-1', hadBash: false });
    expect(result.checkpointId).toBeString();
    expect(result.gitRef).toBeString();

    const rows = listCheckpointsBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gitRef).toBe(result.gitRef as string);
    expect(rows[0]?.hadBash).toBe(false);

    const refSha = await resolveRef(repo, sessionRef(sessionId));
    expect(refSha).toBe(result.gitRef as string);
  });

  test('snapshot returns nulls when the working tree is identical to the prior snapshot', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'state\n');
    const first = await mgr.snapshot({ stepId: 'm1', hadBash: false });
    expect(first.checkpointId).not.toBeNull();
    const second = await mgr.snapshot({ stepId: 'm2', hadBash: false });
    expect(second.checkpointId).toBeNull();
    expect(listCheckpointsBySession(db, sessionId)).toHaveLength(1);
  });

  test('hadBash flag persists', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'a');
    await mgr.snapshot({ stepId: 'm', hadBash: true });
    const rows = listCheckpointsBySession(db, sessionId);
    expect(rows[0]?.hadBash).toBe(true);
  });

  test('restore round-trips working tree state', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'v1\n');
    const ckpt = await mgr.snapshot({ stepId: 'm', hadBash: false });
    expect(ckpt.checkpointId).not.toBeNull();
    await writeFile(join(repo, 'a.txt'), 'v2\n');

    const result = await mgr.restore(ckpt.checkpointId as string);
    expect(result.stashed).toBe(true);
    const text = await Bun.file(join(repo, 'a.txt')).text();
    expect(text).toBe('v1\n');
  });

  test('restore throws on unknown id', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    expect(mgr.restore('nope')).rejects.toThrow(/not found/);
  });

  test('diff returns content reflecting the divergence', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'd.txt'), 'state-1\n');
    const ckpt = await mgr.snapshot({ stepId: 'm', hadBash: false });
    await writeFile(join(repo, 'd.txt'), 'state-2\n');
    const out = await mgr.diff(ckpt.checkpointId as string);
    expect(out).toContain('state-1');
    expect(out).toContain('state-2');
  });

  test('purge by session removes row and ref', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'a');
    await mgr.snapshot({ stepId: 'm1', hadBash: false });
    await writeFile(join(repo, 'a.txt'), 'b');
    await mgr.snapshot({ stepId: 'm2', hadBash: false });

    const deleted = await mgr.purge({ sessionId });
    expect(deleted).toBe(2);
    expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
    expect(await resolveRef(repo, sessionRef(sessionId))).toBeNull();
  });

  test('purge by age does NOT touch rows from sessions in other cwds', async () => {
    // Lazy retention runs at session_start of every agent run, with
    // manager bound to the current cwd. The age-based row sweep must
    // be cwd-scoped — otherwise running the agent in /repo/A would
    // periodically wipe /repo/B's audit history once those rows
    // crossed the cutoff, even though /repo/B's git refs (and the
    // ability to restore from them) are intact in /repo/B's git
    // store. Result without the scope: CLI in /repo/B reports "no
    // checkpoints" for a session that still has working refs.
    await initRepoWithSeed(repo);
    // Seed a session that "lives" in a foreign cwd.
    const foreignCwd = await mkdtemp(join(tmpdir(), 'forja-mgr-foreign-'));
    try {
      const foreignSession = createSession(db, { model: 'm', cwd: foreignCwd }).id;
      // Aged-out row tied to the foreign session.
      insertCheckpoint(db, {
        sessionId: foreignSession,
        stepId: 'foreign-step',
        gitRef: 'aaa',
        hadBash: false,
        createdAt: 0,
      });
      // Aged-out row in the local session.
      insertCheckpoint(db, {
        sessionId,
        stepId: 'local-step',
        gitRef: 'bbb',
        hadBash: false,
        createdAt: 0,
      });

      const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
      await mgr.purge({ olderThanDays: 1 });

      // Local session's aged row is gone.
      expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
      // Foreign session's row stays — its cwd doesn't match the
      // manager's cwd, so retention skips it.
      expect(listCheckpointsBySession(db, foreignSession)).toHaveLength(1);
    } finally {
      await rm(foreignCwd, { recursive: true, force: true });
    }
  });

  test('purge by age drops aged-out rows and refs without surviving rows', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });

    // Two old rows manually inserted with backdated created_at; the
    // matching git refs come from a real snapshot so the cleanup loop
    // has something to delete.
    await writeFile(join(repo, 'a.txt'), 'a');
    const real = await mgr.snapshot({ stepId: 'm', hadBash: false });
    // Backdate the row to before the cutoff.
    db.query('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(0, real.checkpointId);

    const deleted = await mgr.purge({ olderThanDays: 1 });
    expect(deleted).toBe(1);
    expect(await resolveRef(repo, sessionRef(sessionId))).toBeNull();
  });

  test('purge sweeps orphan refs whose DB rows are gone', async () => {
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'a');
    await mgr.snapshot({ stepId: 'm', hadBash: false });
    // Wipe the DB rows directly (simulating a manual DB reset). The
    // ref is now orphaned.
    db.query('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
    expect(await resolveRef(repo, sessionRef(sessionId))).not.toBeNull();

    await mgr.purge({ olderThanDays: 999 });
    expect(await resolveRef(repo, sessionRef(sessionId))).toBeNull();
  });

  test('purge drops aged-out restore-saved refs by parsed timestamp', async () => {
    // restore-saved refs are created by restore() on unborn HEAD when
    // working tree is dirty. They have no DB row and no session
    // linkage — only the timestamp baked into the ref name decides
    // retention. The sweep walks the namespace and deletes refs older
    // than the cutoff.
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });

    // Seed one old (60s ago) and one fresh ref. The shas can be any
    // reachable commit — the seed commit is convenient.
    const head = (await runGit(repo, ['rev-parse', 'HEAD'])).trim();
    const oldTs = Date.now() - 60_000;
    const oldRef = `refs/agent/restore-saved/${oldTs}-aaaaaaaa`;
    const freshRef = `refs/agent/restore-saved/${Date.now()}-bbbbbbbb`;
    await runGit(repo, ['update-ref', oldRef, head]);
    await runGit(repo, ['update-ref', freshRef, head]);

    // 30s cutoff drops the old ref but spares the fresh one.
    // olderThanDays accepts fractional days via the float math, so
    // 30 / 86400 = ~30s.
    await mgr.purge({ olderThanDays: 30 / 86400 });

    expect(await resolveRef(repo, oldRef)).toBeNull();
    expect(await resolveRef(repo, freshRef)).not.toBeNull();
  });

  test('purge ignores restore-saved refs with unparseable timestamps', async () => {
    // Conservative path: a hand-created ref or one from a future
    // format that doesn't start with `<digits>-` is left alone. The
    // sweep doesn't guess the age.
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    const head = (await runGit(repo, ['rev-parse', 'HEAD'])).trim();
    const weirdRef = 'refs/agent/restore-saved/manual-tag';
    await runGit(repo, ['update-ref', weirdRef, head]);

    await mgr.purge({ olderThanDays: 0.0000001 });

    expect(await resolveRef(repo, weirdRef)).not.toBeNull();
  });
});
