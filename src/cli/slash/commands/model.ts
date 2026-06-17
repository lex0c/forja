// /model — read or switch the active model.
//
// Read-only form (`/model`) shows the current model id + capability
// ceilings (context window, max output tokens). Mutation form
// (`/model <id>`) replaces baseConfig.provider with a fresh Provider
// from the registry's factory.
//
// Mutation lands in baseConfig and takes effect on the NEXT turn —
// matches /budget. The current turn (if any) already
// snapshot its provider when startTurn ran; live cancellation for a
// model swap would surprise the operator.
//
// Failure paths:
//   - Unknown id: lookup miss. Surface "Known: <list>" so the
//     operator doesn't have to grep the docs.
//   - Factory throw: the SDK's create call may throw on missing API
//     key (ANTHROPIC_API_KEY etc.). Caught and reported as a clean
//     error rather than crashing the REPL.

import type { Provider } from '../../../providers/types.ts';
import { withRunningCue } from '../format.ts';
import type { SlashCommand } from '../types.ts';

const usage = '/model [<id>]';

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'show or switch the active model',
  // Derived from `usage` (its arg portion) so the two can't drift.
  argHint: usage.slice(usage.indexOf(' ') + 1),
  exec: async (args, ctx) => {
    if (args.length === 0) {
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
    }
    if (args.length > 1) {
      return {
        kind: 'error',
        message: `/model: too many args (expected 0 or 1). usage: ${usage}`,
      };
    }
    const id = args[0] ?? '';
    const entry = ctx.modelRegistry.get(id);
    if (entry === null) {
      const known = ctx.modelRegistry
        .list()
        .map((e) => e.id)
        .join(', ');
      return {
        kind: 'error',
        message: `/model: unknown model '${id}'. Known: ${known}`,
      };
    }
    // Idempotency check sits AFTER the registry lookup intentionally.
    // The lookup is cheap (Map.get) and validates the id against the
    // registry's actual contents — useful when the registry could
    // someday be mutated at runtime (D176 mentions enterprise allow-
    // lists as a future use case). If the order were swapped and the
    // current model id had been removed from the registry, the
    // operator would see "already X (no change)" while a `/model X`
    // typed in retry would mislead them. Lookup-first keeps the
    // error path honest. Today the registry is immutable post-boot.
    if (id === ctx.baseConfig.provider.id) {
      return {
        kind: 'ok',
        notes: [`model already ${id} (no change)`],
      };
    }
    let provider: Provider;
    try {
      provider = entry.factory();
    } catch (e) {
      // Typical: missing ANTHROPIC_API_KEY / OPENAI_API_KEY when the
      // operator tries to switch to a family they haven't configured.
      // Show the SDK's message directly — it's almost always more
      // useful than a generic "factory failed" wrapper.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        kind: 'error',
        message: `/model: failed to instantiate '${id}': ${msg}`,
      };
    }
    // Mutate the shared baseConfig in place. Next startTurn reads the
    // updated provider via the spread copy. Current turn (if any) is
    // unaffected — its config was already snapshot.
    ctx.baseConfig.provider = provider;
    return {
      kind: 'ok',
      notes: withRunningCue(ctx, [`model: ${id} — takes effect on the next turn`]),
    };
  },
};
