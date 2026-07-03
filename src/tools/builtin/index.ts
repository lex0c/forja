import type { ToolRegistry } from '../registry.ts';
import { bashBackgroundTool } from './bash-background.ts';
import { bashKillTool } from './bash-kill.ts';
import { bashListTool } from './bash-list.ts';
import { bashOutputTool } from './bash-output.ts';
import { bashTool } from './bash.ts';
import { clarifyTool } from './clarify.ts';
import { editFileTool } from './edit-file.ts';
import { fetchUrlTool } from './fetch-url.ts';
import { gitApplyPatchTool } from './git-apply-patch.ts';
import { gitTool } from './git.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { memoryListTool } from './memory-list.ts';
import { memoryReadTool } from './memory-read.ts';
import { memorySearchTool } from './memory-search.ts';
import { memoryWriteTool } from './memory-write.ts';
import { meshPeersTool } from './mesh-peers.ts';
import { meshReplyTool } from './mesh-reply.ts';
import { meshSendTool } from './mesh-send.ts';
import { readFileTool } from './read-file.ts';
import { reminderCancelTool } from './reminder-cancel.ts';
import { reminderListTool } from './reminder-list.ts';
import { reminderTool } from './reminder.ts';
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
import { toolSearchTool } from './tool-search.ts';
import { workingStateUpdateTool } from './working-state-update.ts';
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
export { fetchUrlTool, createFetchUrlTool } from './fetch-url.ts';
export type { FetchUrlInput, FetchUrlOutput } from './fetch-url.ts';
export { gitTool } from './git.ts';
export type { GitInput, GitOutput, GitMode } from './git.ts';
export { gitApplyPatchTool } from './git-apply-patch.ts';
export type { GitApplyPatchInput, GitApplyPatchOutput } from './git-apply-patch.ts';
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
export { meshPeersTool } from './mesh-peers.ts';
export type { MeshPeersInput, MeshPeersOutput } from './mesh-peers.ts';
export { meshReplyTool } from './mesh-reply.ts';
export type { MeshReplyInput, MeshReplyOutput } from './mesh-reply.ts';
export { meshSendTool } from './mesh-send.ts';
export type { MeshSendInput, MeshSendOutput } from './mesh-send.ts';
export { monitorTool } from './monitor.ts';
export { reminderTool } from './reminder.ts';
export type { ReminderInput, ReminderOutput } from './reminder.ts';
export { reminderListTool } from './reminder-list.ts';
export type { ReminderListEntry, ReminderListInput, ReminderListOutput } from './reminder-list.ts';
export { reminderCancelTool } from './reminder-cancel.ts';
export type { ReminderCancelInput, ReminderCancelOutput } from './reminder-cancel.ts';
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
export { toolSearchTool } from './tool-search.ts';
export type { ToolSearchInput } from './tool-search.ts';
export { workingStateUpdateTool } from './working-state-update.ts';
export type {
  WorkingStateUpdateInput,
  WorkingStateUpdateOutput,
} from './working-state-update.ts';
export { waitForTool } from './wait-for.ts';
export type { WaitForInput, WaitForOutput } from './wait-for.ts';
export { writeFileTool } from './write-file.ts';
export type { WriteFileInput, WriteFileOutput } from './write-file.ts';

// Order is intentional: read-only tools first, then writes, then exec.
// Useful when scanning a `forja --list-tools` output. The todo tools
// (todo_list / todo_get / todo_create / todo_update) sit with the
// read-only group — their 'write' is harness-internal session state,
// not external mutation. memory_list / read / search are
// read-only (audit logs are internal); memory_write sits with the
// other write tools because it persists to disk and is gated by
// the operator confirm modal.
export const BUILTIN_TOOLS = [
  readFileTool,
  globTool,
  grepTool,
  gitTool,
  memoryListTool,
  memoryReadTool,
  memorySearchTool,
  retrieveContextTool,
  skillListTool,
  skillShowTool,
  skillInvokeTool,
  // tool_search — reveals deferred tools (AGENTIC_CLI §7.6). Read-only
  // discovery; always visible (it's how the model reaches the deferred set).
  toolSearchTool,
  // Mesh tools (MESH.md §9): mesh_peers discovers serving peers (read-only),
  // mesh_send delivers a textual request to one (egress, confirm per call).
  // Both deferred — reached via tool_search, off the base surface.
  meshPeersTool,
  meshReplyTool,
  meshSendTool,
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
  // working_state_update — the session operational panel (WORKING_STATE.md).
  // Sits with the internal-state group: its 'write' is harness-internal,
  // in-memory, session-scoped, never an external mutation.
  workingStateUpdateTool,
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
  gitApplyPatchTool,
  memoryWriteTool,
  // pin_context is intentionally NOT registered: an ad-hoc "pin this
  // text" tool proved a confusion magnet for weaker models, which
  // pinned the re-injected guidance block (and verbalized accepting it)
  // instead of answering the operator. The tool module, its re-exports
  // below, the `/pin` operator command, and the context_pins store stay
  // intact — only the model-facing surface is withdrawn (mirrors the
  // wait_for / monitor withdrawal). Compaction-fragile facts now route
  // through working_state / todos (in-session) and memory_write (cross).
  bashTool,
  bashBackgroundTool,
  bashOutputTool,
  bashKillTool,
  bashListTool,
  // fetch_url — network egress (web.fetch). Deferred (§7.6): reached via
  // tool_search, not on the base surface. Gated by the existing fetch
  // resolver + FetchPolicy (SECURITY_GUIDELINE.md §9.1).
  fetchUrlTool,
  // reminder family (CONTRACTS §2.6.5f / §2.6.10): the clock-driven
  // producer of the notification channel — palette set/list/cancel.
  reminderTool,
  reminderListTool,
  reminderCancelTool,
] as const;

export const registerBuiltinTools = (reg: ToolRegistry): void => {
  for (const tool of BUILTIN_TOOLS) {
    reg.register(tool);
  }
};
