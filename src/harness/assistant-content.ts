import { canonicalizeObject } from '../providers/canonical-json.ts';
import type { ProviderContentBlock, ProviderToolUseBlock } from '../providers/index.ts';
import type { CollectedBlock, CollectedStep, CollectedToolUse } from './collect.ts';

// Canonicalize a tool_use's arg keys at the single point it enters history, so it
// serializes to byte-stable bytes in every later request (all providers + resume)
// — a stable cache prefix. Key order is semantically irrelevant, so this never
// changes what the model or the tool sees.
const toToolUseBlock = (tu: CollectedToolUse): ProviderToolUseBlock => ({
  type: 'tool_use',
  id: tu.id,
  name: tu.name,
  input: canonicalizeObject(tu.input),
});

// Assemble an assistant turn's content blocks from a collected step.
//
// Blocks are emitted in the EXACT order the model produced them (`collected.order`):
// signed thinking / reasoning items must round-trip byte-identical AND keep their
// position relative to the tool_use blocks around them — interleaved thinking can
// emit thinking1, tool1, thinking2, tool2 in one turn, and Anthropic 400s if a
// replayed thinking block is reordered. Reasoning `data` is carried VERBATIM
// (never canonicalized); only tool_use inputs are canonicalized.
//
// Reasoning is OMITTED when the turn has neither text nor a tool_use: such a turn
// ends the loop (no following tool round-trip for the reasoning to continue into),
// and a reasoning-ONLY message serializes to EMPTY wire content the moment a
// non-replaying converter drops the block — which the provider APIs reject
// (Anthropic / Gemini 400 on empty `content` / `parts`). The append-time
// `hasContent` guard in session-context can't catch this (`[reasoning]` is
// non-empty there and only collapses downstream), so gate it here.
export const buildAssistantContent = (
  collected: Pick<CollectedStep, 'reasoning' | 'text' | 'tool_uses'> & {
    order?: CollectedBlock[];
  },
): ProviderContentBlock[] => {
  const order = collected.order;
  if (order !== undefined && order.length > 0) {
    // A turn with only reasoning (no text, no tool_use) → omit entirely.
    const hasActionable = order.some((b) => b.kind === 'text' || b.kind === 'tool_use');
    if (!hasActionable) return [];
    const content: ProviderContentBlock[] = [];
    for (const b of order) {
      if (b.kind === 'reasoning') content.push(b.reasoning);
      else if (b.kind === 'text') content.push({ type: 'text', text: b.text });
      else content.push(toToolUseBlock(b.toolUse));
    }
    return content;
  }

  // Fallback for callers that don't supply `order` (synthetic/tests): group as
  // reasoning-first, then text, then tool_uses, with the same reasoning-only
  // suppression. Real runs always carry `order`.
  const content: ProviderContentBlock[] = [];
  const hasActionableContent = collected.text.length > 0 || collected.tool_uses.length > 0;
  if (hasActionableContent) {
    for (const r of collected.reasoning) content.push(r);
  }
  if (collected.text.length > 0) {
    content.push({ type: 'text', text: collected.text });
  }
  for (const tu of collected.tool_uses) {
    content.push(toToolUseBlock(tu));
  }
  return content;
};
