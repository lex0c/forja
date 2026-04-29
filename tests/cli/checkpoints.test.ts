import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpointManager, detectCheckpointSupport } from '../../src/checkpoints/index.ts';
import { runCheckpointsCli } from '../../src/cli/checkpoints.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { insertCheckpoint, listCheckpointsBySession } from '../../src/storage/repos/checkpoints.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const runGit = async (cwd: string, args: string[]): Promise<void> => {
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
  await proc.exited;
};

const initRepoWithSeed = async (cwd: string): Promise<void> => {
  await runGit(cwd, ['init', '-b', 'main']);
  await writeFile(join(cwd, 'seed.txt'), 'seed\n');
  await runGit(cwd, ['add', '.']);
  await runGit(cwd, ['commit', '-m', 'seed']);
};

interface Capture {
  out: string[];
  err: string[];
  pushOut: (s: string) => void;
  pushErr: (s: string) => void;
}

const capture = (): Capture => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    pushOut: (s: string) => out.push(s),
    pushErr: (s: string) => err.push(s),
  };
};

let repo: string;
let dbPath: string;
let db: DB;
let sessionId: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'forja-cli-ckpt-'));
  dbPath = join(repo, '.forja.db');
  db = openDb(dbPath);
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: repo }).id;
});

afterEach(async () => {
  db.close();
  await rm(repo, { recursive: true, force: true });
});

// Helper that builds a checkpoint via the production manager (so we
// have a real ref + a real DB row to operate on in tests).
const createRealCheckpoint = async (hadBash: boolean, fileContent: string): Promise<string> => {
  await writeFile(join(repo, 'a.txt'), fileContent);
  const support = await detectCheckpointSupport(repo);
  const mgr = createCheckpointManager({
    db,
    cwd: repo,
    sessionId,
    available: support.available,
  });
  const result = await mgr.snapshot({ stepId: 'msg-x', hadBash });
  if (result.checkpointId === null) throw new Error('snapshot did not produce a checkpoint');
  return result.checkpointId;
};

