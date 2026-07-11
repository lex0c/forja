import { deriveSeedFromRequest } from '../seed.ts';
import {
  flattenSystemSegments,
  type GenerateRequest,
  type ProviderCapabilities,
  type ProviderToolDef,
} from '../types.ts';
import type { OllamaMessage, OllamaToolCall } from './http.ts';

// Default ceiling for num_ctx. Ollama sizes a KV cache to num_ctx, so defaulting
// to a model's full capacity (up to 262144 on the 256K models) would OOM typical
// local hardware. We cap the served window here; an explicit numCtx /
// FORJA_OLLAMA_NUM_CTX override (resolved in the factory) bypasses the cap.
export const DEFAULT_OLLAMA_NUM_CTX = 32_768;

// `req.system` (+ systemSegments) and the ProviderMessage[] → Ollama's flat
// message list. Internal roles are only user/assistant; `system` comes from the
// request field, and `tool_result` blocks become standalone `role:'tool'`
// messages. Reasoning blocks are dropped (Ollama has no reasoning-replay channel).
export const toOllamaMessages = (
  req: GenerateRequest,
  reasoningReplay = false,
): OllamaMessage[] => {
  const out: OllamaMessage[] = [];

  const sys = req.systemSegments ? flattenSystemSegments(req.systemSegments) : req.system;
  if (sys !== undefined && sys.length > 0) {
    out.push({ role: 'system', content: sys });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    let text = '';
    let thinking = '';
    const toolCalls: OllamaToolCall[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          text += block.text;
          break;
        case 'tool_use':
          toolCalls.push({ function: { name: block.name, arguments: block.input } });
          break;
        case 'tool_result': {
          // Ollama has no per-call id; it correlates a tool result by name (the
          // harness populates `name` for exactly this — omitted ⇒ Ollama falls
          // back to positional order). A failed result is flagged inline because
          // Ollama's tool message has no is_error field.
          const content = block.is_error === true ? `[tool error] ${block.content}` : block.content;
          const m: OllamaMessage = { role: 'tool', content };
          if (block.name !== undefined) {
            m.tool_name = block.name;
          }
          out.push(m);
          break;
        }
        case 'reasoning':
          // Round-trip the model's thinking on tool follow-ups when replay is on
          // (Ollama's tool-calling guidance). The block is the opaque
          // { thinking: string } the stream normalizer captured; foreign-tagged
          // blocks and the replay-off case fall through to a drop.
          if (
            reasoningReplay &&
            block.provider === 'ollama' &&
            block.data !== null &&
            typeof block.data === 'object'
          ) {
            const t = (block.data as { thinking?: unknown }).thinking;
            if (typeof t === 'string') {
              thinking += t;
            }
          }
          break;
      }
    }

    if (text.length > 0 || toolCalls.length > 0 || thinking.length > 0) {
      const m: OllamaMessage = { role: msg.role, content: text };
      if (thinking.length > 0) {
        m.thinking = thinking;
      }
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls;
      }
      out.push(m);
    }
  }

  return out;
};

// ProviderToolDef[] → Ollama's OpenAI-style tools array.
export const toOllamaTools = (tools?: ProviderToolDef[]): unknown[] | undefined => {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
};

// `effort` → `think`. F1 maps any requested effort to a boolean on thinking-
// capable models (gpt-oss's low/medium/high levels are F3). Returns undefined
// when the model has no thinking surface or no effort was requested (model default).
export const effortToThink = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): boolean | undefined => {
  if (caps.supports_reasoning_effort !== true) {
    return undefined;
  }
  // `thinking_budget` is the explicit on/off override (PLAYBOOKS §1.1): 0 disables
  // reasoning, a positive value enables it — it wins over `effort` so an eval /
  // playbook can force a deterministic no-thinking run. `effort` is the fallback:
  // any requested level maps to Ollama's boolean think.
  if (req.thinking_budget !== undefined) {
    return req.thinking_budget > 0;
  }
  if (req.effort !== undefined) {
    return true;
  }
  return undefined;
};

// Sampling + window options. `num_ctx` defaults to the model window capped at
// DEFAULT_OLLAMA_NUM_CTX (Ollama's own default truncates silently, but its full
// capacity would OOM); `numCtx` (factory option / env) overrides the cap.
// Optional sampling fields are omitted when unset. `seed` uses the shared
// request-derived seed (matches the OpenAI/Google determinism path).
export const ollamaOptions = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
  numCtx?: number,
): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    num_ctx: numCtx ?? Math.min(caps.context_window, DEFAULT_OLLAMA_NUM_CTX),
    num_predict: req.max_tokens,
  };
  if (req.temperature !== undefined) {
    options.temperature = req.temperature;
  }
  if (req.top_p !== undefined) {
    options.top_p = req.top_p;
  }
  if (req.stop_sequences !== undefined && req.stop_sequences.length > 0) {
    options.stop = req.stop_sequences;
  }
  if (req.seed_in_eval === true) {
    options.seed = deriveSeedFromRequest(req);
  }
  return options;
};
