export {
  MEMORY_DB,
  openDb,
  openMemoryDb,
  withImmediateTransaction,
  withTransaction,
} from './db.ts';
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
  reclassifySessionStatus,
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
  appendApprovalsLog,
  countApprovalsLog,
  getApprovalsLogBySeq,
  getLastApprovalsLogByInstall,
  listApprovalsLogByInstall,
  listApprovalsLogBySession,
  PERSISTED_COLUMNS as APPROVALS_LOG_COLUMNS,
} from './repos/approvals-log.ts';
export type {
  AppendApprovalsLogInput,
  ApprovalLogConfidence,
  ApprovalLogDecision,
  ApprovalLogRow,
} from './repos/approvals-log.ts';

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
  getSubagentHandle,
  insertSubagentHandle,
  listSubagentHandlesByParent,
  settleRunningSubagentHandles,
  settleSubagentHandle,
  updateSubagentHandleChildSession,
} from './repos/subagent-handles.ts';
export type {
  InsertSubagentHandleInput,
  SubagentHandleRecord,
  SubagentHandleStatus,
} from './repos/subagent-handles.ts';

export {
  getSubagentWorktree,
  insertSubagentWorktree,
  listAllSubagentWorktrees,
  listOnDiskSubagentWorktrees,
  listSubagentWorktreesWithParentCwd,
  markSubagentWorktreeCleaned,
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

export {
  getProcessRecord,
  listOrphanedProcesses,
  listProcessesByParent,
  markIpcHandshakeOk,
  recordProcessExit,
  recordProcessSpawn,
} from './repos/subagent-processes.ts';
export type {
  RecordProcessExitInput,
  RecordProcessSpawnInput,
  SubagentProcessExitReason,
  SubagentProcessRecord,
} from './repos/subagent-processes.ts';

export {
  createMemoryEvent,
  listMemoryEventsByName,
  listMemoryEventsBySession,
  listRecentMemoryEvents,
} from './repos/memory-events.ts';
export type {
  CreateMemoryEventInput,
  MemoryEvent,
  MemoryEventAction,
  MemoryEventScope,
  MemoryEventSource,
} from './repos/memory-events.ts';

export {
  DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD,
  GOVERNANCE_PROPOSAL_KINDS,
  GOVERNANCE_PROPOSAL_STATUSES,
  GOVERNANCE_PROPOSAL_TTL_MS,
  canonicalJsonStringify,
  computeProposalFingerprint,
  decideProposal,
  expirePendingProposals,
  getProposalById,
  listPendingProposals,
  listPendingProposalsForMemory,
  listProposals,
  listProposalsForMemory,
  recordProposal,
} from './repos/memory-governance.ts';
export type {
  DecideProposalInput,
  ListProposalsOptions,
  MemoryGovernanceProposalKind,
  MemoryGovernanceProposalRow,
  MemoryGovernanceProposalStatus,
  MemoryKey,
  MemorySnapshot,
  RecordProposalInput,
  RecordProposalResult,
} from './repos/memory-governance.ts';

export { listSessionExposuresSince } from './repos/memory-provenance.ts';

export {
  MEMORY_VERIFY_ATTEMPTS_RETENTION_MS,
  SEMANTIC_VERIFY_DEDUP_WINDOW_MS,
  SEMANTIC_VERIFY_VERDICTS,
  listRecentAttempts,
  lookupRecentAttempt,
  pruneVerifyAttempts,
  recordAttempt,
} from './repos/memory-verify-attempts.ts';
export type {
  MemoryVerifyAttemptRow,
  RecordAttemptInput,
  SemanticVerifyVerdict,
} from './repos/memory-verify-attempts.ts';

export {
  createHookRun,
  listHookRunsByEvent,
  listHookRunsBySession,
  listRecentHookRuns,
} from './repos/hook-runs.ts';
export type {
  CreateHookRunInput,
  HookRun,
  HookRunsEvent,
  HookRunsLayer,
  HookRunsOutcome,
} from './repos/hook-runs.ts';

export {
  insertCostProgressEvent,
  listCostProgressByHandle,
  listCostProgressByParent,
} from './repos/cost-progress-events.ts';
export type {
  CostProgressEvent,
  InsertCostProgressEventInput,
} from './repos/cost-progress-events.ts';

export {
  insertSubagentGateDecision,
  listSubagentGateDecisionsByParent,
  listSubagentGateDecisionsByType,
} from './repos/subagent-gate-decisions.ts';
export type {
  GateDecisionTool,
  GateDecisionType,
  InsertSubagentGateDecisionInput,
  SubagentGateDecision,
} from './repos/subagent-gate-decisions.ts';

export {
  listCritiqueRunsBySession,
  recordCritiqueRun,
} from './repos/critique-runs.ts';
export type {
  CritiqueRun,
  CritiqueRunCode,
  CritiqueRunDecision,
  CritiqueRunMode,
  CritiqueRunStrategy,
  RecordCritiqueRunInput,
} from './repos/critique-runs.ts';
