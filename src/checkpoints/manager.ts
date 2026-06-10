import {
  type Checkpoint,
  type DB,
  deleteCheckpoint,
  deleteCheckpointsBySession,
  getCheckpoint,
  getLatestCheckpointBySession,
  insertCheckpoint,
  listCheckpointsBySession,
  listCheckpointsOlderThan,
  updateCheckpointGitRef,
  withTransaction,
} from '../storage/index.ts';
import {
  deleteRestoreSavedRef,
  deleteSessionRef,
  getCommitMessage,
  getCommitTree,
  getHeadSha,
  diff as gitDiff,
  restore as gitRestore,
  snapshot as gitSnapshot,
  listRestoreSavedRefs,
  listSessionRefs,
  rewriteCheckpointCommit,
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
  // Worktree root (`git rev-parse --show-toplevel`) from
  // detectCheckpointSupport. Every git invocation anchors here so
  // snapshot/restore cover the whole worktree regardless of which
  // subdirectory the agent runs from (CHECKPOINTS §2.6). Optional for
  // backward compat: when omitted, falls back to `cwd` — which is
  // correct whenever the agent runs from the repo root (the common
  // case and what the tests exercise). `cwd` itself stays the
  // invocation directory because retention scoping joins against
  // `sessions.cwd`, which records the invocation cwd, not the root.
  gitRoot?: string;
}

const sessionGetter = (mgr: CheckpointManagerImpl) => mgr.sessionId;

class CheckpointManagerImpl implements CheckpointManager {
  readonly db: DB;
  readonly cwd: string;
  // Worktree root for git invocations. Distinct from `cwd` (the
  // invocation directory used for DB/session scoping): see
  // CreateManagerInput.gitRoot. `cwd` fallback keeps repo-root runs and
  // tests unchanged.
  readonly gitRoot: string;
  readonly sessionId: string;
  readonly available: boolean;

  constructor(input: CreateManagerInput) {
    this.db = input.db;
    this.cwd = input.cwd;
    this.gitRoot = input.gitRoot ?? input.cwd;
    this.sessionId = input.sessionId;
    this.available = input.available;
  }

