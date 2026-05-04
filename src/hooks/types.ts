// Type vocabulary for the hooks subsystem (spec AGENTIC_CLI.md
// §10 + CONTRACTS.md §3 / §10).
//
// Hooks let operators extend agent behavior without forking the
// codebase: each event fires a shell command with JSON-on-stdin
// describing what just happened (or is about to). Exit code
// drives the decision for blocking events:
//   0       allow / continue
//   1       block silent (abort target operation, no message)
//   2       block with message (stdout becomes the reason)
//   3..123  hook error (logged but doesn't block unless
//           `failClosed: true` on the spec)
//   124     timeout sentinel (dispatcher synthesizes; never
//           emitted by the hook process itself)
//   127     command not found
//
// The 9 events fall into two classes per the spec table at line
// 969:
//   - non-blocking: SessionStart, PostToolUse, Notification,
//                   PreCheckpoint, Stop
//   - blocking:     UserPromptSubmit, PreToolUse, PreCompact,
//                   MemoryWrite
// `blockable` on each event variant below is the canonical
// authority — dispatcher inspects it, not a separate config.

// Closed union of supported events. Adding a new event requires
// (a) extending this type, (b) updating the dispatch site in the
// originating subsystem, (c) bumping the schema version if the
// payload shape changes.
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'Notification'
  | 'PreCheckpoint'
  | 'MemoryWrite'
  | 'Stop';

// Events the dispatcher waits on before resuming the originating
// flow. Mirror of the "Pode bloquear?" column in spec §10.1.
export const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PreCompact',
  'MemoryWrite',
]);

// Hierarchy layer for a hook spec. Lower-priority layers cannot
// override sections that a higher-priority layer marked `locked`
// (mirrors `permissions/hierarchy.ts` LockConflict semantics).
// Order of EXECUTION on a single event is enterprise → user →
// project per spec §10 line 1042-1045.
export type HookLayer = 'enterprise' | 'user' | 'project';

// Matcher: filter that limits when a hook fires. Today only the
// `tool` field is honored (matches `event.data.tool` for
// PreToolUse / PostToolUse). Other matcher fields can land later
// without changing the dispatcher contract — unknown fields are
// ignored (forward-compat for newer config files on older
// binaries).
//
// Matching semantics: the matcher is a glob string per spec §10.2
// line 987 (`matcher = { tool = "write_file" }`). We support
// exact-string match and `*` wildcard suffix (`bash*`) — the
// permissions matcher uses the same scheme (`permissions/match.ts`).
export interface HookMatcher {
  tool?: string;
}

// One hook entry from the resolved config, after hierarchy merge.
// Mirrors the TOML `[[hooks]]` shape with provenance attached.
export interface HookSpec {
  // Source layer — surfaced in audit / `/hooks list` so the
  // operator knows which file wrote the rule.
  layer: HookLayer;
  // Path to the originating config file. Used in error messages
  // ("hook at /etc/agent/hooks.toml line 12 timed out").
  sourcePath: string;
  event: HookEvent;
  matcher: HookMatcher;
  // Shell command line (template-expanded against event payload
  // before spawn). Spec §10.2 example: `prettier --write
  // {{tool.input.path}}`.
  command: string;
  // Timeout in milliseconds. Spec §10.3: default 5s, configurable
  // up to 30s, never unlimited. Dispatcher clamps to [100, 30000]
  // — values outside the range are honored as boundary clamp + a
  // warning row.
  timeoutMs: number;
  // When true, an unexpected hook failure (timeout, command not
  // found, exit code > 2) blocks the target operation as if the
  // hook had returned exit 1. Spec §10.3 line 718. Default false.
  failClosed: boolean;
  // Enterprise-only flag: when set, lower-priority layers cannot
  // override or remove this hook. Mirrors permissions `locked:
  // true`. Validated at config-load time; ignored on user/project
  // layers (any locking declaration there is a no-op + warn).
  locked: boolean;
}

// Resolved config for a session — the full ordered list of hooks
// across all layers, plus drift diagnostics.
export interface ResolvedHookConfig {
  // Hooks in execution order: enterprise (in declaration order)
  // → user → project. Within a layer, declaration order is
  // preserved per spec §10 line 1042-1045.
  hooks: readonly HookSpec[];
  // Diagnostics surfaced to the operator at boot — mirrors
  // `permissions/hierarchy.ts` LockConflict pattern. Examples:
  // user-layer locked-flag ignored, project-layer attempted to
  // override an enterprise lock, malformed entry skipped.
  warnings: readonly HookConfigWarning[];
}

export interface HookConfigWarning {
  kind: 'invalid_entry' | 'lock_violation' | 'lock_ignored' | 'unreadable_file';
  layer: HookLayer | null; // null when the file itself is unreadable
  sourcePath: string;
  message: string;
}

