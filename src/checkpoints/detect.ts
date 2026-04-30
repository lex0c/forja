import { isGitRepo } from './git.ts';

export interface CheckpointAvailability {
  // True iff the cwd is inside a git work-tree AND we successfully
  // resolved that fact via `git rev-parse`. Drives whether the harness
  // wires a checkpoint manager at all.
  available: boolean;
  // Human-readable explanation when `available === false`. Surfaced as
  // a one-line warning at startup so the user knows `/undo` won't be
  // there. Null when available.
  reason: string | null;
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
    };
  }
  return { available: true, reason: null };
};
