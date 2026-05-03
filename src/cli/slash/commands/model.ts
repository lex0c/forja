// /model — show the current model id (read-only in this slice).
//
// Mutation (`/model anthropic/<other>`) is a separate slice — it
// requires re-resolving the provider + reconfiguring the harness
// for the next turn. This command currently surfaces the active
// model + the provider's relevant capability ceilings (context
// window, max output tokens) so the operator can see what they're
// running against.

import type { SlashCommand } from '../types.ts';

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'show current model and capabilities',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return {
        kind: 'error',
        message: '/model: changing the model mid-session is not supported yet (read-only)',
      };
    }
    const provider = ctx.baseConfig.provider;
    const caps = provider.capabilities;
    return {
      kind: 'ok',
      notes: [
        `model: ${provider.id}`,
        `context: ${caps.context_window.toLocaleString()} tokens`,
        `max output: ${caps.output_max_tokens.toLocaleString()} tokens`,
      ],
    };
  },
};
