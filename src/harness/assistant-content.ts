import { canonicalizeObject } from '../providers/canonical-json.ts';
import type { ProviderContentBlock, ProviderToolUseBlock } from '../providers/index.ts';
import type { CollectedStep } from './collect.ts';

// Assemble an assistant turn's content blocks from a collected step.
//
// Order mirrors the wire: reasoning FIRST (signed thinking / reasoning items
// must replay before text + tool_use), then text, then tool_uses. Empty text is
// omitted. Reasoning `data` is carried VERBATIM — never canonicalized, since
// signatures / encrypted items must round-trip byte-identical.
//
// Reasoning is OMITTED when the turn has neither text nor a tool_use: such a
// turn ends the loop (there is no following tool round-trip for the reasoning to
// continue into), and a reasoning-ONLY message serializes to EMPTY wire content
// the moment a non-replaying converter drops the block — which the provider APIs
// reject (Anthropic / Gemini 400 on empty `content` / `parts`). The append-time
// `hasContent` guard in session-context can't catch this: `[reasoning]` is
// non-empty there and only collapses to empty downstream. Gating here, at the
// single point content is built, keeps the "no empty wire message" invariant
// provider-agnostic.
export const buildAssistantContent = (
  collected: Pick<CollectedStep, 'reasoning' | 'text' | 'tool_uses'>,
): ProviderContentBlock[] => {
  const content: ProviderContentBlock[] = [];
  const hasActionableContent = collected.text.length > 0 || collected.tool_uses.length > 0;
  if (hasActionableContent) {
    for (const r of collected.reasoning) content.push(r);
  }
  if (collected.text.length > 0) {
    content.push({ type: 'text', text: collected.text });
  }
  for (const tu of collected.tool_uses) {
    const block: ProviderToolUseBlock = {
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      // Canonicalize the arg keys at the single point they enter history, so
      // this block serializes to byte-stable bytes in every later request (all
      // providers + resume) — a stable cache prefix. Key order is semantically
      // irrelevant, so this never changes what the model or the tool sees.
      input: canonicalizeObject(tu.input),
    };
    content.push(block);
  }
  return content;
};
