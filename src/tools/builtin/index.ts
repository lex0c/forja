import type { ToolRegistry } from '../registry.ts';
import { bashBackgroundTool } from './bash-background.ts';
import { bashKillTool } from './bash-kill.ts';
import { bashListTool } from './bash-list.ts';
import { bashOutputTool } from './bash-output.ts';
import { bashTool } from './bash.ts';
import { clarifyTool } from './clarify.ts';
import { editFileTool } from './edit-file.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { memoryListTool } from './memory-list.ts';
import { memoryReadTool } from './memory-read.ts';
import { memorySearchTool } from './memory-search.ts';
import { memoryWriteTool } from './memory-write.ts';
import { pinContextTool } from './pin-context.ts';
import { readFileTool } from './read-file.ts';
import { retrieveContextTool } from './retrieve-context.ts';
import { skillInvokeTool } from './skill-invoke.ts';
import { skillListTool } from './skill-list.ts';
import { skillShowTool } from './skill-show.ts';
import { taskAsyncTool } from './task-async.ts';
import { taskAwaitTool } from './task-await.ts';
import { taskCancelTool } from './task-cancel.ts';
import { taskListTool } from './task-list.ts';
import { taskSyncTool, taskTool } from './task.ts';
import { todoClearTool } from './todo-clear.ts';
import { todoCreateTool } from './todo-create.ts';
import { todoGetTool } from './todo-get.ts';
import { todoListTool } from './todo-list.ts';
import { todoUpdateTool } from './todo-update.ts';
import { writeFileTool } from './write-file.ts';

export { bashTool } from './bash.ts';
export type { BashInput, BashOutput } from './bash.ts';
export { bashBackgroundTool } from './bash-background.ts';
export type { BashBackgroundInput, BashBackgroundOutput } from './bash-background.ts';
export { bashKillTool } from './bash-kill.ts';
export type { BashKillInput, BashKillOutput } from './bash-kill.ts';
export { bashOutputTool } from './bash-output.ts';
export type { BashOutputInput, BashOutputOutput } from './bash-output.ts';
export { bashListTool } from './bash-list.ts';
export type { BashListEntry, BashListInput, BashListOutput } from './bash-list.ts';
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
export { clarifyTool } from './clarify.ts';
export type { ClarifyInput, ClarifyOption, ClarifyOutput } from './clarify.ts';
export type { MonitorInput, MonitorOutput } from './monitor.ts';
export { readFileTool } from './read-file.ts';
export type { ReadFileInput, ReadFileOutput } from './read-file.ts';
export { retrieveContextTool } from './retrieve-context.ts';
export { skillInvokeTool } from './skill-invoke.ts';
export type { SkillInvokeInput, SkillInvokeOutput } from './skill-invoke.ts';
export { skillListTool } from './skill-list.ts';
export type { SkillListEntry, SkillListInput, SkillListOutput } from './skill-list.ts';
export { skillShowTool } from './skill-show.ts';
export type { SkillShowInput, SkillShowOutput } from './skill-show.ts';
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
export { todoClearTool } from './todo-clear.ts';
export type { TodoClearInput, TodoClearOutput } from './todo-clear.ts';
export { todoCreateTool } from './todo-create.ts';
export type { TodoCreateInput, TodoCreateInputItem, TodoCreateOutput } from './todo-create.ts';
export { todoGetTool } from './todo-get.ts';
export type { TodoGetInput, TodoGetOutput } from './todo-get.ts';
export { todoListTool } from './todo-list.ts';
export type { TodoListInput, TodoListOutput } from './todo-list.ts';
export { todoUpdateTool } from './todo-update.ts';
export type { TodoUpdateInput, TodoUpdateOutput } from './todo-update.ts';
export type { TodoWireItem } from './todo-shared.ts';
export { waitForTool } from './wait-for.ts';
export type { WaitForInput, WaitForOutput } from './wait-for.ts';
export { writeFileTool } from './write-file.ts';
export type { WriteFileInput, WriteFileOutput } from './write-file.ts';

// Order is intentional: read-only tools first, then writes, then exec.
// Useful when scanning a `agent --list-tools` output. The todo tools
// (todo_list / todo_get / todo_create / todo_update) sit with the
// read-only group — their 'write' is harness-internal session state,
// not external mutation. memory_list / read / search are
// read-only (audit logs are internal); memory_write sits with the
// other write tools because it persists to disk and is gated by
// the operator confirm modal.
//
// pinContextTool sits with the write tools — it persists to SQLite
// (context_pins). No modal: the model pins directly and the store
// ring-buffers at PIN_CAP (oldest evicted), same shape as the todolist.
export const BUILTIN_TOOLS = [
  readFileTool,
  globTool,
  grepTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
  retrieveContextTool,
  skillListTool,
  skillShowTool,
  skillInvokeTool,
  // wait_for / monitor are intentionally NOT registered: the model
  // should not see or call them. The tool modules, their re-exports
  // below, and the underlying `src/wait/` subsystem stay intact —
  // they remain importable for internal use and tests; only the
  // model-facing surface is withdrawn.
  todoListTool,
  todoGetTool,
  todoCreateTool,
  todoUpdateTool,
  todoClearTool,
  // clarify — core anti-presumption tool (CONTRACTS §2.6.5e). Not a
  // write/exec; its modal bridge (ctx.clarify) is wired in the REPL.
  clarifyTool,
  taskTool,
  taskSyncTool,
  taskAsyncTool,
  taskAwaitTool,
  taskCancelTool,
  taskListTool,
  writeFileTool,
  editFileTool,
  memoryWriteTool,
  pinContextTool,
  bashTool,
  bashBackgroundTool,
  bashOutputTool,
  bashKillTool,
  bashListTool,
] as const;

export const registerBuiltinTools = (reg: ToolRegistry): void => {
  for (const tool of BUILTIN_TOOLS) {
    reg.register(tool);
  }
};
