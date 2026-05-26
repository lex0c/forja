// OpenAI-specific tokenizer using `gpt-tokenizer`'s o200k_base encoding
// (the BPE OpenAI ships with GPT-4o, GPT-4.1, GPT-5, o-series). Spec
// TOKEN_TUNING.md §8.1 calls out tiktoken-class tokenizers as
// "preciso ~0.5% error" vs the chars/4 heuristic's ~5-25%.
//
// We import o200k_base statically — every operator session that wires
// the OpenAI provider pays the encoding's startup cost (~1MB of BPE
// tables loaded into memory) regardless of whether tokens are actually
// counted on this turn. Lazy dynamic-import would make the harness
// pre-flight async, which is contagious upward; the cost is real but
// one-shot, and the build's `bun build --compile` bundles the
// encoding into the single binary so there's no runtime fetch.
//
// We deliberately do NOT also import cl100k_base (older GPT-3.5/GPT-4
// pre-4o models). The cost is paid per-encoding, and the modern
// fleet (GPT-4o/4.1/5/o-series) has converged on o200k_base — the
// legacy tokenizer is one extra MB for accuracy on a model family
// the project's `evals/` and `recap` config sites don't target.
// When a legacy GPT-3.5/4 model is detected (out of scope here), the
// chars/4 fallback is acceptable; ~5% drift on a deprecated model
// path isn't worth a static-import bloat.

import { countTokens as countTokensO200k } from 'gpt-tokenizer/encoding/o200k_base';
import type { ProviderMessage, ProviderToolDef } from './types.ts';

// Run the o200k_base tokenizer on a piece of text. Wraps the upstream
// function so the rest of the codebase doesn't import gpt-tokenizer
// directly — keeps the dependency surface narrow and substitutable
// (e.g., a future Bun-native tiktoken or an OpenAI-hosted count
// endpoint would slot in here without rippling out).
//
// Empty / whitespace-only inputs short-circuit. The encoder handles
// them correctly but the call has overhead; turns where the message
// list is brief (a single user prompt of 8 chars) read better as 2
// tokens via the encoder, but the harness's pre-flight covers
// thousands of messages on long sessions and the short-circuit
// matters there, not here.
const countText = (text: string): number => {
  if (text.length === 0) return 0;
  return countTokensO200k(text);
};

// Tokens contributed by a single message. Mirrors the chars/4 walker
// in `tokens.ts`: text blocks get their content; tool_use blocks
// serialize the function name + JSON-encoded args; tool_result
// blocks count the result content + the correlation id (which IS
// shipped to the model as part of the message envelope).
//
// We add a small per-message overhead (3 tokens) to approximate
// OpenAI's role/content framing tokens — the docs call out
// "~4 tokens per message" for chat completions; we use 3 to lean
// slightly under (matches the spec convention of conservative
// undercounting on the harness side, which over-estimates the
// SAFETY margin and triggers compaction earlier rather than later).
const MESSAGE_FRAMING_TOKENS = 3;

const tokensInMessage = (m: ProviderMessage): number => {
  let total = MESSAGE_FRAMING_TOKENS;
  if (typeof m.content === 'string') return total + countText(m.content);
  for (const block of m.content) {
    if (block.type === 'text') {
      total += countText(block.text);
    } else if (block.type === 'tool_use') {
      total += countText(block.name);
      total += countText(JSON.stringify(block.input));
    } else {
      // tool_result. The correlation id is shipped to the model in
      // the assistant-turn echo, so it counts toward the wire payload.
      total += countText(block.tool_use_id);
      total += countText(block.content);
    }
  }
  return total;
};

const tokensInTool = (t: ProviderToolDef): number =>
  countText(t.name) + countText(t.description) + countText(JSON.stringify(t.input_schema));

// Estimate the FULL outbound prompt (messages + optional system +
// optional tool schemas) using o200k_base. Used by the OpenAI
// provider's `countTokens` and by the harness's pre-flight estimate
// dispatcher in `tokens.ts`.
export const estimateOpenAIPromptTokens = (
  messages: ProviderMessage[],
  options: { system?: string; tools?: readonly ProviderToolDef[] } = {},
): number => {
  let total = 0;
  if (options.system !== undefined) total += countText(options.system);
  if (options.tools !== undefined) {
    for (const t of options.tools) total += tokensInTool(t);
  }
  for (const m of messages) total += tokensInMessage(m);
  return total;
};

// Estimate just the messages array (no system / no tools). Used by
// Provider.countTokens, whose interface only takes messages.
export const estimateOpenAIMessagesTokens = (messages: ProviderMessage[]): number => {
  let total = 0;
  for (const m of messages) total += tokensInMessage(m);
  return total;
};

// Plain-text token count for output-side accounting (no message
// framing). Used by the tokenizer-discrepancy detector to score
// the model's streamed `text` against `usage.output_tokens`.
export const estimateOpenAITextTokens = (text: string): number => countText(text);
