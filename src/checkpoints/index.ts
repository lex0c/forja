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
  deleteSessionRef,
  diff as gitDiff,
  getHeadSha,
  isGitRepo,
  isWorkingTreeDirty,
  listSessionRefs,
  resolveRef,
  restore as gitRestore,
  sessionRef,
  setSessionRef,
  snapshot as gitSnapshot,
} from './git.ts';
export type { RestoreResult, SnapshotResult } from './git.ts';
