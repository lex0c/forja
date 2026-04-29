import {
  type Checkpoint,
  type DB,
  deleteCheckpoint,
  deleteCheckpointsBySession,
  getCheckpoint,
  insertCheckpoint,
  listCheckpointsBySession,
  listCheckpointsOlderThan,
} from '../storage/index.ts';
import {
  deleteSessionRef,
  diff as gitDiff,
  restore as gitRestore,
  snapshot as gitSnapshot,
  listSessionRefs,
  resolveRef,
  sessionRef,
  setSessionRef,
} from './git.ts';

// Default retention for orphaned / aged-out checkpoint refs. Per
// CHECKPOINTS §2.5 the default is 30 days, configurable via
// `agent.checkpoints.retentionDays`.
export const DEFAULT_RETENTION_DAYS = 30;

export interface SnapshotOutcome {
  // Public checkpoint id when one was created, null when the working
  // tree had no diff vs the prior snapshot (no-op step). The harness
  // emits a checkpoint_created event only on non-null outcomes.
  checkpointId: string | null;
  // Commit SHA on a successful create. Mirrors checkpointId being non-
  // null. Surfaced for the `checkpoint_created` event so renderers
  // and audit logs can show it without re-querying the DB.
  gitRef: string | null;
}

export interface SnapshotInput {
  // Step id (= assistant message id) that triggered the snapshot.
  // Stored on the row so `--checkpoints list` can correlate to the
  // step that produced it.
  stepId: string;
  // True when the step that triggered this snapshot ran the bash tool
  // (or any tool that may have side-effected outside the cwd). Drives
  // the warning prompt in `--undo`.
  hadBash: boolean;
  // Optional step number, used in the commit message for human grep.
  stepN?: number;
}

export interface PurgeOptions {
  // Restrict the purge to a single session. When set, the manager
  // drops every checkpoint row for that session AND deletes the
  // session's git ref. Used by `--checkpoints purge --session=<id>`.
  sessionId?: string;
  // Drop refs and rows whose row is older than this. Default
  // DEFAULT_RETENTION_DAYS. Lazy-cleanup callsite uses this without
  // sessionId (sweep all sessions).
  olderThanDays?: number;
}

export interface CheckpointManager {
  // True iff the manager will actually create snapshots. False means
  // every snapshot() returns null (no-op) — the harness wires the
  // manager either way so the call sites don't have to branch.
  readonly available: boolean;

  // Take a snapshot of the working tree before a step that has writes.
  // Returns null in two cases:
  //   1. The manager is unavailable (no git in cwd).
  //   2. The working tree matched the prior snapshot (no diff to
  //      record). Idempotent in both branches.
  snapshot(input: SnapshotInput): Promise<SnapshotOutcome>;

  // Newest-first listing of checkpoints in a session. Empty array when
  // the session never produced any. Same shape regardless of whether
  // the manager is available — listing reads the DB only.
  list(sessionId: string): Promise<Checkpoint[]>;

  // Public lookup by id. Returns null when the id is unknown or has
  // already been purged. The CLI uses this to validate `--undo` and
  // `--checkpoints restore` arguments before committing to side
  // effects.
  get(id: string): Promise<Checkpoint | null>;

  // Reset the working tree + index to a checkpoint's tree. Throws if
  // the manager is unavailable, or the checkpoint id is unknown, or
  // git refuses (e.g., commit object is gone after a manual GC). Returns
  // info about whether existing changes were stashed.
  restore(id: string): Promise<{
    stashed: boolean;
    stashRef?: string;
    stashKind?: 'git-stash' | 'agent-ref';
  }>;

  // Diff between current working tree and a checkpoint commit. Drives
  // `--checkpoints diff`. Empty string means "identical".
  diff(id: string): Promise<string>;

  // Drop checkpoint refs + rows. Returns the number of rows deleted.
  // Best-effort on the git side (a missing ref is treated as already
  // purged); the DB count is authoritative for callers that report.
  purge(opts?: PurgeOptions): Promise<number>;
}

export interface CreateManagerInput {
  db: DB;
  cwd: string;
  sessionId: string;
  available: boolean;
}

const sessionGetter = (mgr: CheckpointManagerImpl) => mgr.sessionId;

class CheckpointManagerImpl implements CheckpointManager {
  readonly db: DB;
  readonly cwd: string;
  readonly sessionId: string;
  readonly available: boolean;

  constructor(input: CreateManagerInput) {
    this.db = input.db;
    this.cwd = input.cwd;
    this.sessionId = input.sessionId;
    this.available = input.available;
  }

  async snapshot(input: SnapshotInput): Promise<SnapshotOutcome> {
    if (!this.available) {
      return { checkpointId: null, gitRef: null };
    }
    const iso = new Date().toISOString();
    const result = await gitSnapshot({
      cwd: this.cwd,
      sessionId: this.sessionId,
      stepId: input.stepId,
      iso,
      ...(input.stepN !== undefined ? { stepN: input.stepN } : {}),
    });
    if (result.sha === null) {
      // No diff vs the prior chain head — nothing to record. Returning
      // null here keeps the audit log honest: a row with `git_ref`
      // pointing at the same commit as the prior row would be noise
      // that confuses `--checkpoints list`.
      return { checkpointId: null, gitRef: null };
    }
    const row = insertCheckpoint(this.db, {
      sessionId: this.sessionId,
      stepId: input.stepId,
      gitRef: result.sha,
      hadBash: input.hadBash,
    });
    return { checkpointId: row.id, gitRef: result.sha };
  }

