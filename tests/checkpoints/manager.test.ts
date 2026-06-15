import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    // Lazy retention runs at session_start of every forja run, with
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

  test('purge severs aged ancestry so git gc can reclaim aged commits', async () => {
    // The chain shape (each new ckpt parents the prior) means a
    // simple ref re-point doesn't sever reachability — git treats
    // every parent of a referenced commit as alive. Aged commits
    // would survive every gc unless retention rewrites the surviving
    // chain to break the link.
    //
    // Setup: 4 snapshots, each with a different file content. Then
    // backdate the oldest two so they age out under olderThanDays=1.
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });

    await writeFile(join(repo, 'state.txt'), 'A\n');
    const a = await mgr.snapshot({ stepId: 'a', hadBash: false });
    await writeFile(join(repo, 'state.txt'), 'B\n');
    const b = await mgr.snapshot({ stepId: 'b', hadBash: false });
    await writeFile(join(repo, 'state.txt'), 'C\n');
    const c = await mgr.snapshot({ stepId: 'c', hadBash: false });
    await writeFile(join(repo, 'state.txt'), 'D\n');
    const d = await mgr.snapshot({ stepId: 'd', hadBash: false });

    // Original shas — these are what we expect to become unreachable
    // once retention rewrites the chain. The aged ones (A, B) AND
    // the ORIGINAL surviving ones (C, D) all become unreachable
    // because survivors get rewritten to fresh commits without aged
    // ancestors.
    const shaA = a.gitRef as string;
    const shaB = b.gitRef as string;
    const shaCOriginal = c.gitRef as string;
    const shaDOriginal = d.gitRef as string;

    db.query('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(0, a.checkpointId);
    db.query('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(0, b.checkpointId);

    await mgr.purge({ olderThanDays: 1 });

    // DB rows for A, B gone. C, D survive but with REWRITTEN git_ref.
    const survivors = listCheckpointsBySession(db, sessionId);
    expect(survivors).toHaveLength(2);
    const survivorShas = survivors.map((r) => r.gitRef);
    expect(survivorShas).not.toContain(shaCOriginal);
    expect(survivorShas).not.toContain(shaDOriginal);

    // Reachability check: every commit reachable from any ref in
    // the repo. Aged shas AND original surviving shas must all be
    // absent — the chain is severed.
    const reachable = (await runGit(repo, ['rev-list', '--all'])).trim().split('\n');
    expect(reachable).not.toContain(shaA);
    expect(reachable).not.toContain(shaB);
    expect(reachable).not.toContain(shaCOriginal);
    expect(reachable).not.toContain(shaDOriginal);

    // The rebuilt survivor head is at the session ref.
    const refSha = await resolveRef(repo, sessionRef(sessionId));
    expect(refSha).not.toBeNull();
    expect(reachable).toContain(refSha as string);

    // Working-tree contents at the rebuilt latest ckpt's tree match
    // what was captured at the time of D (state.txt = "D"). Proves
    // the rewrite preserved the tree, not just the lineage.
    const restoreResult = await mgr.restore(survivors[0]?.id as string);
    expect(restoreResult).toBeDefined();
    expect(await Bun.file(join(repo, 'state.txt')).text()).toBe('D\n');
  });

  test('rewrite failure leaves aged rows intact for the next purge to retry', async () => {
    // Bug: aged rows used to be deleted BEFORE the rewrite ran. If
    // the rewrite failed (transient git error, e.g., a survivor's
    // commit object missing), aged rows were already gone and no
    // future purge could re-enter the rewrite branch — the trigger
    // (aged rows for the session) had been removed. Aged commits
    // stayed reachable through the un-severed survivor chain
    // forever. Fix: defer aged-row deletion until git rewrite
    // succeeds; bundle deletion + survivor updates in one
    // transaction.
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });

    await writeFile(join(repo, 's.txt'), 'A');
    const a = await mgr.snapshot({ stepId: 'a', hadBash: false });
    await writeFile(join(repo, 's.txt'), 'B');
    const b = await mgr.snapshot({ stepId: 'b', hadBash: false });
    await writeFile(join(repo, 's.txt'), 'C');
    const c = await mgr.snapshot({ stepId: 'c', hadBash: false });

    // Age out a + b.
    db.query('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(0, a.checkpointId);
    db.query('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(0, b.checkpointId);

    // Poison c's git_ref so getCommitTree throws during rewrite.
    // The survivor chain has just c, so this fails the loop on its
    // first iteration — aged rows must NOT be deleted in that case.
    const realC = c.gitRef as string;
    db.query('UPDATE checkpoints SET git_ref = ? WHERE id = ?').run(
      '0000000000000000000000000000000000000000',
      c.checkpointId,
    );

    await mgr.purge({ olderThanDays: 1 });

    // Aged rows must STILL be in the DB after a failed rewrite.
    // Pre-fix, they were deleted unconditionally before the rewrite.
    const survivors = listCheckpointsBySession(db, sessionId);
    const ids = survivors.map((s) => s.id).sort();
    expect(ids).toContain(a.checkpointId as string);
    expect(ids).toContain(b.checkpointId as string);
    expect(ids).toContain(c.checkpointId as string);

    // Recovery: restore c's real git_ref and run purge again. The
    // rewrite should now succeed, aged rows finally drop.
    db.query('UPDATE checkpoints SET git_ref = ? WHERE id = ?').run(realC, c.checkpointId);
    await mgr.purge({ olderThanDays: 1 });

    const after = listCheckpointsBySession(db, sessionId).map((s) => s.id);
    expect(after).not.toContain(a.checkpointId as string);
    expect(after).not.toContain(b.checkpointId as string);
    expect(after).toContain(c.checkpointId as string);
  });

  test('purge self-heals session ref drift from prior failed rewrite', async () => {
    // Reproduce the post-bug end state: setSessionRef failed during
    // a previous retention rewrite, so the DB rows were updated to
    // new git_refs but the session ref is still pointing at an
    // older commit on the original chain. Aged rows that triggered
    // the rewrite were already deleted, so no future purge would
    // re-fire the rewrite branch — the orphan-ref sweep also skips
    // because the session still has rows. Without self-heal, the
    // divergence persists forever and aged commits stay reachable
    // via the old chain.
    //
    // Simulation: take two snapshots (b is the latest, ref points
    // at b). Manually rewind the ref to a's sha. Run purge with no
    // aged rows. Expected: self-heal detects ref != latest survivor
    // and moves the ref to b's sha.
    await initRepoWithSeed(repo);
    const mgr = createCheckpointManager({ db, cwd: repo, sessionId, available: true });
    await writeFile(join(repo, 'a.txt'), 'A');
    const a = await mgr.snapshot({ stepId: 'a', hadBash: false });
    await writeFile(join(repo, 'a.txt'), 'B');
    const b = await mgr.snapshot({ stepId: 'b', hadBash: false });
    expect(a.gitRef).not.toBeNull();
    expect(b.gitRef).not.toBeNull();
    // Sanity: ref starts at b.
    expect(await resolveRef(repo, sessionRef(sessionId))).toBe(b.gitRef as string);

    // Simulate the failed-rewrite end state: ref at a (older),
    // DB still has b as the latest survivor.
    await runGit(repo, ['update-ref', sessionRef(sessionId), a.gitRef as string]);
    expect(await resolveRef(repo, sessionRef(sessionId))).toBe(a.gitRef as string);

    // Run a purge with retention=999 days — no rows age out, so the
    // rewrite branch doesn't run. The self-heal sweep is the ONLY
    // path that can fix the drift here.
    await mgr.purge({ olderThanDays: 999 });

    expect(await resolveRef(repo, sessionRef(sessionId))).toBe(b.gitRef as string);
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

describe('CheckpointManager — worktree-root anchoring (CHECKPOINTS §2.6)', () => {
  // Edge #1: snapshot was cwd-scoped (`add -A .`) while restore is
  // worktree-wide (`read-tree --reset -u`). Running from a subdir made
  // them disagree — paths outside the subdir entered the checkpoint at
  // HEAD, not their real state. Anchoring git ops at gitRoot makes a
  // subdir run indistinguishable from a repo-root run.
  test('snapshot from a subdir captures a change made outside the subdir', async () => {
    await initRepoWithSeed(repo);
    const sub = join(repo, 'sub');
    await mkdir(sub, { recursive: true });
    // Manager mimics the agent invoked from repo/sub: cwd is the subdir,
    // gitRoot is the worktree root (what detectCheckpointSupport
    // resolves in production).
    const mgr = createCheckpointManager({
      db,
      cwd: sub,
      sessionId,
      gitRoot: repo,
      available: true,
    });
    await writeFile(join(repo, 'root.txt'), 'pre\n');
    await writeFile(join(sub, 'inner.txt'), 'inner-pre\n');
    const ckpt = await mgr.snapshot({ stepId: 'm', hadBash: false });
    expect(ckpt.checkpointId).not.toBeNull();
    // Both the out-of-subdir file AND the in-subdir file land in the
    // checkpoint tree — worktree-wide capture.
    const ls = await runGit(repo, ['ls-tree', '-r', '--name-only', ckpt.gitRef as string]);
    expect(ls).toContain('root.txt');
    expect(ls).toContain('sub/inner.txt');
  });

  test('restore from a subdir reverts a change outside the subdir', async () => {
    await initRepoWithSeed(repo);
    const sub = join(repo, 'sub');
    await mkdir(sub, { recursive: true });
    const mgr = createCheckpointManager({
      db,
      cwd: sub,
      sessionId,
      gitRoot: repo,
      available: true,
    });
    await writeFile(join(repo, 'root.txt'), 'pre\n');
    const ckpt = await mgr.snapshot({ stepId: 'm', hadBash: false });
    expect(ckpt.checkpointId).not.toBeNull();
    // A later edit to a file OUTSIDE the invocation subdir.
    await writeFile(join(repo, 'root.txt'), 'post\n');
    await mgr.restore(ckpt.checkpointId as string);
    // Pre-fix this stayed 'post' (the cwd-scoped snapshot never captured
    // root.txt at 'pre', so there was nothing to revert it to).
    expect(await Bun.file(join(repo, 'root.txt')).text()).toBe('pre\n');
  });
});
