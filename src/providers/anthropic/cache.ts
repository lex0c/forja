import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderContentBlock, ProviderMessage } from '../types.ts';

// Anchor `cache_control: { type: 'ephemeral' }` markers at the
// breakpoints CONTEXT_TUNING.md §3.1 declares. Each marker tells
// Anthropic "the prefix up to and including this content is
// cacheable"; subsequent requests with an identical prefix hit the
// 5-minute ephemeral cache (read at 0.10× input cost vs 1.00×
// uncached) instead of paying the full input price every turn.
//
// CONTEXT_TUNING.md §3.1 declares four breakpoints —
//   1. after [system]
//   2. after [tool_schemas]
//   3. after [project_context]   (AGENTS.md)
//   4. after [memory_index]
// — but Forja's current system-prompt composition fuses
// [system], [project_context], and [memory_index] into a single
// concatenated string at `composeSystemPrompt` (`memory-prompt.ts:225`).
// Splitting the string back into four discrete TextBlockParams
// would require restructuring the prompt assembly pipeline; out of
// scope for this slice. We anchor three breakpoints instead:
//
//   - system block (combines #1, #3, #4 — invalidates together
//     when memory_index or project_context changes)
//   - last tool (= #2)
//   - last message's last content block (the conversation tail
//     anchor; lets each turn cache everything it just sent so the
//     next turn reads ~70% of input from cache)
//
// The fourth breakpoint becomes recoverable by splitting
// `composeSystemPrompt` into a TextBlockParam[] producer; tracked
// for a follow-up. The economics of the three-breakpoint layout
// already capture the dominant input-cost reduction documented in
// PROVIDERS.md §5.1 ("Cache amortiza custo em sessão longa em
// ~70% no input").

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

// Convert `system: string | undefined` into Anthropic's TextBlockParam
// array form with a cache_control marker on the (single) block.
// Returns undefined when the system is empty/absent so the request
// omits the field entirely (matches existing semantics — no system
// prompt persists "no prompt" rather than an empty one).
export const systemWithCacheBreakpoint = (
  system: string | undefined,
): Anthropic.TextBlockParam[] | undefined => {
  if (system === undefined || system.length === 0) return undefined;
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
};

// Attach a cache_control marker to the LAST tool in the array.
// Anthropic's caching anchors at the last cache_control marker
// before the breakpoint, so marking the final tool caches the
// entire tool list as one unit. Earlier tools share the same cache
// behavior; marking only the last one is intentional (one
// breakpoint == one cache "level"; the request gets four total
// across system/tools/messages).
export const toolsWithCacheBreakpoint = (tools: Anthropic.Tool[]): Anthropic.Tool[] => {
  if (tools.length === 0) return tools;
  const last = tools.length - 1;
  return tools.map((t, i) => (i === last ? { ...t, cache_control: EPHEMERAL } : t));
};

// Conversation-tail cache anchor. Walks to the last message's last
// content block and attaches cache_control. Each turn moves the
// anchor forward — write cost is 1.25× input on the new tail block,
// but every prior turn's content reads back at 0.10× via the
// preceding anchor. Net economy crosses zero by turn 2 in a typical
// session and grows from there.
//
// Caveat: the anchor moves on every request. That's not free —
// each call pays a cache write on the new tail. The trade-off is
// already in the SDK design, and it's the right one for an agent
// loop where prefix length grows monotonically: each write becomes
// the next read's cache.
export const messagesWithTailCacheBreakpoint = (
  messages: { role: ProviderMessage['role']; content: string | ProviderContentBlock[] }[],
): Anthropic.MessageParam[] => {
  if (messages.length === 0) return messages as unknown as Anthropic.MessageParam[];
  const tailIdx = messages.length - 1;
  return messages.map((m, i) => {
    if (i !== tailIdx) return m as Anthropic.MessageParam;
    const content = m.content;
    // String content collapses to a single text block so we have
    // somewhere to hang cache_control. Anthropic accepts the
    // expanded form transparently.
    if (typeof content === 'string') {
      if (content.length === 0) {
        // Empty content — leave alone; the API rejects empty arrays
        // and adding a marker on a placeholder would create a phantom
        // cache write. The conversation cache breakpoint is a
        // best-effort optimization; skipping it on degenerate
        // shapes is correct.
        return m as Anthropic.MessageParam;
      }
      return {
        role: m.role,
        content: [{ type: 'text', text: content, cache_control: EPHEMERAL }],
      };
    }
    if (content.length === 0) return m as Anthropic.MessageParam;
    const lastBlockIdx = content.length - 1;
    const blocks = content.map((block, bi) => {
      if (bi !== lastBlockIdx) return block;
      // Each block kind has its own cache_control field on the
      // Anthropic SDK side. The cast spreads the ephemeral marker
      // without per-type branching; the SDK accepts cache_control
      // on text, tool_use, and tool_result blocks alike.
      return { ...block, cache_control: EPHEMERAL };
    });
    return { role: m.role, content: blocks } as Anthropic.MessageParam;
  });
};

// Defensive helper: count cache_control markers across a request.
// Anthropic enforces a hard limit of 4 breakpoints per request and
// 400s the call when exceeded. Three is the planned layout
// (system + last tool + tail message); future work that adds the
// fourth (memory_index split) must update this assertion.
export const countCacheBreakpoints = (req: {
  system?: Anthropic.TextBlockParam[] | undefined;
  tools?: Anthropic.Tool[] | undefined;
  messages: Anthropic.MessageParam[];
}): number => {
  let n = 0;
  for (const block of req.system ?? []) {
    if (block.cache_control != null) n += 1;
  }
  for (const tool of req.tools ?? []) {
    if ((tool as { cache_control?: unknown }).cache_control != null) n += 1;
  }
  for (const m of req.messages) {
    const content = m.content;
    if (typeof content === 'string') continue;
    for (const block of content) {
      if ((block as { cache_control?: unknown }).cache_control != null) n += 1;
    }
  }
  return n;
};

// Hard cap declared by Anthropic. Provider 400s when exceeded;
// surfaced here so the assertion at request build time produces a
// source-aware error before the call leaves the binary.
export const MAX_CACHE_BREAKPOINTS_PER_REQUEST = 4;

// Helper used by tests; not strictly needed by production but
// exposed so a tightening of the contract (e.g. adding the fourth
// breakpoint for memory_index) lands with assertion changes
// visible in one place.
export const ANTHROPIC_CACHE_EPHEMERAL = EPHEMERAL;
