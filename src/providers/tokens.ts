import type { ProviderMessage } from './types.ts';

// Local chars/4 heuristic for prompt token estimation. Used where a
// real per-provider tokenizer would be expensive or unavailable:
//   - OpenAI provider's `countTokens` (no server-side endpoint until
//     tiktoken lands in M5).
//   - Harness compaction trigger, which needs to size the NEXT
//     request without paying the round-trip cost of
//     `provider.countTokens()` on every turn.
//
// Margin of error: ~10-25% over real tokenizers (English text
// compresses tighter than 4 chars/token). The bias is conservative —
// triggers fire slightly earlier than necessary, which is the right
// direction for a context-window safety threshold. Where exactness
// matters (billing reconciliation, eval), reach for the provider's
// real `countTokens` instead.
//
// Tool blocks: name + serialized args / serialized content all count
// as the bytes they'll occupy on the wire. Whitespace expansion in
// `JSON.stringify` is per-default minimal (no indentation), so the
// estimate matches the eventual request body within the heuristic's
// tolerance.
export const estimateMessagesTokens = (messages: ProviderMessage[]): number => {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') {
        chars += block.text.length;
      } else if (block.type === 'tool_use') {
        chars += block.name.length + JSON.stringify(block.input).length;
      } else {
        chars += block.content.length + block.tool_use_id.length;
      }
    }
  }
  return Math.ceil(chars / 4);
};
