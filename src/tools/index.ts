export type {
  DisplayHint,
  Tool,
  ToolContext,
  ToolError,
  ToolMetadata,
  ToolResult,
} from './types.ts';
export { ERROR_CODES, isToolError, toolError } from './types.ts';

export { createToolRegistry } from './registry.ts';
export type { ToolRegistry } from './registry.ts';

export {
  BUILTIN_TOOLS,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  registerBuiltinTools,
  todoWriteTool,
  writeFileTool,
} from './builtin/index.ts';
export type {
  BashInput,
  BashOutput,
  EditFileInput,
  EditFileOutput,
  GlobInput,
  GlobOutput,
  GrepInput,
  GrepMatch,
  GrepOutput,
  ReadFileInput,
  ReadFileOutput,
  TodoWriteInput,
  TodoWriteItem,
  TodoWriteOutput,
  WriteFileInput,
  WriteFileOutput,
} from './builtin/index.ts';
