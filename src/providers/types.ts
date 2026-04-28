// Canonical provider types per AGENTIC_CLI §14 and PROVIDERS.md §1.
//
// `sampling: SamplingSupport` from PROVIDERS.md §1 is intentionally omitted
// in M1 — it's coupled to TOKEN_TUNING.md §10, which is its own subsystem
// step. Will be added when that step lands.

export type ProviderFamily = 'anthropic' | 'openai' | 'ollama' | 'llama_cpp' | 'google' | 'mistral';

export type ToolCallingMode = 'native' | 'adapted';
export type CacheMode = 'server_5min' | 'server_persistent' | 'client_only';
export type ConstrainedKind = 'gbnf' | 'json_mode' | 'tools' | 'regex';
export type PromptDialect = 'claude' | 'openai_chat' | 'llama3' | 'qwen' | 'deepseek';

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface ProviderCapabilities {
  // Core features
  tools: ToolCallingMode | false;
  cache: CacheMode | false;
  vision: boolean;
  streaming: boolean;
  constrained: ConstrainedKind | false;

  // Limits
  context_window: number;
  output_max_tokens: number;

  // Hints (non-blocking)
  recommended_max_tools_per_step?: number;
  prompt_template_dialect?: PromptDialect;

  // Cost (USD per 1k tokens — values are illustrative per spec §5)
  cost_per_1k_input: number;
  cost_per_1k_output: number;
  cost_per_1k_cached_input?: number;
  cost_per_1k_cache_write?: number;

  // Operational
  max_rps?: number;
  notes: string[];
}

// Per-turn token usage as reported by the provider. Adapters surface this
// once per turn (typically right before `stop`); not every provider exposes
// every field. `cache_read` / `cache_creation` are zero when the provider
// has no cache or the turn didn't touch one.
export interface UsageInfo {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

// Canonical stream event taxonomy. Adapters normalize provider-specific
// events into this single shape (CONTRACTS.md §4).
export type StreamEvent =
  | { kind: 'start'; message_id: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial_args: string }
  | { kind: 'tool_use_stop'; id: string; final_args: Record<string, unknown> }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'usage'; usage: UsageInfo }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

// Provider-level message shape. Distinct from storage's `Message`: this is
// what goes on the wire to a provider, not what we persist.
export type ProviderMessageRole = 'user' | 'assistant';

export interface ProviderTextBlock {
  type: 'text';
  text: string;
}

export interface ProviderToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  // Optional function name. Anthropic and OpenAI correlate tool results
  // back to their calls by id; Gemini correlates by name and has no
  // per-call id, so the harness populates this field for Gemini compat.
  // Other adapters can ignore it.
  name?: string;
  content: string;
  is_error?: boolean;
}

export type ProviderContentBlock =
  | ProviderTextBlock
  | ProviderToolUseBlock
  | ProviderToolResultBlock;

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string | ProviderContentBlock[];
}

// Tool input schemas must declare `type: 'object'` to be accepted by both
// Anthropic and OpenAI tool calling. Anything else is a malformed schema.
export interface ProviderToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
}

export interface ProviderToolDef {
  name: string;
  description: string;
  input_schema: ProviderToolInputSchema;
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  max_tokens: number;
  temperature?: number;
  stop_sequences?: string[];
  metadata?: Record<string, string>;
}

export interface ConstrainedRequest extends GenerateRequest {
  output_schema: Record<string, unknown>;
}

export interface Provider {
  id: string;
  family: ProviderFamily;
  capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): AsyncIterable<StreamEvent>;
  generateConstrained(req: ConstrainedRequest): Promise<string>;
  countTokens(messages: ProviderMessage[]): Promise<number>;
}
