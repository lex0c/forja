// Playbook discovery preamble surfaced to the principal agent
// (`PLAYBOOKS.md` §1.4). Without this hint, the model only learns
// about subagents through the verbose `task_*` tool descriptions
// and has no per-playbook routing signal — auto-delegation
// degenerates to "always task" or "never task". The discovery
// table + delegation criteria below give the model a concise
// catalogue of available playbooks and an explicit policy for
// when to invoke one.
//
// Composition order (see `bootstrap.ts`): the parallel hint goes
// FIRST (it explains the harness's concurrency primitives, which
// the playbook section then assumes); the playbook hint sits
// between parallel and the user/plan layers.
//
// Cap (`PLAYBOOKS.md` §1.4): the table holds at most 12 data rows
// and the whole block stays under ~800 tokens. Twelve covers the
// canonical 10 playbooks plus a small headroom; over the cap, the
// table truncates with an "(... and N more)" footer and the
// principal can still route by name (the full registry is always
// authoritative — the table is a hint, not the registry itself).

import type { SubagentSet } from '../subagents/load.ts';
import type { SubagentDefinition } from '../subagents/types.ts';

// Maximum number of rows rendered in the discovery table. Spec
// `PLAYBOOKS.md` §1.4 caps at 12. Defs without `whenToUse` never
// count toward this cap because they don't appear in the table.
export const MAX_PLAYBOOK_TABLE_ROWS = 12;

// The delegation preamble is the operator-facing translation of
// the auto-delegation criteria in `PLAYBOOKS.md` §1.4. Phrased as
// constraints the model can apply mechanically rather than as
// abstract advice — the spec is explicit that constraints
// negativas ("do not delegate when…") shape behavior more
// reliably than positive descriptions of personas.
export const PLAYBOOK_DELEGATION_PREAMBLE = `# Playbook subagents

Specialized subagents are available for structured workflows. Each one runs in an isolated context with restricted tools and returns a fixed-schema report. Spawn one with \`task_sync(playbook=<name>, prompt=<self-contained instruction>)\` for sequential coordination, or \`task_async\` when fanning out independent subtasks. The \`name\` column below is the routing identifier — slash commands (when present) are operator-facing and never used for tool routing.

**Delegate to a playbook when:**
- The task fits a playbook's structured schema and the user benefits from the categorized output.
- You want context isolation — the subagent's intermediate reads do not pollute this turn.
- You want restricted tools — e.g., a review subagent that must NOT edit code.
- The task demands an explicit bias (skepticism for \`gap-audit\`, paranoia for \`security-audit\`) that conflicts with the default tone.

**Do NOT delegate when:**
- The question is answerable in 1-2 reads without a schema (e.g., "where is function X defined?").
- The conversation is exploratory and the problem is still taking shape — premature delegation locks in a schema before the form is clear.
- The task does not match any playbook's \`when_to_use\` — do not force-fit.
- The user asked for a direct answer, not a structured report.

Spawning a subagent costs context handoff, budget, and latency. Default to answering directly; delegation is the exception that pays a specific benefit (isolation, schema, bias, tool restriction).`;

// Filter the registry down to the defs that participate in
// discovery. A def without `whenToUse` is intentionally excluded:
// the table teaches the model when each playbook applies, and a
// row whose `when_to_use` cell is empty teaches nothing — the
// model would have to fall back on `description`, which the def
// already exposes through the `task_*` tool's enum (when the
// provider supports it) or through error messages that list
// available subagents.
//
// Sorted alphabetically by name so the table is independent of
// load order (user vs project scope, file system iteration order)
// and stable across runs — diffing two prompts in a regression
// test does not need to reason about scope precedence.
const eligibleDefinitions = (set: SubagentSet): SubagentDefinition[] => {
  const out: SubagentDefinition[] = [];
  for (const def of set.byName.values()) {
    if (def.whenToUse !== undefined) out.push(def);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
};

// Render the markdown table. We intentionally do NOT escape `|`
// inside cells: `whenToUse` is author-controlled and the spec
// example shows free-form prose; an embedded `|` would break the
// row but that is a lint-time problem the author can fix at
// source. Auto-escaping here would silently mask malformed
// frontmatter.
const renderTable = (defs: SubagentDefinition[], truncated: boolean): string => {
  const lines: string[] = ['| name | when_to_use |', '|---|---|'];
  for (const def of defs) {
    lines.push(`| ${def.name} | ${def.whenToUse} |`);
  }
  if (truncated) {
    // Footer line names the count of dropped entries so the
    // operator (and the model, when reasoning about scope) knows
    // the table is partial. The full registry stays authoritative
    // — `task_*` will resolve any name not on the table just as
    // it does for names on the table.
    lines.push('| _… (additional playbooks omitted from this hint) … _ | _see registry_ |');
  }
  return lines.join('\n');
};

// Build the playbook hint block (preamble + table). Returns null
// when there's nothing to render — every caller treats null as
// "no hint to compose," same convention `composeWithParallelHint`
// uses for `undefined` downstream.
const buildPlaybookHint = (set: SubagentSet | undefined): string | null => {
  if (set === undefined || set.byName.size === 0) return null;
  const eligible = eligibleDefinitions(set);
  if (eligible.length === 0) return null;
  const truncated = eligible.length > MAX_PLAYBOOK_TABLE_ROWS;
  const visible = truncated ? eligible.slice(0, MAX_PLAYBOOK_TABLE_ROWS) : eligible;
  const table = renderTable(visible, truncated);
  return `${PLAYBOOK_DELEGATION_PREAMBLE}\n\n${table}`;
};

// Compose the playbook hint with a downstream prompt. Same shape
// as `composeWithParallelHint`: hint goes FIRST (background),
// downstream goes after with a `---` separator. Returns the
// downstream untouched when there is no hint to add (no defs, or
// no defs with `whenToUse`); returns `undefined` when neither
// side has content.
//
// The function is a thin layering wrapper — the hard work is in
// `buildPlaybookHint`. Splitting them out lets the bootstrap
// path call `composeWithPlaybookHint` once without inventing a
// second null-or-defined branching helper.
export const composeWithPlaybookHint = (
  downstream: string | undefined,
  set: SubagentSet | undefined,
): string | undefined => {
  const hint = buildPlaybookHint(set);
  if (hint === null) return downstream;
  if (downstream === undefined || downstream.length === 0) return hint;
  return `${hint}\n\n---\n\n${downstream}`;
};
