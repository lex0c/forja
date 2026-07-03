// Per-tool display vocabulary. Spec UI.md §4.10.3-4.
//
// Maps each tool's internal name (`read_file`, `bash`, …) to the verbs
// the operation chip shows in active vs final states, plus a subject
// extractor that pulls the salient argument (path, command, query)
// out of the args object for the `└─` sub-content line.
//
// The TUI never sees raw JSON args by default; the adapter pre-resolves
// verb + subject via `lookupToolVocab` and emits them in `tool:start`.
// Tools without an entry fall back to `Calling <name>` / `Called <name>`
// with no subject — intentionally generic so the gap is visible to
// reviewers (add a vocab entry alongside the new tool registration).
//
// Subject extractors return `null` when args don't match the expected
// shape (malformed model output, missing field). Producers should drop
// the sub-content line in that case rather than render `null` literally.

export interface ToolVocab {
  // Present-continuous form shown while the tool runs:
  // `* Reading file…  [1.2s]`. No trailing ellipsis here — the renderer
  // appends it.
  activeVerb: string;
  // Past-tense form shown after the tool finishes successfully:
  // `* Read file`. Failure / denial states use generic verbs
  // (`Failed`, `Denied`) regardless of the per-tool entry.
  finalVerb: string;
  // Pulls the one-line subject out of the args object — typically the
  // path, command, query, or pid the tool acted on. Renderer formats
  // it under `└─ `. Return `null` when args don't carry the field
  // (malformed args from a misbehaving model, etc.).
  subject?: (args: Record<string, unknown>) => string | null;
  // When true, the adapter still TRACKS the call but emits NO operation
  // chip (no tool:start / tool:execution-started / tool:end). Used by the
  // todo tools: their effect is the live `Tasks` block, so the per-call
  // chips are pure scrollback noise. The tool still runs and its result
  // still reaches the model — only the chip is hidden.
  silent?: boolean;
  // For a `silent` tool: still surface a scrollback chip when the call
  // FAILS (status !== 'done'). The task_* delegation tools set this. A
  // silent SUCCESS is represented by the live `Subagents` block, but a
  // delegation that fails BEFORE a child is created (unknown playbook,
  // validation error, pre-spawn budget refusal) emits no subagent
  // lifecycle for that block to show — fully suppressing its failure chip
  // too would make the failed delegation invisible in scrollback. (A
  // post-spawn child failure also surfaces here AND in the block: the
  // chip carries the tool-level reason, complementary to the block's run
  // summary, and erring toward visible beats silently dropping it.) Todos
  // deliberately do NOT set this — their failures surface in the model's
  // prose + the live `Tasks` block.
  revealFailure?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

// Pull a string field out of a nested object — used by tools that
// take a discriminated-union arg (`monitor.condition`, `wait_for.
// condition`). Returns null when the parent isn't an object or the
// field isn't a non-empty string.
const nestedStr = (parent: unknown, field: string): string | null => {
  if (typeof parent !== 'object' || parent === null) return null;
  return str((parent as Record<string, unknown>)[field]);
};

export const TOOL_VOCAB: Readonly<Record<string, ToolVocab>> = {
  // clarify asks the operator one question and settles when answered. The
  // question→answer text rides the `└─` connector via the tool's
  // resultDetail (harness-adapter), so there's deliberately NO subject here.
  clarify: {
    activeVerb: 'Asking',
    finalVerb: 'Question answered',
  },
  pin_context: {
    activeVerb: 'Pinning context',
    finalVerb: 'Pinned context',
    subject: (a) => str(a.text),
  },
  fetch_url: {
    activeVerb: 'Fetching',
    finalVerb: 'Fetched',
    subject: (a) => str(a.url),
  },
  mesh_peers: {
    activeVerb: 'Listing',
    finalVerb: 'Listed',
    subject: () => 'mesh peers',
  },
  mesh_reply: {
    activeVerb: 'Replying',
    finalVerb: 'Replied',
    subject: () => 'mesh peer',
  },
  mesh_send: {
    activeVerb: 'Sending',
    finalVerb: 'Sent',
    subject: (a) => str(a.peer),
  },
  read_file: {
    activeVerb: 'Reading file',
    finalVerb: 'Read file',
    subject: (a) => str(a.path),
  },
  write_file: {
    activeVerb: 'Writing file',
    finalVerb: 'Wrote file',
    subject: (a) => str(a.path),
  },
  edit_file: {
    activeVerb: 'Editing file',
    finalVerb: 'Edited file',
    subject: (a) => str(a.path),
  },
  git_apply_patch: {
    activeVerb: 'Applying patch',
    finalVerb: 'Applied patch',
    subject: (a) => str(a.path),
  },
  bash: {
    activeVerb: 'Executing',
    finalVerb: 'Executed',
    subject: (a) => str(a.command),
  },
  bash_background: {
    activeVerb: 'Spawning',
    finalVerb: 'Spawned',
    subject: (a) => str(a.command),
  },
  bash_output: {
    activeVerb: 'Polling process',
    finalVerb: 'Polled process',
    // The bg manager identifies processes by id; show that as the
    // subject so the operator can correlate with `bg:start` events.
    subject: (a) => {
      const pid = str(a.process_id);
      return pid !== null ? `pid ${pid}` : null;
    },
  },
  bash_kill: {
    activeVerb: 'Killing process',
    finalVerb: 'Killed process',
    subject: (a) => {
      const pid = str(a.process_id);
      return pid !== null ? `pid ${pid}` : null;
    },
  },
  glob: {
    activeVerb: 'Globbing',
    finalVerb: 'Globbed',
    subject: (a) => str(a.pattern),
  },
  grep: {
    activeVerb: 'Grepping',
    finalVerb: 'Grepped',
    subject: (a) => str(a.pattern),
  },
  git: {
    activeVerb: 'Running git',
    finalVerb: 'Ran git',
    // Show WHAT ran, not a bare `git`: `<mode> [--stat/--staged] [<ref>]
    // [<path>]`. So the chip reads `Ran git · log src/foo.ts` /
    // `Ran git · diff --staged` / `Ran git · show_file v1 old.ts`.
    subject: (a) => {
      const mode = str(a.mode);
      if (mode === null) return null;
      const parts = [mode];
      if (a.stat === true) parts.push('--stat');
      if (a.staged === true) parts.push('--staged');
      const ref = str(a.ref);
      if (ref !== null) parts.push(ref);
      const path = str(a.path);
      if (path !== null) parts.push(path);
      return parts.join(' ');
    },
  },
  // `task` is the VISIBLE legacy alias of the deferred `task_sync` (same
  // dispatcher, byte-identical wire — src/tools/builtin/task.ts §3.1). Since
  // `task_sync` is deferred, `task` is the name the model actually invokes, so
  // it MUST carry the same `silent`/`revealFailure` as the rest of the task_*
  // family: the operator's view of a subagent is the live `Subagents` block,
  // and a `Delegating · <name>` card stacked next to it is the exact redundant
  // noise the silence was meant to kill. Marking only `task_sync` left the
  // common path un-silenced. Verbs kept for the `revealFailure` chip (a
  // delegation that dies before its child exists has no Subagents block to
  // appear in) and the day someone flips silent off.
  task: {
    // Verb stays bare — the subject already carries the agent name;
    // saying "Delegating to subagent / └─ reviewer" duplicates
    // "subagent" without adding info. Reads as "Delegating · reviewer".
    activeVerb: 'Delegating',
    finalVerb: 'Delegated',
    silent: true,
    revealFailure: true,
    // Real tool fields per src/tools/builtin/task.ts: `subagent`
    // (agent name) and `prompt` (goal text). Prefer the name —
    // shorter, more useful at a glance. Fall back to prompt for the
    // goal's first line when name is missing.
    subject: (a) => str(a.subagent) ?? str(a.prompt),
  },
  memory_list: {
    activeVerb: 'Listing memory',
    finalVerb: 'Listed memory',
    subject: (a) => {
      const scope = str(a.scope);
      return scope !== null ? `scope: ${scope}` : null;
    },
  },
  memory_read: {
    activeVerb: 'Reading memory',
    finalVerb: 'Read memory',
    subject: (a) => str(a.name) ?? str(a.path),
  },
  memory_search: {
    activeVerb: 'Searching memory',
    finalVerb: 'Searched memory',
    subject: (a) => str(a.query),
  },
  memory_write: {
    // Active verb says "proposing" because the tool only opens a
    // confirm modal at this stage — nothing has hit disk yet. The
    // final verb flips to "Wrote memory" on yes / "Skipped memory"
    // — but the chip vocabulary is fixed per-tool and doesn't
    // branch on the outcome (consistent with the rest of the
    // table); the renderer surfaces the actual result via the
    // tool's output envelope.
    activeVerb: 'Proposing memory',
    finalVerb: 'Proposed memory',
    subject: (a) => {
      const scope = str(a.scope);
      const name = str(a.name);
      if (scope !== null && name !== null) return `${scope}/${name}`;
      return name ?? scope;
    },
  },
  // working_state_update mutates the session's working-state panel. Its
  // per-call chip is noise like the todo tools' — but unlike todos there is no
  // live panel block, so on SUCCESS the `working_state_updated` event renders
  // the current panel as a scrollback `info` block (render/working-state.ts)
  // and this chip stays silent. `revealFailure` surfaces a failure chip (with
  // the reason) when the update is rejected: the success event never fires on a
  // failed update, so without it an error would be fully invisible.
  working_state_update: {
    activeVerb: 'Updating working state',
    finalVerb: 'Updated working state',
    silent: true,
    revealFailure: true,
  },
  // The todo tools are `silent`: the adapter tracks each call but emits no
  // chip. The operator's view of todos is the live `Tasks` block; the
  // per-call chips ("Added todos", "Updated todo", …) are just noise. The
  // verbs stay for the day someone flips silent off.
  todo_clear: {
    activeVerb: 'Clearing todos',
    finalVerb: 'Cleared todos',
    silent: true,
  },
  todo_create: {
    activeVerb: 'Adding todos',
    finalVerb: 'Added todos',
    silent: true,
  },
  todo_update: {
    activeVerb: 'Updating todo',
    finalVerb: 'Updated todo',
    subject: (a) => str(a.id),
    silent: true,
  },
  todo_list: {
    activeVerb: 'Listing todos',
    finalVerb: 'Listed todos',
    silent: true,
  },
  todo_get: {
    activeVerb: 'Reading todo',
    finalVerb: 'Read todo',
    subject: (a) => str(a.id),
    silent: true,
  },
  // The task_* subagent-orchestration tools are `silent`: spawning,
  // awaiting, cancelling and listing subagents is plumbing the operator
  // shouldn't see as a tool chip. The operator's view of a subagent is the
  // live `Subagents` block (and its grouped scrollback summary on end) —
  // `task_sync`/`task_async`'s own "Calling task_sync" / "Called task_sync"
  // card is redundant noise stacked next to that block. The adapter still
  // tracks the call (so the per-tool machinery stays intact); it just emits
  // no chip on success. Verbs kept for the day someone flips silent off —
  // and used NOW to render the failure chip `revealFailure` surfaces (a
  // delegation that fails before its child exists has no Subagents block to
  // appear in, so its failure must not vanish with the success chip).
  task_sync: {
    activeVerb: 'Running subagent',
    finalVerb: 'Ran subagent',
    silent: true,
    revealFailure: true,
  },
  task_async: {
    activeVerb: 'Spawning subagent',
    finalVerb: 'Spawned subagent',
    silent: true,
    revealFailure: true,
  },
  task_await: {
    activeVerb: 'Awaiting subagent',
    finalVerb: 'Awaited subagent',
    silent: true,
    revealFailure: true,
  },
  task_cancel: {
    activeVerb: 'Cancelling subagent',
    finalVerb: 'Cancelled subagent',
    silent: true,
    revealFailure: true,
  },
  task_list: {
    activeVerb: 'Listing subagents',
    finalVerb: 'Listed subagents',
    silent: true,
    revealFailure: true,
  },
  monitor: {
    activeVerb: 'Monitoring',
    finalVerb: 'Monitored',
    // Real shape: `{condition: {kind: 'process_output_lines',
    // process_id, ...}, duration_ms}`. Subject surfaces the kind —
    // generic across the discriminated-union arms; rich detail
    // (which pid / which file) is for the (future) expansion view.
    subject: (a) => {
      const kind = nestedStr(a.condition, 'kind');
      return kind !== null ? `kind: ${kind}` : null;
    },
  },
  wait_for: {
    activeVerb: 'Waiting',
    finalVerb: 'Waited',
    // Real shape: `{condition: {kind: 'sleep' | 'file_exists' | ...,
    // ...}, timeout_ms}`. Same generic kind-based subject as monitor.
    subject: (a) => {
      const kind = nestedStr(a.condition, 'kind');
      return kind !== null ? `kind: ${kind}` : null;
    },
  },
  // Background-process inventory (`bash_list`); like the other list tools it
  // surfaces a chip, with the optional status filter as the subject.
  bash_list: {
    activeVerb: 'Listing processes',
    finalVerb: 'Listed processes',
    subject: (a) => {
      const s = str(a.status);
      return s !== null ? `status: ${s}` : null;
    },
  },
  // Reminders subsystem. The note is the salient subject for `reminder`; the id
  // for a cancel; the list has no subject.
  reminder: {
    activeVerb: 'Setting reminder',
    finalVerb: 'Set reminder',
    subject: (a) => str(a.note),
  },
  reminder_cancel: {
    activeVerb: 'Cancelling reminder',
    finalVerb: 'Cancelled reminder',
    subject: (a) => str(a.reminder_id),
  },
  reminder_list: {
    activeVerb: 'Listing reminders',
    finalVerb: 'Listed reminders',
  },
  // Context retrieval (memory/guide bodies). The query is the subject.
  retrieve_context: {
    activeVerb: 'Retrieving context',
    finalVerb: 'Retrieved context',
    subject: (a) => str(a.query),
  },
  // Skills. `invoke` runs one (and the model follows the body); `show` prints a
  // body without running it; `list` enumerates the catalog. The skill NAME is
  // the salient subject so the chip reads `Invoked skill · review-diff` rather
  // than the contentless `Called skill_invoke`.
  skill_invoke: {
    activeVerb: 'Invoking skill',
    finalVerb: 'Invoked skill',
    subject: (a) => str(a.name),
  },
  skill_show: {
    activeVerb: 'Reading skill',
    finalVerb: 'Read skill',
    subject: (a) => str(a.name),
  },
  skill_list: {
    activeVerb: 'Listing skills',
    finalVerb: 'Listed skills',
    subject: (a) => {
      const s = str(a.scope);
      return s !== null ? `scope: ${s}` : null;
    },
  },
  // tool_search reveals deferred tools (AGENTIC_CLI §7.6). The query is the
  // salient subject so the chip reads `Searched tools · cancel background`.
  tool_search: {
    activeVerb: 'Searching tools',
    finalVerb: 'Searched tools',
    subject: (a) => str(a.query),
  },
};

// Resolve a tool name to its vocabulary. Tools without an entry get a
// generic fallback so the operator still sees something readable; the
// fallback's bare verb is intentionally awkward so reviewers notice
// and add a proper entry alongside the new tool registration.
export const lookupToolVocab = (name: string): ToolVocab => {
  const known = TOOL_VOCAB[name];
  if (known !== undefined) return known;
  return { activeVerb: `Calling ${name}`, finalVerb: `Called ${name}` };
};

// Compact tool label for the subagent live row's line 2 and the
// aggregated scrollback trail: `read_file` → `read`, `grep` → `grep`.
export const shortToolName = (name: string): string => name.replace(/_file$/, '');

// Plural noun for the aggregated-by-type subagent trail
// (`read 38 files`, `grep 11 searches`); generic `calls` fallback.
const TOOL_NOUN: Readonly<Record<string, string>> = {
  read_file: 'files',
  grep: 'searches',
  glob: 'globs',
  git: 'reads',
  bash: 'commands',
  edit_file: 'edits',
  write_file: 'writes',
  git_apply_patch: 'patches',
  fetch_url: 'fetches',
  memory_read: 'reads',
  memory_search: 'searches',
  retrieve_context: 'lookups',
};
export const toolNoun = (name: string): string => TOOL_NOUN[name] ?? 'calls';
