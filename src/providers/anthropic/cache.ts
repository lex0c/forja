import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderContentBlock, ProviderMessage, SystemSegment } from '../types.ts';

// Anchor `cache_control: { type: 'ephemeral' }` markers at the
// breakpoints CONTEXT_TUNING.md §3.1 declares. Each marker tells
// Anthropic "the prefix up to and including this content is
// cacheable"; subsequent requests with an identical prefix hit the
// 5-minute ephemeral cache (read at 0.10× input cost vs 1.00×
// uncached) instead of paying the full input price every turn.
//
// Forja's layout anchors the four breakpoints Anthropic permits
// per request:
//
//   1. stable system segment (identity + env + ergonomics +
//      constraints + project pointer — each invalidates rarely,
//      fused into one envelope)
//   2. memory + skills segment (invalidates on `memory_write`
//      and skill catalog changes — the high-churn segment)
//   3. last tool (cache_control on the final tool definition
//      anchors the whole tool list as one unit)
//   4. conversation tail (cache_control on the last message's
//      last content block — moves each turn, so prior turns
//      read at 0.10× cached rate)
//
// CONTEXT_TUNING.md §3.1 lists [project_context] as a separate
// breakpoint, but adding a 5th marker would exceed Anthropic's
// per-request cap and force dropping the tail anchor — which
// amortizes intra-session growth and has much higher economic
// impact than isolating a small pointer. Project pointer fuses
// with the stable segment.
//
// Producer side: bootstrap emits `systemSegments` alongside the
// canonical `systemPrompt` string, with breakpoint flags on the
// stable and memory segments. `systemSegmentsWithCacheBreakpoints`
// (below) honors the flags. Other providers ignore segments and
// read the concatenated `system` string; `flattenSystemSegments`
// guarantees both surfaces see identical content.

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

// Cache TTL: the default 5-minute ephemeral, or the 1-hour extended cache.
// 1h survives longer inter-turn gaps (a dev session with pauses) so the
// stable prefix isn't re-written on every >5min lapse — at the cost of a
// 2× write premium (vs 1.25× for 5min). Opt-in; see anthropic/index.ts.
export type CacheTtl = '5m' | '1h';

// The cache_control marker for a TTL. 5m = the bare ephemeral marker
// (Anthropic's default); 1h = the same with an explicit `ttl: '1h'`.
export const cacheMarker = (ttl: CacheTtl): Anthropic.CacheControlEphemeral =>
  ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : EPHEMERAL;

// Convert `system: string | undefined` into Anthropic's TextBlockParam
// array form with a cache_control marker on the (single) block.
// Returns undefined when the system is empty/absent so the request
// omits the field entirely (matches existing semantics — no system
// prompt persists "no prompt" rather than an empty one).
export const systemWithCacheBreakpoint = (
  system: string | undefined,
  marker: Anthropic.CacheControlEphemeral = EPHEMERAL,
): Anthropic.TextBlockParam[] | undefined => {
  if (system === undefined || system.length === 0) return undefined;
  return [{ type: 'text', text: system, cache_control: marker }];
};

// Multi-segment variant. Each `SystemSegment` becomes its own
// TextBlockParam; segments with `cacheBreakpoint: true` get a
// cache_control marker after them, splitting the prefix into
// distinct invalidation envelopes. Drops empty-text segments
// silently — they would render as empty blocks and waste a
// breakpoint slot. Returns undefined when nothing survives the
// filter so callers fall back to the request's `system` string.
export const systemSegmentsWithCacheBreakpoints = (
  segments: SystemSegment[],
  marker: Anthropic.CacheControlEphemeral = EPHEMERAL,
): Anthropic.TextBlockParam[] | undefined => {
  const blocks: Anthropic.TextBlockParam[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    blocks.push(
      seg.cacheBreakpoint
        ? { type: 'text', text: seg.text, cache_control: marker }
        : { type: 'text', text: seg.text },
    );
  }
  return blocks.length === 0 ? undefined : blocks;
};

// Attach a cache_control marker to the LAST tool in the array.
// Anthropic's caching anchors at the last cache_control marker
// before the breakpoint, so marking the final tool caches the
// entire tool list as one unit. Earlier tools share the same cache
// behavior; marking only the last one is intentional (one
// breakpoint == one cache "level"; the request gets four total
// across system/tools/messages).
export const toolsWithCacheBreakpoint = (
  tools: Anthropic.Tool[],
  marker: Anthropic.CacheControlEphemeral = EPHEMERAL,
): Anthropic.Tool[] => {
  if (tools.length === 0) return tools;
  const last = tools.length - 1;
  return tools.map((t, i) => (i === last ? { ...t, cache_control: marker } : t));
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
  marker: Anthropic.CacheControlEphemeral = EPHEMERAL,
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
        content: [{ type: 'text', text: content, cache_control: marker }],
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
      return { ...block, cache_control: marker };
    });
    return { role: m.role, content: blocks } as Anthropic.MessageParam;
  });
};

// Defensive helper: count cache_control markers across a request.
// Anthropic enforces a hard limit of 4 breakpoints per request and
// 400s the call when exceeded. The layout maxes at 4 (stable
// system + memory + last tool + tail). Adding a 5th would force
// dropping one of the existing four.
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