// Stable JSON payload sent to a hook on stdin. Schema versioning
// lives at the envelope level so the inner `data` shape can grow
// without breaking older hooks. v1 ships these data shapes per
// originating subsystem; future shape changes bump the version
// and dispatcher writes both versions during a transition window.
export type HookEventPayload =
  | { schema: 'v1'; event: 'SessionStart'; sessionId: string; data: SessionStartData }
  | {
      schema: 'v1';
      event: 'UserPromptSubmit';
      sessionId: string;
      data: UserPromptSubmitData;
    }
  | { schema: 'v1'; event: 'PreToolUse'; sessionId: string; data: ToolUseData }
  | { schema: 'v1'; event: 'PostToolUse'; sessionId: string; data: PostToolUseData }
  | { schema: 'v1'; event: 'PreCompact'; sessionId: string; data: PreCompactData }
  | { schema: 'v1'; event: 'Notification'; sessionId: string; data: NotificationData }
  | { schema: 'v1'; event: 'PreCheckpoint'; sessionId: string; data: PreCheckpointData }
  | { schema: 'v1'; event: 'MemoryWrite'; sessionId: string; data: MemoryWriteData }
  | { schema: 'v1'; event: 'Stop'; sessionId: string; data: StopData };

export interface SessionStartData {
  cwd: string;
  model: string;
  profile: string;
}
export interface UserPromptSubmitData {
  prompt: string;
}
export interface ToolUseData {
  tool: { name: string; input: Record<string, unknown> };
}
export interface PostToolUseData {
  tool: { name: string; input: Record<string, unknown>; output: unknown; failed: boolean };
}
export interface PreCompactData {
  promptTokens: number;
  threshold: number;
}
export interface NotificationData {
  kind: string; // permission_prompt, etc.
  message: string;
}
export interface PreCheckpointData {
  stepN: number;
}
export interface MemoryWriteData {
  scope: 'user' | 'project_local' | 'project_shared';
  name: string;
  source: 'user_explicit' | 'inferred' | 'imported';
  body: string;
}
export interface StopData {
  durationMs: number;
  costUsd: number;
  steps: number;
}

// Discriminated outcome of dispatching a single hook.
// Dispatcher returns this; subsystem maps it onto its own
// blocking decision (see CONTRACTS.md §10 for the per-event
// decision table). Audit row in `hook_runs` is written by
// dispatcher regardless of outcome.
export type HookRunResult =
  | { kind: 'allow'; stdoutTruncated: string; durationMs: number }
  | { kind: 'block_silent'; durationMs: number }
  | { kind: 'block_message'; message: string; durationMs: number }
  | {
      kind: 'error';
      exitCode: number;
      reason: string;
      durationMs: number;
      // True when failClosed=true on the spec — caller treats this
      // as block_silent for blockable events. False = log only.
      shouldBlock: boolean;
    }
  | {
      kind: 'timeout';
      timeoutMs: number;
      // Same failClosed semantic as 'error'.
      shouldBlock: boolean;
    };

// Result of dispatching the chain of hooks for one event. Caller
// maps the aggregate decision per CONTRACTS.md §10 ("primeiro
// hook que retorna `block` interrompe a chain"). Per-hook results
// land in `runs` for audit emission.
export interface HookChainResult {
  // First hook that returned a blocking decision, or null when
  // none did (fire-and-forget for non-blocking events resolves
  // here too).
  blockedBy: { spec: HookSpec; reason: 'silent' | 'message'; message: string | null } | null;
  // All hook runs, in execution order. Dispatcher emits one
  // `hook_runs` audit row per entry.
  runs: ReadonlyArray<{ spec: HookSpec; result: HookRunResult }>;
}

// Default per-event timeout when the spec doesn't override.
// Spec §10.3 line 1005.
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

// Hard ceiling — values above are clamped (with a config-load
// warning). Spec §10.3: "configurável até 30s; nunca ilimitado".
export const MAX_HOOK_TIMEOUT_MS = 30000;

// Lower bound — sub-100ms timeouts are almost certainly typos
// (operator wrote `100` instead of `100000` for ms). Clamping
// down protects the operator's flow from `kill` racing the
// hook's own startup.
export const MIN_HOOK_TIMEOUT_MS = 100;

// Stdout cap per spec §10.3 line 719. Truncated output gets
// `... (truncated)` appended so the audit row makes it visible.
export const HOOK_STDOUT_MAX_BYTES = 4 * 1024;

// Whole-chain timeout for blockable events per CONTRACTS.md §10.
// The chain runs sequentially; this caps the WALL-CLOCK
// duration of the whole sequence. A chain that exceeds it gets
// its remaining hooks skipped + a warning loggged.
export const MAX_HOOK_CHAIN_MS = 15000;
