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
// between parallel and the user-prompt layer.
//
// Cap (`PLAYBOOKS.md` §1.4): the table holds at most 12 data rows
// and the whole block stays under ~800 tokens. Twelve covers the
// canonical 10 playbooks plus a small headroom; over the cap, the
// table truncates with an "(... and N more)" footer and the
// principal can still route by name (the full registry is always
// authoritative — the table is a hint, not the registry itself).

import type { SubagentSet } from '../subagents/load.ts';
import type { SubagentDefinition } from '../subagents/types.ts';
import { sanitizeForTableCell } from './prompt-codespan.ts';

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

Subagents run in an isolated context with their own tools and budget: named playbooks return a fixed-schema report, \`general-purpose\` returns a prose summary. Spawn one with \`task_sync(playbook=<name>, prompt=<self-contained instruction>)\` for sequential work, or \`task_async\` to fan out independent subtasks. The \`name\` column below is the routing identifier — slash commands are operator-facing, never used for tool routing.

**If the request IS a loaded playbook's job, dispatch that playbook — do not do the work inline.** "review this diff/PR/branch" → \`code-review\`; "audit this / is this secure?" → \`security-audit\`; "why is this slow / find the regression" → \`perf-investigate\`. Doing it inline floods this turn with the exact reads the playbook would isolate and drops its structured report (and, for review, its read-only guarantee).

The core benefit is context compression: the subagent's reads, greps, and tool output stay in ITS context; only a concise summary — findings, conclusions, evidence (file:line), not the raw trail — returns to this turn. That summary is raw material for YOUR answer, not a "task done" signal: when the operator's request WAS the delegated work ("explore the repo", "find the bug", "audit this"), present its findings to them; don't end the turn asking what's next with the report unspoken.

**Delegate to a playbook when:**
- The work is a large but self-contained investigation — repo exploration ("explore/understand the repo"), root-cause hunt, broad code search, research — where the question is clear and the reading is voluminous. \`general-purpose\` returns the summary; the raw reads stay out of this turn.
- The task fits a playbook's schema, or needs restricted tools (a reviewer that must NOT edit code) or an explicit bias (paranoia for \`security-audit\`) that conflicts with the default tone.

**Do NOT delegate when:**
- The question is answerable in 1-2 reads without a schema (e.g., "where is function X defined?").
- The problem is still taking shape and you are iterating interactively — delegate once the question is sharp, not an open-ended "help me think".
- The work is tightly coupled to this turn's edits or needs continuous back-and-forth — delegation pays off in isolation, not step-by-step coordination.
- The task matches no playbook's \`when_to_use\` and is not a clean general-purpose investigation, or the user asked for a direct answer rather than a structured report.

Spawning a subagent costs context handoff, budget, and latency. For a general question, default to answering directly; when the request matches a playbook's domain (above), dispatching IS the default.`;

// Workflow discipline that complements the delegation criteria.
// PLAYBOOKS.md §1.4 frames delegation as a per-call decision; this
// section frames the SHAPE of multi-step turns: decompose first,
// then dispatch — but only when scope warrants. Without an
// explicit threshold the model either over-applies decomposition
// to trivial changes (every typo fix becomes a planning exercise)
// or skips it for genuine multi-file work and drifts mid-turn.
//
// The closing-review bullet is conditional in two ways: (1) it
// names `code-review` and `security-audit` only when those
// playbooks are loaded in the registry — naming a subagent that
// does not exist routes to an error or silently falls through;
// (2) the bullet is phrased as a SUGGESTION ("consider"), not a
// prescription ("run before declaring done"), so the model does
// not invoke review subagents on doc-only / single-line changes
// where the cost (~$0.002 + 3-5s per child) outweighs the
// finding rate.
export const PLAYBOOK_WORKFLOW_HEADER = `**Workflow:**

- For tasks that span multiple files or multiple verification surfaces (compile + test + runtime UI + permissions, etc.), name the discrete sub-problems before acting on any of them. Each one is then a candidate for direct work, parallel \`task_async\` fan-out, or sequential \`task_sync\` delegation. Naming the steps prevents drift mid-turn. Trivial changes — single-file edits, doc/comment tweaks, one-line fixes — skip this; decomposition has overhead too.
- Every delegated task carries a self-contained \`prompt\` — assume the subagent has zero context from this conversation. Inline the goal, the constraints, and the expected output shape.`;

