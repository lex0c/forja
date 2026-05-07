// Playbook slash command factory (`PLAYBOOKS.md` §1.4).
//
// Each subagent definition that declares `slash: <name>` in its
// frontmatter contributes one entry to the slash registry. Typing
// `/<slash> <prompt>` runs the subagent inline against the
// operator's session — same machinery as `task_sync` from the model
// side, only the surface differs.
//
// The slash → name mapping is intentionally indirect: the model
// uses the canonical kebab-case `name` for tool routing
// (PLAYBOOKS.md §1.4), and the operator-facing `slash` is just a
// short alias for typing convenience. Both can co-exist (e.g.,
// `name: code-review`, `slash: review`) and a typo in one does
// not corrupt the other.

import type { SubagentDefinition } from '../../../subagents/types.ts';
import type { SlashCommand, SlashResult } from '../types.ts';

// Render a `RunSubagentResult` into operator-readable scrollback
// lines. Status-aware: a `done` run shows the verdict + cost +
// subagent output; a non-`done` run leads with the failure mode
// and reason so the operator sees the cause without reading the
// raw output (which may itself be truncated or empty on hard
// aborts).
//
// Cost is rounded to four decimals — the same precision `/cost`
// uses, and enough to distinguish playbook runs from each other
// without trailing-zero noise.
const formatRunNotes = (
  slashName: string,
  status: string,
  reason: string,
  costUsd: number,
  durationMs: number,
  steps: number,
  output: string,
): string[] => {
  const verdict =
    status === 'done'
      ? `/${slashName} finished — ${steps} step(s), \$${costUsd.toFixed(4)}, ${durationMs}ms`
      : `/${slashName} ${status} (${reason}) — ${steps} step(s), \$${costUsd.toFixed(4)}, ${durationMs}ms`;
  // Empty output is meaningful on `done` (the playbook's prompt
  // produced no terminal text — usually because it ran `task_*`
  // recursively and never emitted a final assistant turn). Show
  // the placeholder so the operator doesn't think the render
  // dropped a line.
  const body = output.length > 0 ? output : '(no output produced)';
  return [verdict, '', body];
};

// Build a `SlashCommand` for a single subagent definition. Caller
// (`buildPlaybookSlashCommands`) is responsible for filtering out
// defs without `slash`. We assert it here too as a defensive guard
// — a future caller that forgets the filter gets a clear error
// instead of a registry with a `name: undefined` entry that fails
// at lookup time.
const buildOnePlaybookCommand = (def: SubagentDefinition): SlashCommand => {
  if (def.slash === undefined) {
    throw new Error(
      `playbook slash command: definition '${def.name}' has no 'slash' field — caller should have filtered`,
    );
  }
  const slash = def.slash;
  // Description hints at the routing target so /help reads
  // unambiguously — without "(playbook code-review)" the operator
  // can't tell `/review` from any other builtin sharing a verb.
  const description = `${def.description.replace(/\.$/, '')} (playbook ${def.name})`;
  return {
    name: slash,
    description,
    exec: async (args, ctx): Promise<SlashResult> => {
      if (args.length === 0) {
        return {
          kind: 'error',
          message: `/${slash} requires a prompt — usage: /${slash} <self-contained instruction for ${def.name}>`,
        };
      }
      if (ctx.runPlaybook === undefined) {
        // Headless / test contexts that don't wire the bridge.
        // The slash itself stays registered so /help still lists
        // it; we just can't dispatch.
        return {
          kind: 'error',
          message: `/${slash} cannot dispatch — playbook runtime is not wired in this context`,
        };
      }
      // Serialize parallel surfaces. The REPL's `isRunning()`
      // closure reports `true` for either a foreground turn OR an
      // in-flight slash playbook dispatch — both share the
      // provider, the DB, and the permission engine, so running
      // them concurrently would interleave tool calls and audit
      // rows under the same parent session. Without this check a
      // user could submit /<slash> twice in succession and both
      // dispatches would race; the gate refuses the second one
      // with a clear message instead.
      if (ctx.isRunning()) {
        return {
          kind: 'error',
          message: `/${slash} cannot dispatch while a turn or playbook is in progress — wait for it to finish or interrupt with Esc`,
        };
      }
      const prompt = args.join(' ');
      const result = await ctx.runPlaybook({ name: def.name, prompt });
      return {
        kind: 'ok',
        notes: formatRunNotes(
          slash,
          result.status,
          result.reason,
          result.costUsd,
          result.durationMs,
          result.steps,
          result.output,
        ),
      };
    },
  };
};

// Build the full set of playbook slash commands from a registry.
// Defs without `slash` are skipped silently (they remain reachable
// via `task_sync(playbook=<name>)`; the operator surface is
// optional). Order is deterministic: alphabetical by slash name so
// /help renders predictably across runs.
export const buildPlaybookSlashCommands = (defs: Iterable<SubagentDefinition>): SlashCommand[] => {
  const out: SlashCommand[] = [];
  for (const def of defs) {
    if (def.slash !== undefined) out.push(buildOnePlaybookCommand(def));
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
};
