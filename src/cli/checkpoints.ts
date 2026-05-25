// `agent --checkpoints <verb>` and `agent --undo <session>` handlers.
// Independent of bootstrap (no provider, no permissions, no tool registry —
// only DB + git in cwd) so inspecting/restoring history doesn't require
// an API key. Mirrors the structure of `runListSessions`.
//
// Subcommands:
//   list <session>             — newest-first table / NDJSON of checkpoints
//   diff <session> <ckpt>      — diff between current working tree and ckpt
//   restore <session> <ckpt>   — read-tree --reset -u <ckpt>; HEAD untouched
//   purge <session>            — delete every ckpt row + the session ref
//
// `--undo <session>` is a thin alias over `restore <session> <latest>` that
// resolves the latest id internally.

import {
  type CheckpointManager,
  createCheckpointManager,
  detectCheckpointSupport,
} from '../checkpoints/index.ts';
import { type OutcomeSink, createSqliteOutcomeSink } from '../outcomes/index.ts';
import {
  type Checkpoint,
  type DB,
  closeDb,
  defaultDbPath,
  getLatestCheckpointBySession,
  getSession,
  migrate,
  openDb,
} from '../storage/index.ts';
import { listApprovalsLogBySessionSinceTs } from '../storage/repos/approvals-log.ts';

export interface CheckpointsCliInput {
  verb: 'list' | 'diff' | 'restore' | 'purge' | 'undo';
  positionals: string[];
  json: boolean;
  yes: boolean;
  cwd: string;
  // Test seams.
  dbPath?: string;
  dbOverride?: DB;
  // Output sinks. `out` carries the user-visible result (table /
  // NDJSON / diff text); `err` carries diagnostic and warning lines.
  // Mirrors the stdout/stderr split spec §2.6 mandates.
  out: (s: string) => void;
  err: (s: string) => void;
  // Slice 131: outcome_signals sink for the `--undo` /
  // `--checkpoints restore` paths. When wired, every approval
  // that landed AFTER the restored checkpoint emits a
  // `checkpoint_reverted` signal (weight 0.9) so spec §6.3.2
  // calibration sweeps see operator-undo as a strong "harmful"
  // proxy. Optional — pre-slice-131 callers (tests, headless
  // restore invocations) skip the emit.
  outcomeSink?: OutcomeSink;
}

const VALID_VERBS = ['list', 'diff', 'restore', 'purge', 'undo'] as const;

const formatTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.toISOString().replace('T', ' ').slice(0, 19)}Z`;
};

interface CheckpointListItem {
  id: string;
  step_id: string;
  git_ref: string;
  created_at: string;
  had_bash: boolean;
}

const toItem = (c: Checkpoint): CheckpointListItem => ({
  id: c.id,
  step_id: c.stepId,
  git_ref: c.gitRef,
  created_at: formatTime(c.createdAt),
  had_bash: c.hadBash,
});

const writeListJson = (items: CheckpointListItem[], out: (s: string) => void): void => {
  for (const it of items) out(`${JSON.stringify(it)}\n`);
};

const writeListTable = (items: CheckpointListItem[], out: (s: string) => void): void => {
  if (items.length === 0) {
    out('no checkpoints found.\n');
    return;
  }
  // Width chosen to fit a UUID id + a 40-char sha + ISO time on an
  // 80+ col terminal. `had_bash` shows as `bash` / `(no)` so the
  // operator can spot risky checkpoints at a glance.
  out(
    'CREATED               BASH  ID                                    GIT_REF                                   STEP\n',
  );
  for (const it of items) {
    const id = it.id.padEnd(36);
    const stepId = it.step_id;
    const sha = it.git_ref.slice(0, 40).padEnd(40);
    const bashCol = (it.had_bash ? 'bash' : '(no)').padEnd(5);
    out(`${it.created_at}  ${bashCol} ${id}  ${sha}  ${stepId}\n`);
  }
};

// Validate that the session id exists AND was created in the current
// cwd. The cwd guard is load-bearing for every verb beyond list:
//   - restore / undo run `git read-tree --reset -u` against the
//     active repo. If the session belongs to a different project,
//     the checkpoint's commit sha doesn't exist there, and we'd
//     either error confusingly OR (catastrophic) clobber unrelated
//     working-tree state if a sha collision happens.
//   - diff would compare against the wrong working tree.
//   - purge would drop DB rows for the wrong project; refs are
//     scoped to git so the ref delete is a harmless no-op, but the
//     audit log loss is silent.
//   - list reads only the DB but a cross-cwd listing is misleading
//     (the entries can't be acted on from this cwd anyway).
//
// Mirrors the cwd guard runAgent already enforces on resume (see
// src/harness/loop.ts) — same threat model, same message shape.
const ensureSessionForCwd = (
  db: DB,
  sessionId: string,
  cwd: string,
  err: (s: string) => void,
): boolean => {
  const session = getSession(db, sessionId);
  if (session === null) {
    err(`forja: session ${sessionId} not found\n`);
    return false;
  }
  if (session.cwd !== cwd) {
    err(
      `forja: session ${sessionId} was created in '${session.cwd}', not '${cwd}'.\ncd to the original directory to operate on this session, or use\n\`agent --list-sessions\` to find a session for the current cwd.\n`,
    );
    return false;
  }
  return true;
};