  async snapshot(input: SnapshotInput): Promise<SnapshotOutcome> {
    if (!this.available) {
      return { checkpointId: null, gitRef: null };
    }
    const iso = new Date().toISOString();
    const result = await gitSnapshot({
      cwd: this.gitRoot,
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
    return gitRestore(this.gitRoot, row.gitRef);
  }

  async diff(id: string): Promise<string> {
    if (!this.available) {
      throw new Error('checkpoints not available (cwd is not a git repository)');
    }
    const row = getCheckpoint(this.db, id);
    if (row === null) {
      throw new Error(`checkpoint ${id} not found`);
    }
    return gitDiff(this.gitRoot, row.gitRef);
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
          await deleteSessionRef(this.gitRoot, sid);
        } catch {
          // ignored
        }
      }
      return deleted;
    }
    const cutoffDays = opts.olderThanDays ?? DEFAULT_RETENTION_DAYS;
    const cutoffMs = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
    // cwd-scoped age listing. The harness wires manager to the
    // current run's cwd; without the scope, lazy retention here
    // would walk rows from sessions in OTHER cwds and delete them
    // — wiping audit history for projects this manager isn't
    // responsible for. The scope keeps the row sweep aligned with
    // the ref sweep below (which is naturally cwd-bound: refs only
    // exist in the git store of the cwd they were created in).
    const aged = listCheckpointsOlderThan(this.db, cutoffMs, this.cwd);
    // Group aged rows by session — each session's rewrite + aged-row
    // deletion is its own atomic unit. A failure on one session
    // doesn't taint another's progress.
    const agedBySession = new Map<string, Checkpoint[]>();
    for (const row of aged) {
      const arr = agedBySession.get(row.sessionId) ?? [];
      arr.push(row);
      agedBySession.set(row.sessionId, arr);
    }
    if (!this.available) {
      // No git in this cwd: just drop the rows. No refs or commits to
      // reconcile. Single transaction so a partial DB failure doesn't
      // leave stragglers.
      try {
        withTransaction(this.db, () => {
          for (const row of aged) {
            deleteCheckpoint(this.db, row.id);
            deleted += 1;
          }
        });
      } catch {
        deleted = 0;
      }
    } else {
      for (const [sessionId, agedRows] of agedBySession) {
        const allRows = listCheckpointsBySession(this.db, sessionId);
        const agedIds = new Set(agedRows.map((r) => r.id));
        const remaining = allRows.filter((c) => !agedIds.has(c.id));
        if (remaining.length === 0) {
          // All rows for this session aged out. Drop them + the ref.
          // No survivor chain to rewrite.
          try {
            withTransaction(this.db, () => {
              for (const r of agedRows) {
                deleteCheckpoint(this.db, r.id);
                deleted += 1;
              }
            });
          } catch {
            // DB transaction rolled back; rows stayed.
            continue;
          }
          try {
            await deleteSessionRef(this.gitRoot, sessionId);
          } catch {
            // ignored
          }
          continue;
        }
        // Some checkpoints survived. Just re-pointing the session ref
        // at the latest survivor is NOT enough: every survivor still
        // parents the now-aged commits via its commit object, so git
        // treats the aged commits as reachable and gc never reclaims
        // them. Retention would only HIDE history, not enforce object
        // retention — defeating the whole point of the retentionDays
        // knob (CHECKPOINTS.md §2.5).
        //
        // Sever ancestry by rewriting the surviving chain in
        // chronological order: the oldest survivor's parent becomes
        // current HEAD (or null if unborn), and each subsequent
        // survivor's parent becomes the prior survivor's NEW sha.
        // The original commit objects (both aged and the originals
        // of survivors) become unreachable from any ref; a future
        // git gc reclaims them.
        //
        // Crucially, aged rows are NOT deleted yet — only after the
        // git rewrite + DB update succeed atomically below. A
        // transient rewrite failure (e.g., getCommitTree throws
        // because a survivor's commit object was manually pruned)
        // leaves aged rows in place so the next purge can retry.
        // Pre-fix, aged rows were deleted up front and the rewrite
        // trigger was lost forever on transient failure — aged
        // commits stayed reachable indefinitely.
        const chronological = [...remaining].reverse();
        const headSha = await getHeadSha(this.gitRoot).catch(() => null);
        const rewrites: { id: string; newSha: string }[] = [];
        let priorParent: string | null = headSha;
        let rewriteOk = true;
        for (const ckpt of chronological) {
          try {
            const treeSha = await getCommitTree(this.gitRoot, ckpt.gitRef);
            const message = await getCommitMessage(this.gitRoot, ckpt.gitRef);
            const newSha = await rewriteCheckpointCommit(
              this.gitRoot,
              treeSha,
              priorParent,
              message,
            );
            rewrites.push({ id: ckpt.id, newSha });
            priorParent = newSha;
          } catch {
            // Abort the batch. The orphan commit objects we already
            // created are unreachable and gc reclaims them; aged
            // rows untouched, so next purge retries.
            rewriteOk = false;
            break;
          }
        }
        if (!rewriteOk || rewrites.length !== chronological.length) continue;

        // All git rewrites succeeded. Aged-row deletion AND survivor
        // git_ref updates land in one transaction so a mid-loop DB
        // failure can't leave the table in a half-rewritten state.
        // Then move the ref. The previous ordering (delete aged,
        // then rewrite, then update + move) had two failure modes:
        // (a) rewrite fail → aged gone, no retry; (b) ref-move fail
        // → DB ahead of ref. The new ordering closes (a); the
        // self-heal sweep below catches (b).
        let dbApplied = true;
        const agedDeletedThisRound = agedRows.length;
        try {
          withTransaction(this.db, () => {
            for (const r of agedRows) {
              deleteCheckpoint(this.db, r.id);
            }
            for (const r of rewrites) {
              updateCheckpointGitRef(this.db, r.id, r.newSha);
            }
          });
          deleted += agedDeletedThisRound;
        } catch {
          dbApplied = false;
        }
        if (dbApplied) {
          const finalSha = rewrites[rewrites.length - 1]?.newSha;
          if (finalSha !== undefined) {
            try {
              await setSessionRef(this.gitRoot, sessionId, finalSha);
            } catch {
              // self-heal sweep below detects + retries
            }
          }
        }
      }
    }
    // Sweep session refs for two divergence shapes:
    //
    // 1. ORPHAN: ref exists but no DB rows reference its session.
    //    Cause: manual DB wipe or a session whose rows aged out via
    //    a prior purge that never reached the ref-delete branch.
    //    Action: delete the ref.
    //
    // 2. DRIFT: ref points at a sha that doesn't match the latest
    //    survivor's git_ref. Cause: a previous retention rewrite's
    //    setSessionRef failed AFTER the DB updates landed (transient
    //    ref lock, fs hiccup). Without recovery, aged commits stay
    //    reachable through the old chain forever — the rewrite
    //    branch above can't re-fire because the trigger (aged rows)
    //    is already gone, and the orphan check below skips because
    //    rows exist. Action: re-attempt setSessionRef to the new
    //    sha; if the new commit was reclaimed by gc in the meantime,
    //    leave alone (CLI restore surfaces a friendly hint pointing
    //    at --checkpoints purge for that session).
    if (this.available) {
      try {
        const refs = await listSessionRefs(this.gitRoot);
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
        for (const { sessionId, sha: refSha } of refs) {
          if (!liveSessions.has(sessionId)) {
            try {
              await deleteSessionRef(this.gitRoot, sessionId);
            } catch {
              // ignored
            }
            continue;
          }
          // Drift detection. The latest survivor's git_ref is what
          // the ref SHOULD point at; any other sha means a prior
          // ref-move failed.
          const latest = getLatestCheckpointBySession(this.db, sessionId);
          if (latest === null) continue;
          if (latest.gitRef === refSha) continue;
          try {
            await setSessionRef(this.gitRoot, sessionId, latest.gitRef);
          } catch {
            // Move failed again — could be the new commit was gc'd
            // (extremely rare; the rewrite would have been very
            // recent), or another concurrent op is holding the ref
            // lock. Either way the next purge will retry.
          }
        }
      } catch {
        // ignored — listing failures aren't worth crashing cleanup
      }
    }
    // Sweep restore-saved preservation refs by age. These refs are
    // created by restore() in the unborn-HEAD path (no DB row, no
    // session linkage); the timestamp baked into the ref name is the
    // only retention signal. Same cutoff as the row-driven sweep
    // above so users get one consistent retention window.
    if (this.available) {
      try {
        const restoreRefs = await listRestoreSavedRefs(this.gitRoot);
        for (const { ref, timestampMs } of restoreRefs) {
          // Skip refs whose name doesn't follow the timestamped format
          // (manual creations, format from a future / past iteration).
          // Conservative: if we can't read a timestamp, we don't know
          // if it's safe to drop.
          if (timestampMs === null) continue;
          if (timestampMs < cutoffMs) {
            try {
              await deleteRestoreSavedRef(this.gitRoot, ref);
            } catch {
              // ignored
            }
          }
        }
      } catch {
        // ignored
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