// Names of the canonical review playbooks the closing-discipline
// bullet references. Both ship in the playbooks step of `forja init`;
// an operator who hand-rolled their registry without these will
// not see the closing bullet rendered.
const CLOSING_REVIEW_NAMES = ['code-review', 'security-audit'] as const;

const renderClosingReviewBullet = (set: SubagentSet): string | null => {
  const present = CLOSING_REVIEW_NAMES.filter((name) => set.byName.has(name));
  if (present.length === 0) return null;
  // Single-name fallback when only one of the two is loaded —
  // grammar matters more than naming both. Phrased as
  // "consider" (suggestion) and gated on "non-trivial scope"
  // so the model does not reflexively spawn review subagents on
  // doc-only / single-line changes where the per-call cost
  // (~$0.002 + 3-5s) outweighs the finding rate.
  const cited =
    present.length === 1 ? `\`${present[0]}\`` : `\`${present[0]}\` and \`${present[1]}\``;
  const subjectVerb = present.length === 1 ? 'It is' : 'Both are';
  return `- For changes with non-trivial scope (new feature, multi-file refactor, security-sensitive path), consider closing with ${cited} before declaring done. ${subjectVerb} read-only and surface findings worth addressing while the implementation is fresh. Skip for docs, comments, config tweaks, or work the operator is reviewing live.`;
};

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

// Render the markdown table. Cell values (`name`, `whenToUse`) come from
// subagent frontmatter — operator- or project-authored, i.e. attacker-
// influenceable in a shared/cloned repo. They land in the system prompt at
// system priority, so each cell is sanitized: `sanitizeForTableCell` folds
// newlines to a glyph (blocks row/markdown break-out and injected pseudo-
// instructions), strips control bytes (ANSI/ESC), and escapes `|` (blocks
// column injection). Backticks are preserved — a `code` reference in a
// when_to_use cell is legitimate and can't break out of a cell.
const renderTable = (defs: SubagentDefinition[], truncated: boolean): string => {
  const lines: string[] = ['| name | when_to_use |', '|---|---|'];
  for (const def of defs) {
    lines.push(
      `| ${sanitizeForTableCell(def.name)} | ${sanitizeForTableCell(def.whenToUse ?? '')} |`,
    );
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

// Build the playbook hint block (preamble + table + workflow
// discipline). Returns null when there's nothing to render —
// every caller treats null as "no hint to compose," same
// convention `composeWithParallelHint` uses for `undefined`
// downstream.
//
// Workflow ordering: criteria (preamble) → catalogue (table) →
// shape (workflow header) → optional closing-review bullet. The
// model reads "when to delegate" before "what is available"
// before "how to structure a multi-step turn", which mirrors how
// an operator would mentally frame the choice.
const buildPlaybookHint = (set: SubagentSet | undefined): string | null => {
  if (set === undefined || set.byName.size === 0) return null;
  const eligible = eligibleDefinitions(set);
  if (eligible.length === 0) return null;
  const truncated = eligible.length > MAX_PLAYBOOK_TABLE_ROWS;
  const visible = truncated ? eligible.slice(0, MAX_PLAYBOOK_TABLE_ROWS) : eligible;
  const table = renderTable(visible, truncated);
  const closingBullet = renderClosingReviewBullet(set);
  const workflow =
    closingBullet === null
      ? PLAYBOOK_WORKFLOW_HEADER
      : `${PLAYBOOK_WORKFLOW_HEADER}\n${closingBullet}`;
  return `${PLAYBOOK_DELEGATION_PREAMBLE}\n\n${table}\n\n${workflow}`;
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
