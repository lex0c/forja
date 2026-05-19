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
// pinContextTool is re-exported (line ~52) but intentionally not
// imported here — see the BUILTIN_TOOLS comment for why it is
// omitted from the default registry.
import { readFileTool } from './read-file.ts';
import { retrieveContextTool } from './retrieve-context.ts';
import { taskAsyncTool } from './task-async.ts';
import { taskAwaitTool } from './task-await.ts';
import { taskCancelTool } from './task-cancel.ts';
import { taskListTool } from './task-list.ts';
import { taskSyncTool, taskTool } from './task.ts';
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
export { pinContextTool } from './pin-context.ts';
export type { PinContextInput, PinContextOutput } from './pin-context.ts';
export type { MonitorInput, MonitorOutput } from './monitor.ts';
export { readFileTool } from './read-file.ts';
export type { ReadFileInput, ReadFileOutput } from './read-file.ts';
export { retrieveContextTool } from './retrieve-context.ts';
export { taskTool, taskSyncTool } from './task.ts';
export type { TaskInput, TaskOutput } from './task.ts';
export { taskAsyncTool } from './task-async.ts';
export type { TaskAsyncInput, TaskAsyncOutput } from './task-async.ts';
export { taskAwaitTool } from './task-await.ts';
export type { TaskAwaitInput, TaskAwaitOutput } from './task-await.ts';
export { taskCancelTool } from './task-cancel.ts';
export type { TaskCancelInput, TaskCancelOutput } from './task-cancel.ts';
export { taskListTool } from './task-list.ts';
export type { TaskListEntry, TaskListInput, TaskListOutput } from './task-list.ts';
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
//
// pinContextTool is intentionally OMITTED from BUILTIN_TOOLS while
// the `confirmPinContext` modal callback is not yet wired through
// the REPL (ModalManager.askPinContext + bus event + renderer are
// the deferred UI slice noted in the Phase 1.1.b/c BACKLOG entries).
// Without the callback, every invocation returns `pin.headless_mode`
// — surfacing the tool to the model would waste a turn proposing
// something that always errors. The export below is preserved so the
// tool test suite still exercises the contract and the harness can
// re-add to BUILTIN_TOOLS in one line when the modal lands.
export const BUILTIN_TOOLS = [
  readFileTool,
  globTool,
  grepTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
  retrieveContextTool,
  waitForTool,
  monitorTool,
  todoWriteTool,
  taskTool,
  taskSyncTool,
  taskAsyncTool,
  taskAwaitTool,
  taskCancelTool,
  taskListTool,
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
