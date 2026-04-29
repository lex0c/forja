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
  createSession,
  getSession,
  listSessions,
  updateSessionCost,
} from './repos/sessions.ts';
export type {
  CreateSessionInput,
  ListSessionsOptions,
  Session,
  SessionStatus,
} from './repos/sessions.ts';

export { appendMessage, getMessage, listMessagesBySession } from './repos/messages.ts';
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
  advanceBgProcessCursor,
  finalizeBgProcess,
  getBgProcess,
  insertBgProcess,
  listBgProcessesBySession,
  markRunningAsKilled,
} from './repos/bg-processes.ts';
export type {
  BgProcess,
  BgProcessStatus,
  FinalizeBgProcessInput,
  InsertBgProcessInput,
  ListBgProcessesFilter,
} from './repos/bg-processes.ts';
