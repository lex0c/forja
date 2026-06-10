export { detectCheckpointSupport } from './detect.ts';
export type { CheckpointAvailability } from './detect.ts';

export {
  DEFAULT_RETENTION_DAYS,
  createCheckpointManager,
} from './manager.ts';
export type {
  CheckpointManager,
  CreateManagerInput,
  PurgeOptions,
  SnapshotInput,
  SnapshotOutcome,
} from './manager.ts';

export {
  RESTORE_SAVED_REF_PREFIX,
  deleteRestoreSavedRef,
  deleteSessionRef,
  diff as gitDiff,
  getCommitMessage,
  getCommitTree,
  getHeadSha,
  getInProgressOperation,
  getWorktreeRoot,
  isGitRepo,
  isWorkingTreeDirty,
  listRestoreSavedRefs,
  listSessionRefs,
  parseRestoreSavedTimestamp,
  resolveRef,
  restore as gitRestore,
  rewriteCheckpointCommit,
  sessionRef,
  setSessionRef,
  snapshot as gitSnapshot,
} from './git.ts';
export type { RestoreResult, SnapshotResult } from './git.ts';
