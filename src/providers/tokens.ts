import {
  estimateOpenAIMessagesTokens,
  estimateOpenAIPromptTokens,
  estimateOpenAITextTokens,
} from './tokens-openai.ts';
import type { ProviderFamily, ProviderMessage, ProviderToolDef } from './types.ts';

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

// Per-provider prompt-token estimator. Dispatches on `ProviderFamily`
// to pick the most accurate LOCAL tokenizer available (TOKEN_TUNING.md
// §8.1):
//   - openai → tiktoken o200k_base via `tokens-openai.ts` (~0.5% error)
//   - everything else → chars/4 heuristic (~5-25% error)
//
// Used by the harness pre-flight (forwarded to the chip as
// `inputEstimated`) AND by the tokenizer-discrepancy detector so the
// `chars/4 vs official` ratio collapses to near-zero on OpenAI, and
// the forensic signal stays meaningful for the heuristic providers.
// Anthropic stays on chars/4 because their tokenizer isn't public
// and any community port would drift relative to billed counts.
export const estimatePromptTokensFor = (
  family: ProviderFamily,
  messages: ProviderMessage[],
  options: { system?: string; tools?: readonly ProviderToolDef[] } = {},
): number => {
  if (family === 'openai') return estimateOpenAIPromptTokens(messages, options);
  return estimatePromptTokens(messages, options);
};

// Per-provider just-the-messages estimator. Mirror of the dispatch
// above for the Provider.countTokens interface.
export const estimateMessagesTokensFor = (
  family: ProviderFamily,
  messages: ProviderMessage[],
): number => {
  if (family === 'openai') return estimateOpenAIMessagesTokens(messages);
  return estimateMessagesTokens(messages);
};

// Per-provider plain-text estimator for OUTPUT-side accounting (no
// message framing, just the streamed assistant text). Used by the
// tokenizer-discrepancy detector against `usage.output_tokens`.
export const estimateTextTokensFor = (family: ProviderFamily, text: string): number => {
  if (family === 'openai') return estimateOpenAITextTokens(text);
  // Chars/4 with ceiling — empty string contributes 0.
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
};
