import type { ToolRegistry } from '../registry.ts';
import { bashBackgroundTool } from './bash-background.ts';
import { bashKillTool } from './bash-kill.ts';
import { bashOutputTool } from './bash-output.ts';
import { bashTool } from './bash.ts';
import { editFileTool } from './edit-file.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { memoryListTool } from './memory-list.ts';
import { memoryReadTool } from './memory-read.ts';
import { memorySearchTool } from './memory-search.ts';
import { memoryWriteTool } from './memory-write.ts';
import { monitorTool } from './monitor.ts';
import { readFileTool } from './read-file.ts';
import { taskAsyncTool } from './task-async.ts';
import { taskAwaitTool } from './task-await.ts';
import { taskCancelTool } from './task-cancel.ts';
import { taskTool } from './task.ts';
import { todoWriteTool } from './todo-write.ts';
import { waitForTool } from './wait-for.ts';
import { writeFileTool } from './write-file.ts';

export { bashTool } from './bash.ts';
export type { BashInput, BashOutput } from './bash.ts';
export { bashBackgroundTool } from './bash-background.ts';
export type { BashBackgroundInput, BashBackgroundOutput } from './bash-background.ts';
export { bashKillTool } from './bash-kill.ts';
export type { BashKillInput, BashKillOutput } from './bash-kill.ts';
export { bashOutputTool } from './bash-output.ts';
export type { BashOutputInput, BashOutputOutput } from './bash-output.ts';
export { editFileTool } from './edit-file.ts';
export type { EditFileInput, EditFileOutput } from './edit-file.ts';
export { globTool } from './glob.ts';
export type { GlobInput, GlobOutput } from './glob.ts';
export { grepTool } from './grep.ts';
export type { GrepInput, GrepMatch, GrepOutput } from './grep.ts';
export { memoryListTool } from './memory-list.ts';
export type { MemoryListEntry, MemoryListInput, MemoryListOutput } from './memory-list.ts';
export { memoryReadTool } from './memory-read.ts';
export type { MemoryReadInput, MemoryReadOutput } from './memory-read.ts';
export { memorySearchTool } from './memory-search.ts';
export type {
  MemorySearchHitOutput,
  MemorySearchInput,
  MemorySearchOutput,
} from './memory-search.ts';
export { memoryWriteTool } from './memory-write.ts';
export type { MemoryWriteInput, MemoryWriteOutput } from './memory-write.ts';
export { monitorTool } from './monitor.ts';
export type { MonitorInput, MonitorOutput } from './monitor.ts';
export { readFileTool } from './read-file.ts';
export type { ReadFileInput, ReadFileOutput } from './read-file.ts';
export { taskTool } from './task.ts';
export type { TaskInput, TaskOutput } from './task.ts';
export { taskAsyncTool } from './task-async.ts';
export type { TaskAsyncInput, TaskAsyncOutput } from './task-async.ts';
export { taskAwaitTool } from './task-await.ts';
export type { TaskAwaitInput, TaskAwaitOutput } from './task-await.ts';
export { taskCancelTool } from './task-cancel.ts';
export type { TaskCancelInput, TaskCancelOutput } from './task-cancel.ts';
export { todoWriteTool } from './todo-write.ts';
export type { TodoWriteInput, TodoWriteItem, TodoWriteOutput } from './todo-write.ts';
export { waitForTool } from './wait-for.ts';
export type { WaitForInput, WaitForOutput } from './wait-for.ts';
export { writeFileTool } from './write-file.ts';
export type { WriteFileInput, WriteFileOutput } from './write-file.ts';

// Order is intentional: read-only tools first, then writes, then exec.
// Useful when scanning a `agent --list-tools` output. todo_write
// sits with the read-only group — its 'write' is harness-internal
// state, not external mutation. memory_list / read / search are
// read-only (audit logs are internal); memory_write sits with the
// other write tools because it persists to disk and is gated by
// plan mode + operator confirm modal.
export const BUILTIN_TOOLS = [
  readFileTool,
  globTool,
  grepTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
  waitForTool,
  monitorTool,
  todoWriteTool,
  taskTool,
  taskAsyncTool,
  taskAwaitTool,
  taskCancelTool,
  writeFileTool,
  editFileTool,
  memoryWriteTool,
  bashTool,
  bashBackgroundTool,
  bashOutputTool,
  bashKillTool,
] as const;

export const registerBuiltinTools = (reg: ToolRegistry): void => {
  for (const tool of BUILTIN_TOOLS) {
    reg.register(tool);
  }
};