  async list(sessionId: string): Promise<Checkpoint[]> {
    return listCheckpointsBySession(this.db, sessionId);
  }

  async get(id: string): Promise<Checkpoint | null> {
    return getCheckpoint(this.db, id);
  }

  async restore(id: string): Promise<{
    stashed: boolean;
    stashRef?: string;
    stashKind?: 'git-stash' | 'agent-ref';
  }> {
    if (!this.available) {
      throw new Error('checkpoints not available (cwd is not a git repository)');
    }
    const row = getCheckpoint(this.db, id);
    if (row === null) {
      throw new Error(`checkpoint ${id} not found`);
    }
    return gitRestore(this.cwd, row.gitRef);
  }

  async diff(id: string): Promise<string> {
    if (!this.available) {
      throw new Error('checkpoints not available (cwd is not a git repository)');
    }
    const row = getCheckpoint(this.db, id);
    if (row === null) {
      throw new Error(`checkpoint ${id} not found`);
    }
    return gitDiff(this.cwd, row.gitRef);
  }

  async purge(opts: PurgeOptions = {}): Promise<number> {
    let deleted = 0;
    if (opts.sessionId !== undefined) {
      const sid = opts.sessionId;
      deleted = deleteCheckpointsBySession(this.db, sid);
      if (this.available) {
        // Best-effort ref delete. We swallow the error so a failure
        // here doesn't strand the DB rows we already removed — the
        // user can re-run `--checkpoints purge` and the next pass is
        // a no-op on the DB side and retries the ref.
        try {
          await deleteSessionRef(this.cwd, sid);
        } catch {
          // ignored
        }
      }
      return deleted;
    }
    const cutoffDays = opts.olderThanDays ?? DEFAULT_RETENTION_DAYS;
    const cutoffMs = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
    const aged = listCheckpointsOlderThan(this.db, cutoffMs);
    // Group rows by session: when every row of a session is aged out,
    // the ref is purged too. Sessions with mixed-age checkpoints keep
    // their ref (it points at the chain head, which is the newest
    // commit; older commits remain reachable via parent links and
    // GC catches them only if the chain is severed).
    const sessions = new Map<string, number>();
    for (const row of aged) {
      sessions.set(row.sessionId, (sessions.get(row.sessionId) ?? 0) + 1);
    }
    for (const row of aged) {
      deleteCheckpoint(this.db, row.id);
      deleted += 1;
    }
    if (this.available) {
      for (const sessionId of sessions.keys()) {
        const remaining = listCheckpointsBySession(this.db, sessionId);
        if (remaining.length === 0) {
          try {
            await deleteSessionRef(this.cwd, sessionId);
          } catch {
            // ignored
          }
          continue;
        }
        // Some checkpoints survived; re-point the session ref at the
        // most recent surviving sha so the chain stays reachable. The
        // newer commits are first in the listing (DESC).
        const head = remaining[0];
        if (head !== undefined) {
          // Idempotent: skip the spawn when the ref already matches
          // (the common case — aging out rows from the tail of the
          // chain doesn't move the head).
          const current = await resolveRef(this.cwd, sessionRef(sessionId));
          if (current !== head.gitRef) {
            try {
              await setSessionRef(this.cwd, sessionId, head.gitRef);
            } catch {
              // ignored
            }
          }
        }
      }
    }
    // Also sweep refs that have NO matching row at all (orphaned by a
    // prior manual DB wipe). Without this, a user who deleted the DB
    // would carry stale refs around forever.
    if (this.available) {
      try {
        const refs = await listSessionRefs(this.cwd);
        // Pull every session_id that still has at least one row in a
        // single query, then walk the refs against that set. The
        // earlier per-ref `listCheckpointsBySession` call was O(N×M)
        // — fine for a handful of refs but quadratic in the worst
        // case the cleanup pass is supposed to handle.
        const liveSessions = new Set<string>(
          (
            this.db.query('SELECT DISTINCT session_id FROM checkpoints').all() as {
              session_id: string;
            }[]
          ).map((r) => r.session_id),
        );
        for (const { sessionId } of refs) {
          if (!liveSessions.has(sessionId)) {
            try {
              await deleteSessionRef(this.cwd, sessionId);
            } catch {
              // ignored
            }
          }
        }
      } catch {
        // ignored — listing failures aren't worth crashing cleanup
      }
    }
    return deleted;
  }
}

export const createCheckpointManager = (input: CreateManagerInput): CheckpointManager =>
  new CheckpointManagerImpl(input);

// Exposed so tests can read the session id without poking at the
// implementation type. Not used by production code.
export const _testGetManagerSession = sessionGetter;
