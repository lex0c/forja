// /plan — read or toggle plan mode.
//
// Read-only form (`/plan`) shows current plan-mode status. Mutation
// forms (`/plan on`, `/plan off`) flip baseConfig.planMode. The
// change takes effect on the NEXT turn — the current turn (if any)
// already snapshot its config when it started, and live cancellation
// for a config flip would surprise the operator (their in-flight
// prompt suddenly behaves differently). Note in the confirmation
// makes the timing explicit.
//
// Footer drift: state.status.planMode reflects the last session_start
// event, not baseConfig directly. Operator may see the footer's
// `plan` token unchanged for one turn before the next session_start
// catches up. Acceptable — explicit confirmation note + the next
// turn's footer correction.

import type { SlashCommand } from '../types.ts';

const usage = '/plan [on|off]';

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'show or toggle plan mode',
  exec: async (args, ctx) => {
    if (args.length === 0) {
      const enabled = ctx.baseConfig.planMode === true;
      return {
        kind: 'ok',
        notes: [
          enabled
            ? 'plan mode: enabled (write tools blocked at the harness)'
            : 'plan mode: disabled (write tools allowed per policy)',
        ],
      };
    }
    if (args.length > 1) {
      return {
        kind: 'error',
        message: `/plan: too many args (expected 0 or 1). usage: ${usage}`,
      };
    }
    const arg = (args[0] ?? '').toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      return { kind: 'error', message: `/plan: unknown arg '${args[0]}'. usage: ${usage}` };
    }
    const next = arg === 'on';
    const prior = ctx.baseConfig.planMode === true;
    if (next === prior) {
      return {
        kind: 'ok',
        notes: [`plan mode already ${next ? 'enabled' : 'disabled'} (no change)`],
      };
    }
    // Mutate the shared baseConfig in place. Next startTurn reads the
    // updated value via the spread copy. Current turn (if any) is
    // unaffected — its config was already snapshot.
    ctx.baseConfig.planMode = next;
    const status = next ? 'enabled' : 'disabled';
    const notes = [`plan mode: ${status} — takes effect on the next turn`];
    if (ctx.isRunning()) {
      // The operator is mutating mid-turn; without this cue they
      // might think the in-flight prompt is now in plan mode (it
      // isn't — the harness snapshot its config at startTurn).
      notes.push(
        '(current turn already snapshot its config; new value applies starting next prompt)',
      );
    }
    return { kind: 'ok', notes };
  },
};
