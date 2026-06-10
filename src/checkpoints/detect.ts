import { getWorktreeRoot, isGitRepo } from './git.ts';

export interface CheckpointAvailability {
  // True iff the cwd is inside a git work-tree AND we successfully
  // resolved that fact via `git rev-parse`. Drives whether the harness
  // wires a checkpoint manager at all.
  available: boolean;
  // Human-readable explanation when `available === false`. Surfaced as
  // a one-line warning at startup so the user knows `/undo` won't be
  // there. Null when available.
  reason: string | null;
  // Absolute worktree root (`git rev-parse --show-toplevel`) when
  // available. The manager anchors every git invocation here rather
  // than the invocation cwd so snapshot/restore cover the whole
  // worktree regardless of which subdirectory the agent runs from
  // (CHECKPOINTS §2.6). Null when unavailable. Falls back to the
  // invocation cwd if the toplevel probe fails inside a real repo
  // (defensive — should not happen once isGitRepo returned true).
  gitRoot: string | null;
}

// Light-weight startup probe. Calls `git rev-parse` once; that is
// already the dominant cost of the check (single fork of git), so we
// don't add caching here — the harness calls this once per run.
//
// Why we don't fail-closed (no git → run aborts): per CHECKPOINTS §2.2
// the v1 decision is to keep tools running normally and just disable
// `/undo`. Operators in a non-git directory can still use the agent
// for read-only work or accept that they'll have no rollback for a
// session.
export const detectCheckpointSupport = async (cwd: string): Promise<CheckpointAvailability> => {
  if (!(await isGitRepo(cwd))) {
    return {
      available: false,
      reason: `checkpoints disabled: ${cwd} is not a git repository`,
      gitRoot: null,
    };
  }
  // Resolve the worktree root once here (the probe already paid for a
  // git fork on isGitRepo; this is one more, at startup only). The
  // manager uses it to anchor snapshot/restore worktree-wide. Fall
  // back to cwd if `--show-toplevel` somehow fails despite the repo
  // check passing — worktree-wide behavior degrades to the invocation
  // cwd, which is exactly the pre-fix behavior.
  const gitRoot = (await getWorktreeRoot(cwd)) ?? cwd;
  return { available: true, reason: null, gitRoot };
};
