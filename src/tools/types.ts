import type { BgManager } from '../bg/index.ts';
import type { Decision, PermissionsView, PolicyCategory, ToolArgs } from '../permissions/index.ts';
import type { ProviderToolInputSchema } from '../providers/index.ts';

// Per CONTRACTS §2: tool errors are *data*, not exceptions. The harness
// catches stray throws and converts them, but tools are expected to
// surface known failure modes via this shape.
export interface ToolError {
  is_error: true;
  error_code: string;
  error_message: string;
  retryable: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}

export type ToolResult<O> = O | ToolError;

export const isToolError = <O>(r: ToolResult<O>): r is ToolError =>
  typeof r === 'object' && r !== null && (r as ToolError).is_error === true;

// Display hints from CONTRACTS §2 cláusula 7. Pure metadata for the UI;
// the harness ignores them.
export type DisplayHint = 'table' | 'list' | 'diff' | 'raw' | 'auto';

export interface ToolMetadata {
  category: PolicyCategory;
  // Side effect declarations. `writes: true` triggers checkpoint creation
  // in the harness (Step 5+).
  writes: boolean;
  // Plan-mode predicate. When the harness is in plan mode and
  // the tool has `writes: true`, this decides per-invocation
  // whether the call may proceed. Three forms:
  //   - omitted: every invocation blocked in plan mode (default
  //     for write_file/edit_file — they ALWAYS mutate, the gate
  //     here IS bullet-proof).
  //   - `true`: every invocation allowed regardless of args.
  //     Equivalent to "plan mode trusts this tool unconditionally".
  //   - function: per-call predicate that inspects args. The
  //     canonical case is `bash` — it CAN write, but the model
  //     declares intent via `args.read_only`. Boolean-only would
  //     either block legitimate inspections (git status, ls, cat)
  //     or silently allow `echo x > file`. The predicate lets the
  //     tool author encode the rule that `read_only === true` is
  //     the gate.
  //
  // IMPORTANT: the predicate form is best-effort, NOT a security
  // boundary. It catches honest models that forget to declare
  // intent. It does NOT catch confused or adversarial models that
  // declare `read_only: true` while sending `echo x > file` —
  // observed in practice (M2 / Step 6.5 baseline). Real protection
  // for adversarial inputs requires sandbox (spec §9.1, M3+).
  // The `writes: true` + omitted-predicate combo IS bullet-proof
  // because the harness never executes the tool. Use that for
  // tools that should never run in plan mode period.
  planSafe?: boolean | ((args: Record<string, unknown>) => boolean);
  network?: boolean;
  exec?: boolean;
  idempotent: boolean;
  display?: DisplayHint;
  // Optional cost hints; informational only in M1.
  cost?: {
    latency_ms_typical?: number;
    max_output_bytes?: number;
  };
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  sessionId: string;
  stepId: string;
  permissions: PermissionsView;
  // Background process manager for the current session. Optional so
  // existing tools that don't need bg orchestration aren't forced to
  // declare a dependency. Tools that DO need it (`bash_background`,
  // `bash_output`, `bash_kill`) surface a clean error when absent
  // rather than dereferencing undefined.
  bgManager?: BgManager;
  // Per-call permission predicate. The harness wires this to
  // `permissionEngine.check`. Tools whose category gate is too coarse
  // for their actual side effects (notably `wait_for` and `monitor`,
  // which are category='misc' but do fs/network probes per leaf
  // condition) call this before each gated leaf to enforce the
  // existing fs/web policy sections. REQUIRED — making it optional
  // would silently re-introduce the misc-bypass any time a future
  // entrypoint constructs a ToolContext without going through the
  // harness loop. Tests inject an explicit allow-all (or a custom
  // predicate to exercise deny paths) via makeCtx.
  permissionCheck: (toolName: string, category: PolicyCategory, args: ToolArgs) => Decision;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  outputSchema?: object;
  metadata: ToolMetadata;
  execute(args: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

// Standard error codes used across builtins. Centralized so failure modes
// are enumerable (CONTRACTS §2.5 criterion 5).
export const ERROR_CODES = {
  notFound: 'fs.not_found',
  isDirectory: 'fs.is_directory',
  notDirectory: 'fs.not_directory',
  readFailed: 'fs.read_failed',
  writeFailed: 'fs.write_failed',
  invalidPath: 'fs.invalid_path',
  ambiguousMatch: 'edit.ambiguous_match',
  oldStringNotFound: 'edit.old_string_not_found',
  oldEqualsNew: 'edit.old_equals_new',
  oldStringEmpty: 'edit.old_string_empty',
  globPatternEscapes: 'glob.pattern_escapes_root',
  invalidArg: 'tool.invalid_arg',
  bashTimeout: 'bash.timeout',
  bashSpawnFailed: 'bash.spawn_failed',
  ripgrepMissing: 'grep.ripgrep_missing',
  ripgrepFailed: 'grep.ripgrep_failed',
  aborted: 'tool.aborted',
  // Tools whose category gate is too coarse for their actual side
  // effects (wait_for / monitor) self-gate per leaf condition and
  // surface this code when the policy denies a leaf. Distinct from
  // the harness-level deny (which short-circuits before tool.execute
  // runs and uses the model-facing `tool_decided` event).
  permissionDenied: 'permission.denied',
} as const;

export const toolError = (
  code: string,
  message: string,
  options: { retryable?: boolean; hint?: string; details?: Record<string, unknown> } = {},
): ToolError => ({
  is_error: true,
  error_code: code,
  error_message: message,
  retryable: options.retryable ?? false,
  ...(options.hint !== undefined ? { hint: options.hint } : {}),
  ...(options.details !== undefined ? { details: options.details } : {}),
});