const buildManager = async (db: DB, cwd: string, sessionId: string): Promise<CheckpointManager> => {
  // Probe + manager construction lives here so every subcommand
  // gets the same `available` resolution. The manager treats
  // unavailable as a soft state (list still works; restore/diff
  // throw with a clear reason).
  const support = await detectCheckpointSupport(cwd);
  return createCheckpointManager({
    db,
    cwd,
    sessionId,
    available: support.available,
  });
};

const runList = async (input: CheckpointsCliInput, db: DB): Promise<number> => {
  const sessionId = input.positionals[0];
  if (sessionId === undefined) {
    input.err('forja: --checkpoints list requires a session id\n');
    return 1;
  }
  if (!ensureSessionForCwd(db, sessionId, input.cwd, input.err)) return 1;
  const mgr = await buildManager(db, input.cwd, sessionId);
  const list = await mgr.list(sessionId);
  const items = list.map(toItem);
  if (input.json) writeListJson(items, input.out);
  else writeListTable(items, input.out);
  return 0;
};

const runDiff = async (input: CheckpointsCliInput, db: DB): Promise<number> => {
  const [sessionId, ckptId] = input.positionals;
  if (sessionId === undefined || ckptId === undefined) {
    input.err('forja: --checkpoints diff requires a session id and a checkpoint id\n');
    return 1;
  }
  if (!ensureSessionForCwd(db, sessionId, input.cwd, input.err)) return 1;
  const mgr = await buildManager(db, input.cwd, sessionId);
  // `available=false` short-circuit. The manager throws with a
  // clear "not available" message; we surface it as a clean exit
  // rather than letting it bubble through the run() catch.
  if (!mgr.available) {
    input.err('forja: checkpoints not available (cwd is not a git repository)\n');
    return 1;
  }
  // Cross-session id avoidance — same shape as runRestore. Without
  // this, two sessions sharing a cwd would let a ckpt id from session
  // B diff "successfully" under session A's context, returning a
  // diff against the wrong checkpoint and misleading the operator
  // during recovery. CheckpointManager.get / .diff look up by id
  // globally, so the session-scoping has to live here.
  const ckpt = await mgr.get(ckptId);
  if (ckpt === null || ckpt.sessionId !== sessionId) {
    input.err(`forja: checkpoint ${ckptId} not found in session ${sessionId}\n`);
    return 1;
  }
  try {
    const out = await mgr.diff(ckpt.id);
    input.out(out);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    input.err(`forja: ${msg}\n`);
    return 1;
  }
};

