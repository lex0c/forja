// /effort — read or set the operational effort level.
//
// One knob, two axes (`src/harness/effort.ts`): the level resolves
// to a provider reasoning-effort (the model's internal depth,
// forwarded on every request) AND a set of operational budget caps
// (steps, parallel subagents, tolerated tool errors). Read-only
// form (`/effort`) shows the active level + resolved caps + the
// per-provider mapping; mutation form (`/effort <level>`) sets the
// level.
//
// Mutation lands in `baseConfig.effort` and takes effect on the NEXT
// turn — matches /model and /budget (the current turn already
// snapshot its config at startTurn). Session-scoped, in memory only;
// nothing is persisted to config or DB (operator decision).
//
// Precedence is resolved, NOT baked in: `/effort` only records the
// level; the operational caps are layered at read time by
// `effectiveBudget(budget, effort)` (defaults < effort preset <
// explicit `/budget` overrides). So an explicit `/budget` always
// wins over the preset regardless of the order the two commands ran,
// and the result is inspectable via `/budget`.

import { EFFORT_PROFILES, FORJA_EFFORT_LEVELS, type ForjaEffort } from '../../../harness/effort.ts';
import { withRunningCue } from '../format.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const usage = `/effort [${FORJA_EFFORT_LEVELS.join('|')}]`;

const isForjaEffort = (s: string): s is ForjaEffort =>
  (FORJA_EFFORT_LEVELS as readonly string[]).includes(s);

// Render the profile's resolved operational caps as an indented
// detail line. (The provider-effort line was dropped as redundant —
// the level is already shown in the header and the footer chip.)
const profileDetail = (level: ForjaEffort): string[] => {
  const p = EFFORT_PROFILES[level];
  return [
    `  max steps: ${p.maxSteps} · parallel subagents: ${p.maxConcurrentSubagents} · tool errors: ${p.maxToolErrors}`,
  ];
};

const showCurrent = (ctx: SlashContext): SlashResult => {
  const level = ctx.baseConfig.effort;
  if (level === undefined) {
    return {
      kind: 'ok',
      notes: [
        'effort: not set (provider applies its own default — Anthropic: high)',
        `levels: ${FORJA_EFFORT_LEVELS.join(' | ')}`,
      ],
    };
  }
  return {
    kind: 'ok',
    notes: [`effort: ${level}`, ...profileDetail(level), '(explicit /budget caps override these)'],
  };
};

export const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'show or set the reasoning + operational effort level',
  exec: async (args, ctx) => {
    if (args.length === 0) return showCurrent(ctx);
    if (args.length > 1) {
      return {
        kind: 'error',
        message: `/effort: too many args (expected 0 or 1). usage: ${usage}`,
      };
    }
    const raw = (args[0] ?? '').toLowerCase();
    if (!isForjaEffort(raw)) {
      return {
        kind: 'error',
        message: `/effort: unknown level '${args[0]}'. Known: ${FORJA_EFFORT_LEVELS.join(', ')}`,
      };
    }
    const level: ForjaEffort = raw;
    // Idempotency: a no-op mutation returns "already" without the
    // next-turn cue, so the operator isn't misled into thinking
    // something changed.
    if (ctx.baseConfig.effort === level) {
      return { kind: 'ok', notes: [`effort already ${level} (no change)`] };
    }
    // Record the level only. The operational caps are layered at
    // read time by `effectiveBudget(budget, effort)` — no in-place
    // mutation of `baseConfig.budget`, so an explicit `/budget`
    // override is never clobbered (order-independent precedence).
    ctx.baseConfig.effort = level;
    // Repaint the footer's effort chip immediately (the level takes
    // effect next turn, but the operator's selection shows at once).
    ctx.bus.emit({ type: 'effort:change', ts: ctx.now(), effort: level });
    return {
      kind: 'ok',
      notes: withRunningCue(ctx, [
        `effort: ${level} — takes effect on the next turn`,
        ...profileDetail(level),
      ]),
    };
  },
};
