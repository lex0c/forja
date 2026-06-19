import { OPENAI_REASONING_EFFORT } from '../effort.ts';
import {
  type GenerateRequest,
  type ProviderCapabilities,
  flattenSystemSegments,
} from '../types.ts';

// OpenRouter messages are OpenAI-shape with one superset field we use:
// `reasoning_details` round-trips the model's structured reasoning across tool
// turns (the OpenRouter replay mechanism). text / tool_use / tool_result map
// exactly like the OpenAI adapter; the divergence is the reasoning slot, so this
// lives here rather than reusing `toOpenAIMessages` (which drops reasoning).

export interface ORToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Structured content block. Only used to carry an explicit prompt-cache marker
// on the system prompt (qwen-style explicit caching); plain turns stay strings.
export interface ORTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ORMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | ORTextBlock[];
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
  // Replayed verbatim (the array captured by the stream normalizer). The model
  // owns its shape — we never canonicalize it.
  reasoning_details?: unknown;
}

// Build the system message. With explicit prompt caching on (qwen-style models
// that require `cache_control` breakpoints), emit structured text blocks and put
// an ephemeral marker on the `cacheBreakpoint` segments — mirroring the Anthropic
// adapter's split (cache.ts) so the stable system prefix is cached across an
// agentic loop. Automatic-cache and no-cache models send the flat string (no
// markers needed). Returns undefined when there's no system prompt.
const buildSystemMessage = (
  req: GenerateRequest,
  explicitCache: boolean,
): ORMessage | undefined => {
  if (explicitCache && req.systemSegments !== undefined) {
    // Re-add the '\n\n' joiner flattenSystemSegments uses between segments: the
    // OpenAI-shape wire concatenates content-part text with NO separator, so
    // without this the model would see the segments glued and the bytes would
    // diverge from the canonical system string (and its recorded hash).
    const nonEmpty = req.systemSegments.filter((seg) => seg.text.length > 0);
    const blocks: ORTextBlock[] = nonEmpty.map((seg, i) => {
      const text = i < nonEmpty.length - 1 ? `${seg.text}\n\n` : seg.text;
      return seg.cacheBreakpoint
        ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text };
    });
    return blocks.length > 0 ? { role: 'system', content: blocks } : undefined;
  }
  const sys = req.systemSegments ? flattenSystemSegments(req.systemSegments) : req.system;
  if (sys === undefined || sys.length === 0) return undefined;
  // No segments but caching is wanted: cache the whole (stable) system string.
  if (explicitCache) {
    return {
      role: 'system',
      content: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    };
  }
  return { role: 'system', content: sys };
};

// req.system (+ systemSegments) and the ProviderMessage[] → OpenRouter's flat
// message list. Internal roles are only user/assistant; `system` comes from the
// request field, and `tool_result` blocks become standalone `role:'tool'`
// messages (OpenAI requires tool results to be their own messages).
export const toOpenRouterMessages = (
  req: GenerateRequest,
  reasoningReplay = false,
  explicitCache = false,
): ORMessage[] => {
  const out: ORMessage[] = [];

  const systemMessage = buildSystemMessage(req, explicitCache);
  if (systemMessage !== undefined) {
    out.push(systemMessage);
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: ORToolCall[] = [];
    const toolResults: ORMessage[] = [];
    let reasoningData: unknown;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          if (msg.role !== 'assistant') {
            throw new Error('tool_use blocks must appear on assistant messages');
          }
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case 'tool_result': {
          if (msg.role !== 'user') {
            throw new Error('tool_result blocks must appear on user messages');
          }
          // OpenAI-shape tool messages have no is_error field; flag it inline so
          // the failure signal survives (mirrors the ollama adapter).
          const content = block.is_error === true ? `[tool error] ${block.content}` : block.content;
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
          break;
        }
        case 'reasoning':
          // Replay only our own provider's captured reasoning_details; a
          // foreign-tagged block (or replay off) falls through to a drop.
          if (reasoningReplay && block.provider === 'openrouter') {
            reasoningData = block.data;
          }
          break;
      }
    }

    // Tool results first — they answer the prior assistant turn.
    out.push(...toolResults);

    if (msg.role === 'assistant') {
      const content = textParts.length > 0 ? textParts.join('') : null;
      // Only emit a message when it carries content or tool_calls. A reasoning-
      // only turn (content:null, no tools) is an invalid OpenAI-shape assistant
      // message — drop it; reasoning_details has no replay value without the
      // content/tool turn it belongs to.
      if (content !== null || toolCalls.length > 0) {
        const m: ORMessage = { role: 'assistant', content };
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        if (reasoningData !== undefined) m.reasoning_details = reasoningData;
        out.push(m);
      }
    } else if (textParts.length > 0) {
      out.push({ role: 'user', content: textParts.join('') });
    }
  }

  return out;
};

// The unified OpenRouter `reasoning` request object. Gated on the model's
// reasoning surface; `thinking_budget` (the explicit on/off override) wins over
// `effort`. `effort` maps through the shared OpenAI ladder (max→xhigh).
export interface ORReasoningParam {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'none';
  max_tokens?: number;
  enabled?: boolean;
}

export const buildReasoningParam = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): ORReasoningParam | undefined => {
  if (caps.supports_reasoning_effort !== true) return undefined;
  if (req.thinking_budget !== undefined) {
    // `effort:'none'` is OpenRouter's documented disable (a mandatory-reasoning
    // model rejects it — that is the operator forcing off a model that can't be).
    return req.thinking_budget > 0 ? { max_tokens: req.thinking_budget } : { effort: 'none' };
  }
  if (req.effort !== undefined) {
    return { effort: OPENAI_REASONING_EFFORT[req.effort] };
  }
  return undefined;
};
