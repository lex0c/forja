import type { ProviderMessage, ProviderToolDef } from './types.ts';

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

// Sum the chars contributed by each block in a message. Tool blocks
// count name + serialized args / content as the bytes they'll occupy
// on the wire. Whitespace expansion in `JSON.stringify` is per-default
// minimal (no indentation), so the estimate matches the eventual
// request body within the heuristic's tolerance.
const charsInMessage = (m: ProviderMessage): number => {
  let chars = 0;
  if (typeof m.content === 'string') return m.content.length;
  for (const block of m.content) {
    if (block.type === 'text') {
      chars += block.text.length;
    } else if (block.type === 'tool_use') {
      chars += block.name.length + JSON.stringify(block.input).length;
    } else {
      chars += block.content.length + block.tool_use_id.length;
    }
  }
  return chars;
};

const charsInTool = (t: ProviderToolDef): number =>
  t.name.length + t.description.length + JSON.stringify(t.input_schema).length;

// Estimate just the message-array token cost. Used by Provider
// `countTokens` (whose interface only takes messages) — see
// `estimatePromptTokens` for the full-request estimate including
// system + tools.
export const estimateMessagesTokens = (messages: ProviderMessage[]): number => {
  let chars = 0;
  for (const m of messages) chars += charsInMessage(m);
  return Math.ceil(chars / 4);
};

// Estimate the WHOLE outbound prompt: messages plus the optional
// system prompt and tool schemas. Real provider calls send all three
// and they all count against the model's context window. Tool
// schemas in particular can run 2-4k tokens each (CONTEXT_TUNING.md
// §2.1) and a long system prompt is another 0.5-3k — counting only
// `messages` undercounts the trigger and lets compaction skip a turn
// that's already over budget. The harness uses this to decide
// whether the next request would cross the compaction threshold.
export const estimatePromptTokens = (
  messages: ProviderMessage[],
  options: { system?: string; tools?: readonly ProviderToolDef[] } = {},
): number => {
  let chars = 0;
  if (options.system !== undefined) chars += options.system.length;
  if (options.tools !== undefined) {
    for (const t of options.tools) chars += charsInTool(t);
  }
  for (const m of messages) chars += charsInMessage(m);
  return Math.ceil(chars / 4);
};