describe('runCheckpointsCli', () => {
  describe('list', () => {
    test('renders empty notice when no checkpoints', async () => {
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'list',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      expect(c.out.join('')).toContain('no checkpoints');
    });

    test('table form shows ckpts newest first', async () => {
      // No git needed for list — DB-only path.
      insertCheckpoint(db, {
        sessionId,
        stepId: 's1',
        gitRef: 'abc',
        hadBash: false,
        createdAt: 1_000,
      });
      insertCheckpoint(db, {
        sessionId,
        stepId: 's2',
        gitRef: 'def',
        hadBash: true,
        createdAt: 2_000,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'list',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      const out = c.out.join('');
      // Header
      expect(out).toContain('CREATED');
      // Newest first: 'def' before 'abc'
      const defIdx = out.indexOf('def');
      const abcIdx = out.indexOf('abc');
      expect(defIdx).toBeGreaterThan(-1);
      expect(abcIdx).toBeGreaterThan(-1);
      expect(defIdx).toBeLessThan(abcIdx);
      expect(out).toContain('bash');
    });

    test('--json emits NDJSON, one per line', async () => {
      insertCheckpoint(db, {
        sessionId,
        stepId: 's1',
        gitRef: 'abc',
        hadBash: true,
        createdAt: 1_000,
      });
      const c = capture();
      await runCheckpointsCli({
        verb: 'list',
        positionals: [sessionId],
        json: true,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      const lines = c.out
        .join('')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const obj = JSON.parse(lines[0] as string);
      expect(obj.git_ref).toBe('abc');
      expect(obj.had_bash).toBe(true);
    });

    test('unknown session id returns 1 with clear error', async () => {
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'list',
        positionals: ['no-such-session'],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain('not found');
    });

    test('missing positional returns 1', async () => {
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'list',
        positionals: [],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain('requires a session');
    });
  });

  describe('diff', () => {
    test('produces non-empty diff vs working tree divergence', async () => {
      await initRepoWithSeed(repo);
      const ckptId = await createRealCheckpoint(false, 'state-1\n');
      await writeFile(join(repo, 'a.txt'), 'state-2\n');
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'diff',
        positionals: [sessionId, ckptId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      const out = c.out.join('');
      expect(out).toContain('state-1');
      expect(out).toContain('state-2');
    });

    test('non-git cwd refuses with clear message', async () => {
      // No initRepoWithSeed: cwd is a plain temp dir.
      insertCheckpoint(db, {
        sessionId,
        stepId: 's1',
        gitRef: 'abc',
        hadBash: false,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'diff',
        positionals: [sessionId, 'whatever'],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain('not available');
    });
  });

  describe('restore / undo', () => {
    test('undo restores latest checkpoint and reports no stash on clean tree', async () => {
      await initRepoWithSeed(repo);
      // Snapshot 1 captures a.txt=v1.
      await createRealCheckpoint(false, 'v1\n');
      // Commit the v1 state so the working tree is clean — undo's
      // stash branch must NOT trigger when there's nothing to save.
      await runGit(repo, ['add', '.']);
      await runGit(repo, ['commit', '-m', 'user-commit-v1']);
      // Mutate to v2 — this is the state we're going to revert.
      await writeFile(join(repo, 'a.txt'), 'v2\n');

      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'undo',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      // Working tree before undo was v2 (uncommitted). The latest ckpt
      // captured v1. So the v2 change is the one we reverted.
      const restored = await Bun.file(join(repo, 'a.txt')).text();
      expect(restored).toBe('v1\n');
      // The v2 modification was uncommitted ⇒ stashed.
      const errStr = c.err.join('');
      expect(errStr).toContain('stash@{0}');
    });

    test('undo on had_bash checkpoint refuses without --yes', async () => {
      await initRepoWithSeed(repo);
      await createRealCheckpoint(true, 'state\n');
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'undo',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      const errStr = c.err.join('');
      expect(errStr).toContain('WARNING');
      expect(errStr).toContain('bash');
      expect(errStr).toContain('--yes');
    });

    test('undo on had_bash checkpoint proceeds with --yes', async () => {
      await initRepoWithSeed(repo);
      const ckptId = await createRealCheckpoint(true, 'state\n');
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'undo',
        positionals: [sessionId],
        json: false,
        yes: true,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      // Restored message goes to stderr (operational chatter, not
      // the data product).
      const errStr = c.err.join('');
      expect(errStr).toContain(`Restored to checkpoint ${ckptId}`);
    });

    test('undo on unborn HEAD with dirty working tree uses agent-ref + read-tree hint', async () => {
      // No initial commit — git stash isn't available. The CLI must
      // render the read-tree-based recovery hint instead of the
      // stash-pop one (which would fail with "no initial commit").
      await runGit(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'shared.txt'), 'v1\n');
      const ckptId = await createRealCheckpoint(false, 'v1\n');
      // Mutate the same file to v2; restore should preserve v2 in
      // the agent-ref before overwriting with v1.
      await writeFile(join(repo, 'shared.txt'), 'v2\n');

      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'restore',
        positionals: [sessionId, ckptId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      const errStr = c.err.join('');
      expect(errStr).toContain('refs/agent/restore-saved/');
      expect(errStr).toContain('git read-tree --reset -u');
      // Must NOT instruct the user to run `git stash pop` — that
      // command would fail on unborn HEAD. The phrase may still
      // appear as "git stash pop would fail" explaining WHY we
      // didn't use it; check for the actionable form specifically.
      expect(errStr).not.toContain('Run `git stash pop`');
      // Working tree restored.
      expect(await Bun.file(join(repo, 'shared.txt')).text()).toBe('v1\n');
    });

    test('restore with explicit ckpt id and dirty working tree stashes', async () => {
      await initRepoWithSeed(repo);
      const ckptId = await createRealCheckpoint(false, 'state-1\n');
      // Dirty the working tree.
      await writeFile(join(repo, 'a.txt'), 'state-2\n');
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'restore',
        positionals: [sessionId, ckptId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      const errStr = c.err.join('');
      expect(errStr).toContain('stash@{0}');
      expect(errStr).toContain('git stash pop');
    });

    test('restore on a GC-collected commit emits a friendly purge hint', async () => {
      await initRepoWithSeed(repo);
      // Insert a row that points at a sha that does not exist in
      // git. The CLI's restore path should detect this through the
      // "bad object" probe and rewrite to the purge hint instead of
      // surfacing raw git output.
      const phantomCkpt = insertCheckpoint(db, {
        sessionId,
        stepId: 'msg-x',
        gitRef: '0000000000000000000000000000000000000000',
        hadBash: false,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'restore',
        positionals: [sessionId, phantomCkpt.id],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      const errStr = c.err.join('');
      expect(errStr).toContain('garbage-collected');
      expect(errStr).toContain(`--checkpoints purge ${sessionId}`);
    });

    test('restore rejects ckpt id from a different session', async () => {
      await initRepoWithSeed(repo);
      const otherSessionId = createSession(db, { model: 'm', cwd: repo }).id;
      // Create a ckpt that belongs to otherSessionId — by inserting
      // directly so we control the session.
      const row = insertCheckpoint(db, {
        sessionId: otherSessionId,
        stepId: 's',
        gitRef: 'abc',
        hadBash: false,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'restore',
        positionals: [sessionId, row.id],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain('not found in session');
    });

    test('undo on session with no checkpoints reports clearly', async () => {
      await initRepoWithSeed(repo);
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'undo',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain('no checkpoints');
    });
  });

  describe('purge', () => {
    test('removes all rows of a session', async () => {
      insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
      insertCheckpoint(db, { sessionId, stepId: 's2', gitRef: 'b', hadBash: false });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'purge',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(0);
      expect(c.out.join('')).toContain('purged 2');
      expect(listCheckpointsBySession(db, sessionId)).toHaveLength(0);
    });

    test('--json emits structured result', async () => {
      insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
      const c = capture();
      await runCheckpointsCli({
        verb: 'purge',
        positionals: [sessionId],
        json: true,
        yes: false,
        cwd: repo,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      const obj = JSON.parse(c.out.join('').trim());
      expect(obj).toEqual({ ok: true, deleted: 1 });
    });
  });

  describe('cwd mismatch refusal', () => {
    // Session was created with cwd=repo. If the user cds to a
    // different directory and invokes a checkpoint verb against the
    // same session id, the handler must refuse — running git ops in
    // the wrong repo can mutate or destroy state for an unrelated
    // project (especially --undo, which calls read-tree --reset -u
    // on the active repo's working tree).
    let otherCwd: string;
    beforeEach(async () => {
      otherCwd = await mkdtemp(join(tmpdir(), 'forja-cli-ckpt-other-'));
    });
    afterEach(async () => {
      await rm(otherCwd, { recursive: true, force: true });
    });

    test('--undo refuses when current cwd differs from session cwd', async () => {
      insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'abc', hadBash: false });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'undo',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: otherCwd,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      const errStr = c.err.join('');
      expect(errStr).toContain(repo);
      expect(errStr).toContain(otherCwd);
      expect(errStr).toMatch(/cwd|directory/);
    });

    test('--checkpoints restore refuses on cwd mismatch', async () => {
      const ckpt = insertCheckpoint(db, {
        sessionId,
        stepId: 's1',
        gitRef: 'abc',
        hadBash: false,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'restore',
        positionals: [sessionId, ckpt.id],
        json: false,
        yes: true,
        cwd: otherCwd,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain(repo);
    });

    test('--checkpoints diff refuses on cwd mismatch', async () => {
      const ckpt = insertCheckpoint(db, {
        sessionId,
        stepId: 's1',
        gitRef: 'abc',
        hadBash: false,
      });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'diff',
        positionals: [sessionId, ckpt.id],
        json: false,
        yes: false,
        cwd: otherCwd,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain(repo);
    });

    test('--checkpoints purge refuses on cwd mismatch (does NOT drop rows)', async () => {
      insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
      insertCheckpoint(db, { sessionId, stepId: 's2', gitRef: 'b', hadBash: false });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'purge',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: otherCwd,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      // Critical: rows must NOT be deleted when the wrong cwd was
      // detected. The previous shape called the manager's purge
      // before validating cwd, leaving DB rows gone with refs intact.
      expect(listCheckpointsBySession(db, sessionId)).toHaveLength(2);
    });

    test('--checkpoints list refuses on cwd mismatch', async () => {
      // List is read-only but a cross-cwd listing is misleading
      // (the user couldn't act on the entries from this cwd anyway).
      // Refuse for consistency with the destructive verbs.
      insertCheckpoint(db, { sessionId, stepId: 's1', gitRef: 'a', hadBash: false });
      const c = capture();
      const code = await runCheckpointsCli({
        verb: 'list',
        positionals: [sessionId],
        json: false,
        yes: false,
        cwd: otherCwd,
        dbOverride: db,
        out: c.pushOut,
        err: c.pushErr,
      });
      expect(code).toBe(1);
      expect(c.err.join('')).toContain(repo);
    });
  });
});
