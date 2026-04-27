export { MEMORY_DB, openDb, openMemoryDb, withTransaction } from './db.ts';
export type { DB } from './db.ts';

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
