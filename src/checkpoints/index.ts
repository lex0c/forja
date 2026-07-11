export type { CheckpointAvailability } from './detect.ts';
export { detectCheckpointSupport } from './detect.ts';
export type { RestoreResult, SnapshotResult } from './git.ts';
export {
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
  RESTORE_SAVED_REF_PREFIX,
  resolveRef,
  restore as gitRestore,
  rewriteCheckpointCommit,
  sessionRef,
  setSessionRef,
  snapshot as gitSnapshot,
} from './git.ts';
export type {
  CheckpointManager,
  CreateManagerInput,
  PurgeOptions,
  SnapshotInput,
  SnapshotOutcome,
} from './manager.ts';
export {
  createCheckpointManager,
  DEFAULT_RETENTION_DAYS,
} from './manager.ts';
