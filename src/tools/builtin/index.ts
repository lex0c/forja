import type { ToolRegistry } from '../registry.ts';
import { bashBackgroundTool } from './bash-background.ts';
import { bashKillTool } from './bash-kill.ts';
import { bashOutputTool } from './bash-output.ts';
import { bashTool } from './bash.ts';
import { editFileTool } from './edit-file.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { importsOfTool } from './imports-of.ts';
import { monitorTool } from './monitor.ts';
import { outlineFileTool } from './outline-file.ts';
import { readFileTool } from './read-file.ts';
import { readSymbolTool } from './read-symbol.ts';
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
export { importsOfTool } from './imports-of.ts';
export type { ImportEdge, ImportsOfInput, ImportsOfOutput } from './imports-of.ts';
export { monitorTool } from './monitor.ts';
export type { MonitorInput, MonitorOutput } from './monitor.ts';
export { outlineFileTool } from './outline-file.ts';
export type { OutlineFileInput, OutlineFileOutput, OutlineFileSymbol } from './outline-file.ts';
export { readFileTool } from './read-file.ts';
export type { ReadFileInput, ReadFileOutput } from './read-file.ts';
export { readSymbolTool } from './read-symbol.ts';
export type { ReadSymbolInput, ReadSymbolOutput } from './read-symbol.ts';
export { taskTool } from './task.ts';
export type { TaskInput, TaskOutput } from './task.ts';
export { todoWriteTool } from './todo-write.ts';
export type { TodoWriteInput, TodoWriteItem, TodoWriteOutput } from './todo-write.ts';
export { waitForTool } from './wait-for.ts';
export type { WaitForInput, WaitForOutput } from './wait-for.ts';
export { writeFileTool } from './write-file.ts';
export type { WriteFileInput, WriteFileOutput } from './write-file.ts';

// Order is intentional: read-only tools first, then writes, then exec.
// Useful when scanning a `agent --list-tools` output. todo_write
// sits with the read-only group — its 'write' is harness-internal
// state, not external mutation.
export const BUILTIN_TOOLS = [
  readFileTool,
  readSymbolTool,
  outlineFileTool,
  importsOfTool,
  globTool,
  grepTool,
  waitForTool,
  monitorTool,
  todoWriteTool,
  taskTool,
  writeFileTool,
  editFileTool,
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