// Shared body for `--checkpoints restore` and `--undo`. Both perform
// a working-tree reset to a checkpoint commit. The undo path resolves
// the latest checkpoint of the session before delegating; the explicit
// restore path takes a specific ckpt id.
//
// The bash-warning gate is the load-bearing safety net here: if the
// step that produced the checkpoint also ran bash, restoring its
// pre-state DOES NOT reverse anything the bash command did
// (databases written, network calls made, processes spawned). We
// refuse the restore unless `--yes` was passed, and the warning is
// echoed to stderr so the operator sees what they're trading.
const runRestoreImpl = async (
  input: CheckpointsCliInput,
  db: DB,
  sessionId: string,
  ckpt: Checkpoint,
): Promise<number> => {
  if (ckpt.hadBash && !input.yes) {
    input.err(
      [
        'WARNING: this step ran bash. --undo / --checkpoints restore reverts',
        '  filesystem changes within the cwd, but cannot reverse:',
        '    - Database / HTTP / network state changes',
        '    - Filesystem changes outside cwd',
        '    - Process spawns',
        '  Re-run with --yes to confirm.\n',
      ].join('\n'),
    );
    return 1;
  }
  const mgr = await buildManager(db, input.cwd, sessionId);
  if (!mgr.available) {
    input.err('forja: checkpoints not available (cwd is not a git repository)\n');
    return 1;
  }
  try {
    const result = await mgr.restore(ckpt.id);
    // Slice 131 (spec §6.3.2 calibration): every approval whose
    // tool call landed AFTER the restored checkpoint's wall-clock
    // is one the operator just rolled back. Emit a
    // `checkpoint_reverted` outcome_signal per approval with
    // weight 0.9 (strong: explicit human "this should not have
    // happened"). Time-based filter is an approximation —
    // operator may have undone a subset of intent — but
    // calibration sweeps can downweight by grouping. Capped at
    // 200 to bound the emit storm; if more approvals were
    // reverted, the calibration script can re-derive the rest
    // from the tool_calls + approval_call_links join.
    //
    // Best-effort: signal emit failure stderrs but never blocks
    // the restore result reporting. The restore already
    // committed; observability is downstream.
    if (input.outcomeSink !== undefined) {
      // Slice 131 fixup #3: push the `ts >= ckpt.createdAt`
      // predicate into SQL + ORDER BY seq DESC LIMIT 200 so the
      // cap truncates the OLDEST overflow, not the newest. Pre-
      // fixup `listApprovalsLogBySession(.., 200)` returned the
      // FIRST 200 by seq ASC — for any long session those are
      // pre-checkpoint approvals and the wire silently signaled
      // NONE of the actually-reverted rows. Result is sorted
      // DESC; per-emit catch (slice 131 fixup #5) ensures a
      // transient SQLITE_BUSY on one approval doesn't drop the
      // whole cohort.
      const revertedApprovals = listApprovalsLogBySessionSinceTs(
        db,
        sessionId,
        ckpt.createdAt,
        200,
      );
      for (const a of revertedApprovals) {
        try {
          input.outcomeSink.emit({
            approval_seq: a.seq,
            signal_kind: 'checkpoint_reverted',
            payload: {
              checkpoint_id: ckpt.id,
              restored_to_step: ckpt.stepId,
              tool_name: a.tool_name,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          input.err(
            `forja outcome_signals: checkpoint_reverted emit failed for approval_seq=${a.seq} (${msg}); continuing with remaining ${revertedApprovals.length} signals\n`,
          );
        }
      }
    }
    if (result.stashed && result.stashRef !== undefined) {
      // Recovery hint depends on where we stored the saved working
      // tree. The regular `git stash` path is recoverable via
      // `git stash pop`; the unborn-HEAD path uses our own ref so
      // we point at `git read-tree --reset -u <ref>` instead —
      // `git stash pop` would also fail with "no initial commit"
      // and confuse the user.
      const recoveryHint =
        result.stashKind === 'agent-ref'
          ? `Run \`git read-tree --reset -u ${result.stashRef}\` to recover\nthe changes if you need them (HEAD is unborn; \`git stash pop\` would fail).`
          : 'Run `git stash pop` to recover\nthe changes if you need them.';
      input.err(
        `Working tree had uncommitted changes; saved to ${result.stashRef}.\nRestored to checkpoint ${ckpt.id}. ${recoveryHint}\n`,
      );
    } else {
      input.err(`Restored to checkpoint ${ckpt.id}.\n`);
    }
    if (input.json) {
      input.out(
        `${JSON.stringify({
          ok: true,
          checkpoint_id: ckpt.id,
          stashed: result.stashed,
          stash_ref: result.stashRef ?? null,
          stash_kind: result.stashKind ?? null,
        })}\n`,
      );
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Friendly rewrite for the most common failure: the checkpoint
    // commit was reclaimed by `git gc` (typical after a manual
    // prune, or because the user ran `git gc --aggressive` and the
    // ref namespace got truncated). Raw git output ("fatal: bad
    // object" / "not a valid object name") doesn't tell the user
    // what to do next; the rewrite points them at purge.
    if (
      msg.includes('bad object') ||
      msg.includes('not a valid object name') ||
      msg.includes('unknown revision') ||
      // Empty/all-zero sha and other unresolvable revisions surface
      // here. Same root cause as the cases above (commit object isn't
      // there) so the fix is the same: tell the user to purge.
      msg.includes('Needed a single revision')
    ) {
      input.err(
        `forja: checkpoint ${ckpt.id} references commit ${ckpt.gitRef} which is no\nlonger reachable in git (likely garbage-collected). Run\n\`agent --checkpoints purge ${sessionId}\` to drop the stale rows.\n`,
      );
      return 1;
    }
    input.err(`forja: ${msg}\n`);
    return 1;
  }
};

const runRestore = async (input: CheckpointsCliInput, db: DB): Promise<number> => {
  const [sessionId, ckptId] = input.positionals;
  if (sessionId === undefined || ckptId === undefined) {
    input.err('forja: --checkpoints restore requires a session id and a checkpoint id\n');
    return 1;
  }
  if (!ensureSessionForCwd(db, sessionId, input.cwd, input.err)) return 1;
  const mgr = await buildManager(db, input.cwd, sessionId);
  const ckpt = await mgr.get(ckptId);
  if (ckpt === null || ckpt.sessionId !== sessionId) {
    // Cross-session id avoidance: a literal id from another session
    // would otherwise restore "successfully" against the wrong cwd
    // (or wrong working tree) — refuse explicitly.
    input.err(`forja: checkpoint ${ckptId} not found in session ${sessionId}\n`);
    return 1;
  }
  return runRestoreImpl(input, db, sessionId, ckpt);
};

const runUndo = async (input: CheckpointsCliInput, db: DB): Promise<number> => {
  const sessionId = input.positionals[0];
  if (sessionId === undefined) {
    input.err('forja: --undo requires a session id\n');
    return 1;
  }
  if (!ensureSessionForCwd(db, sessionId, input.cwd, input.err)) return 1;
  const ckpt = getLatestCheckpointBySession(db, sessionId);
  if (ckpt === null) {
    input.err(`forja: session ${sessionId} has no checkpoints to undo\n`);
    return 1;
  }
  return runRestoreImpl(input, db, sessionId, ckpt);
};

const runPurge = async (input: CheckpointsCliInput, db: DB): Promise<number> => {
  const sessionId = input.positionals[0];
  if (sessionId === undefined) {
    input.err('forja: --checkpoints purge requires a session id\n');
    return 1;
  }
  if (!ensureSessionForCwd(db, sessionId, input.cwd, input.err)) return 1;
  const mgr = await buildManager(db, input.cwd, sessionId);
  const deleted = await mgr.purge({ sessionId });
  if (input.json) {
    input.out(`${JSON.stringify({ ok: true, deleted })}\n`);
  } else {
    input.out(`purged ${deleted} checkpoint(s) for session ${sessionId}\n`);
  }
  return 0;
};

export const runCheckpointsCli = async (input: CheckpointsCliInput): Promise<number> => {
  if (!VALID_VERBS.includes(input.verb)) {
    input.err(`forja: unknown checkpoint verb '${input.verb}'\n`);
    return 1;
  }
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = input.dbOverride ?? openDb(dbPath);
  const ownsDb = input.dbOverride === undefined;
  try {
    if (ownsDb) migrate(db);
    // Slice 131: when caller didn't pass an outcomeSink AND the
    // verb is restore/undo (the only verbs that emit signals),
    // construct one from the opened DB. Keeps the CLI verbs
    // self-contained — `agent --undo` doesn't need bootstrap.ts
    // wiring to record calibration signals. Tests that want to
    // assert NO emit can pass `outcomeSink: createNoopOutcomeSink()`.
    const effectiveInput: CheckpointsCliInput =
      input.outcomeSink === undefined && (input.verb === 'restore' || input.verb === 'undo')
        ? { ...input, outcomeSink: createSqliteOutcomeSink({ db }) }
        : input;
    switch (effectiveInput.verb) {
      case 'list':
        return await runList(effectiveInput, db);
      case 'diff':
        return await runDiff(effectiveInput, db);
      case 'restore':
        return await runRestore(effectiveInput, db);
      case 'purge':
        return await runPurge(effectiveInput, db);
      case 'undo':
        return await runUndo(effectiveInput, db);
    }
  } finally {
    if (ownsDb) closeDb(db);
  }
};
