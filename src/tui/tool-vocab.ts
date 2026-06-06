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
  task: {
    // Verb stays bare — the subject already carries the agent name;
    // saying "Delegating to subagent / └─ reviewer" duplicates
    // "subagent" without adding info. Reads as "Delegating · reviewer".
    activeVerb: 'Delegating',
    finalVerb: 'Delegated',
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
