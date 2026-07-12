export type { DB } from './db.ts';
export {
  closeDb,
  MEMORY_DB,
  openDb,
  openMemoryDb,
  withImmediateTransaction,
  withTransaction,
} from './db.ts';
export { StorageJsonError } from './json-safe.ts';
export type { MigrateResult } from './migrate.ts';

export { countPendingMigrations, migrate } from './migrate.ts';
export type { Migration } from './migrations/index.ts';
export { MIGRATIONS } from './migrations/index.ts';
export { defaultDataDir, defaultDbPath } from './paths.ts';
export type {
  Approval,
  ApprovalDecidedBy,
  ApprovalDecision,
  RecordApprovalInput,
} from './repos/approvals.ts';
export { listApprovalsByToolCall, recordApproval } from './repos/approvals.ts';
export type {
  AppendApprovalsLogInput,
  ApprovalLogConfidence,
  ApprovalLogDecision,
  ApprovalLogRow,
} from './repos/approvals-log.ts';
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
  BgProcess,
  BgProcessStatus,
  FinalizeBgProcessInput,
  InsertBgProcessInput,
  ListBgProcessesFilter,
} from './repos/bg-processes.ts';
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
export type { Checkpoint, InsertCheckpointInput } from './repos/checkpoints.ts';
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
export type {
  CostProgressEvent,
  InsertCostProgressEventInput,
} from './repos/cost-progress-events.ts';
export {
  insertCostProgressEvent,
  listCostProgressByHandle,
  listCostProgressByParent,
} from './repos/cost-progress-events.ts';
export type {
  CreateHookRunInput,
  HookRun,
  HookRunsEvent,
  HookRunsLayer,
  HookRunsOutcome,
} from './repos/hook-runs.ts';
export {
  createHookRun,
  listHookRunsByEvent,
  listHookRunsBySession,
  listRecentHookRuns,
} from './repos/hook-runs.ts';
export type {
  CreateMemoryEventInput,
  MemoryEvent,
  MemoryEventAction,
  MemoryEventScope,
  MemoryEventSource,
} from './repos/memory-events.ts';
export {
  createMemoryEvent,
  listMemoryEventsByName,
  listMemoryEventsBySession,
  listRecentMemoryEvents,
} from './repos/memory-events.ts';
export type {
  DecideProposalInput,
  DeferProposalInput,
  DeferProposalResult,
  ExpirePendingProposalsInput,
  ListProposalsOptions,
  MemoryGovernanceProposalKind,
  MemoryGovernanceProposalRow,
  MemoryGovernanceProposalStatus,
  MemoryKey,
  MemorySnapshot,
  RecordProposalInput,
  RecordProposalResult,
} from './repos/memory-governance.ts';
export {
  canonicalJsonStringify,
  computeProposalFingerprint,
  DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD,
  decideProposal,
  deferProposal,
  expirePendingProposals,
  GOVERNANCE_PROPOSAL_KINDS,
  GOVERNANCE_PROPOSAL_STATUSES,
  GOVERNANCE_PROPOSAL_TTL_MS,
  getProposalById,
  listPendingProposals,
  listPendingProposalsForMemory,
  listProposals,
  listProposalsForMemory,
  MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS,
  MAX_GOVERNANCE_PROPOSAL_DEFER_HORIZON_MS,
  MIN_GOVERNANCE_PROPOSAL_DEFER_DAYS,
  recordProposal,
} from './repos/memory-governance.ts';
export type {
  MemoryOverrideEventRow,
  OverrideSignal,
  RecordOverrideEventInput,
  RecordOverrideEventResult,
} from './repos/memory-override-events.ts';
export {
  countOverridesInWindow,
  listOverrideEventsSince,
  listRecentOverridesForMemory,
  MEMORY_OVERRIDE_EVENTS_RETENTION_MS,
  MEMORY_OVERRIDE_THRESHOLD_COUNT,
  MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS,
  OVERRIDE_SIGNALS,
  pruneOverrideEvents,
  recordOverrideEvent,
} from './repos/memory-override-events.ts';
export {
  listRecentSessionExposures,
  listSessionExposuresSince,
} from './repos/memory-provenance.ts';
export type {
  MemoryVerifyAttemptRow,
  RecordAttemptInput,
  SemanticVerifyVerdict,
} from './repos/memory-verify-attempts.ts';
export {
  listRecentAttempts,
  lookupRecentAttempt,
  MEMORY_VERIFY_ATTEMPTS_RETENTION_MS,
  pruneVerifyAttempts,
  recordAttempt,
  SEMANTIC_VERIFY_DEDUP_WINDOW_MS,
  SEMANTIC_VERIFY_VERDICTS,
} from './repos/memory-verify-attempts.ts';
export type {
  MemoryVerifyOverrideAttemptRow,
  OverrideSuggestedMotivo,
  RecordOverrideAttemptInput,
} from './repos/memory-verify-override-attempts.ts';
export {
  listRecentOverrideAttempts,
  lookupRecentOverrideAttempt,
  MEMORY_VERIFY_OVERRIDE_ATTEMPTS_RETENTION_MS,
  OVERRIDE_SUGGESTED_MOTIVOS,
  pruneOverrideAttempts,
  recordOverrideAttempt,
} from './repos/memory-verify-override-attempts.ts';
export type {
  AppendMessageInput,
  Message,
  MessageRole,
  MessageTail,
  MessageUsageTotals,
} from './repos/messages.ts';
export {
  appendMessage,
  countMessagesBySession,
  getMessage,
  listMessagesBySession,
  listMessageTailBySession,
  sumMessageUsage,
} from './repos/messages.ts';
export type {
  CreateSessionInput,
  ListSessionsOptions,
  Session,
  SessionStatus,
} from './repos/sessions.ts';
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
  CreateSkillEventInput,
  SkillEvent,
  SkillEventAction,
  SkillEventScope,
} from './repos/skill-events.ts';

