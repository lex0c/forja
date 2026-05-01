export { MEMORY_DB, openDb, openMemoryDb, withTransaction } from './db.ts';
export type { DB } from './db.ts';
export { StorageJsonError } from './json-safe.ts';

export { defaultDataDir, defaultDbPath } from './paths.ts';

export { migrate } from './migrate.ts';
export type { MigrateResult } from './migrate.ts';
export type { Migration } from './migrations/index.ts';
export { MIGRATIONS } from './migrations/index.ts';

export {
  completeSession,
  countSessions,
  createSession,
  cumulativeCostUsd,
  getSession,
  listChildSessions,
  listSessions,
  reopenSession,
  updateSessionCost,
} from './repos/sessions.ts';
export type {
  CreateSessionInput,
  ListSessionsOptions,
  Session,
  SessionStatus,
} from './repos/sessions.ts';

export {
  appendMessage,
  getMessage,
  listMessageTailBySession,
  listMessagesBySession,
} from './repos/messages.ts';
export type { MessageTail } from './repos/messages.ts';
export type { AppendMessageInput, Message, MessageRole } from './repos/messages.ts';

export {
  createToolCall,
  finishToolCall,
  getToolCall,
  listToolCallsByMessage,
  startToolCall,
} from './repos/tool-calls.ts';
export type {
  CreateToolCallInput,
  FinishToolCallInput,
  ToolCall,
  ToolCallStatus,
} from './repos/tool-calls.ts';

export { listApprovalsByToolCall, recordApproval } from './repos/approvals.ts';
export type {
  Approval,
  ApprovalDecidedBy,
  ApprovalDecision,
  RecordApprovalInput,
} from './repos/approvals.ts';

export {
  advanceBgProcessStderrCursor,
  advanceBgProcessStdoutCursor,
  finalizeBgProcess,
  getBgProcess,
  insertBgProcess,
  listBgProcessesBySession,
  markBgProcessAsKilled,
  markRunningAsKilled,
} from './repos/bg-processes.ts';
export type {
  BgProcess,
  BgProcessStatus,
  FinalizeBgProcessInput,
  InsertBgProcessInput,
  ListBgProcessesFilter,
} from './repos/bg-processes.ts';

export {
  deleteCheckpoint,
  deleteCheckpointsBySession,
  getCheckpoint,
  getLatestCheckpointBySession,
  insertCheckpoint,
  listCheckpointsBySession,
  listCheckpointsOlderThan,
  updateCheckpointGitRef,
} from './repos/checkpoints.ts';
export type { Checkpoint, InsertCheckpointInput } from './repos/checkpoints.ts';

export { getSubagentRun, insertSubagentRun } from './repos/subagent-runs.ts';
export type {
  InsertSubagentRunInput,
  SubagentRun,
  SubagentScope as SubagentRunScope,
} from './repos/subagent-runs.ts';

export {
  getSubagentWorktree,
  insertSubagentWorktree,
  listOnDiskSubagentWorktrees,
} from './repos/subagent-worktrees.ts';
export type {
  InsertSubagentWorktreeInput,
  SubagentWorktree,
  SubagentWorktreeStatus,
} from './repos/subagent-worktrees.ts';

export {
  getSubagentOutput,
  insertSubagentOutput,
  listStaleSubagentOutputs,
  setSubagentPayload,
  updateSubagentHeartbeat,
} from './repos/subagent-outputs.ts';
export type {
  InsertSubagentOutputInput,
  SubagentOutput,
} from './repos/subagent-outputs.ts';
