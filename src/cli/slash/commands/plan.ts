// /plan — show plan-mode status (read-only in this slice).
//
// Mutation (`/plan on|off`) is a separate slice — it requires
// flipping the harness's planMode flag (currently boot-time only)
// and re-resolving the system prompt. This command currently shows
// whether plan mode was set at boot.

import type { SlashCommand } from '../types.ts';

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'show plan-mode status (read-only)',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return {
        kind: 'error',
        message: '/plan: toggling plan mode mid-session is not supported yet (read-only)',
      };
    }
    const enabled = ctx.baseConfig.planMode === true;
    return {
      kind: 'ok',
      notes: [
        enabled
          ? 'plan mode: enabled (write tools blocked at the harness)'
          : 'plan mode: disabled (write tools allowed per policy)',
      ],
    };
  },
};