export {
  createSkillEvent,
  listRecentSkillEvents,
  listSkillEventsByName,
  listSkillEventsBySession,
} from './repos/skill-events.ts';
export type { UsageStats } from './repos/stats.ts';
export { cacheHitRatio, cacheWriteAmplification, computeUsageStats } from './repos/stats.ts';
export type {
  GateDecisionTool,
  GateDecisionType,
  InsertSubagentGateDecisionInput,
  SubagentGateDecision,
} from './repos/subagent-gate-decisions.ts';
export {
  insertSubagentGateDecision,
  listSubagentGateDecisionsByParent,
  listSubagentGateDecisionsByType,
} from './repos/subagent-gate-decisions.ts';
export type {
  InsertSubagentHandleInput,
  SubagentHandleRecord,
  SubagentHandleStatus,
} from './repos/subagent-handles.ts';
export {
  getSubagentHandle,
  insertSubagentHandle,
  listSubagentHandlesByParent,
  settleRunningSubagentHandles,
  settleSubagentHandle,
  updateSubagentHandleChildSession,
} from './repos/subagent-handles.ts';
export type {
  InsertSubagentOutputInput,
  SubagentOutput,
} from './repos/subagent-outputs.ts';
export {
  getSubagentOutput,
  insertSubagentOutput,
  listStaleSubagentOutputs,
  setSubagentPayload,
  updateSubagentHeartbeat,
} from './repos/subagent-outputs.ts';
export type {
  RecordProcessExitInput,
  RecordProcessSpawnInput,
  SubagentProcessExitReason,
  SubagentProcessRecord,
} from './repos/subagent-processes.ts';
export {
  getProcessRecord,
  listOrphanedProcesses,
  listProcessesByParent,
  markIpcHandshakeOk,
  recordProcessExit,
  recordProcessSpawn,
} from './repos/subagent-processes.ts';
export type {
  InsertSubagentRunInput,
  SubagentRun,
  SubagentScope as SubagentRunScope,
} from './repos/subagent-runs.ts';
export { getSubagentRun, insertSubagentRun } from './repos/subagent-runs.ts';
export type {
  InsertSubagentWorktreeInput,
  SubagentWorktree,
  SubagentWorktreeStatus,
} from './repos/subagent-worktrees.ts';
export {
  getSubagentWorktree,
  insertSubagentWorktree,
  listAllSubagentWorktrees,
  listOnDiskSubagentWorktrees,
  listSubagentWorktreesWithParentCwd,
  markSubagentWorktreeCleaned,
} from './repos/subagent-worktrees.ts';
export type {
  CreateToolCallInput,
  FinishToolCallInput,
  ToolCall,
  ToolCallStatus,
} from './repos/tool-calls.ts';
export {
  createToolCall,
  finishToolCall,
  getToolCall,
  listToolCallsByMessage,
  startToolCall,
} from './repos/tool-calls.ts';
export type { UpdateCheckState } from './repos/update-check.ts';
export { getUpdateCheck, markNotified, recordUpdateProbe } from './repos/update-check.ts';
