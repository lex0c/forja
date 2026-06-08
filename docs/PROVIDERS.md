# Forja Providers Guide

This document describes Forja's provider layer as **implemented**: the single
adapter abstraction every model family is funnelled through, how model ids
resolve, what each capability gates, the streaming contract adapters normalize
onto, and the per-provider specifics (paths, cache strategy, reasoning, sampling).
It is for contributors extending an adapter or adding a model, and for operators
who want to know what each `--model` actually does.

The canonical specification lives in `docs/spec/PROVIDERS.md`, with local models
in `docs/spec/LOCAL_MODELS.md` and the adapter contract in
`docs/spec/AGENTIC_CLI.md §14` / `docs/spec/CONTRACTS.md §4` (PT-BR). This is the
English-language implementation reference; when the two diverge, the spec wins —
but note the code is sometimes ahead of or behind the spec, so trust `src/` for
current behavior.

The root stance:

> **One abstraction, cheap per-adapter translation — never per-model special-casing.**

A cross-provider feature is built once at the canonical level and each adapter
does a thin translation into its SDK's shape. `effort` is the reference example:
one agnostic level, mapped per adapter.

---

## 1. The `Provider` interface

Every adapter implements one interface (`src/providers/types.ts`):

```ts
interface Provider {
  id: string;                 // canonical, e.g. "openai/gpt-5.3-codex"
  family: ProviderFamily;     // 'anthropic' | 'openai' | 'google' | ...
  capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): AsyncIterable<StreamEvent>;
  generateConstrained(req: ConstrainedRequest): Promise<ConstrainedResult>;
  countTokens(messages: ProviderMessage[]): Promise<number>;
}
```

- **`generate`** — the agentic hot path. Always streamed; yields canonical
  `StreamEvent`s (§4). The harness loop drives it.
- **`generateConstrained`** — structured output via **forced tool/function
  calling** (not strict JSON schema / `response_format`), for leniency. Returns
  the raw JSON arguments string + usage. Used by recap and any
  schema-constrained render.
- **`countTokens`** — pre-flight estimate. Anthropic and Google have server
  endpoints; OpenAI uses a chars/4 heuristic (`src/providers/tokens.ts`). It is
  currently **unconsumed** by live call sites (compaction uses its own estimate;
  billing is exact from the response `usage`), so the OpenAI estimate has no
  observable effect today — a real tokenizer lands only when 4.9 wires
  `countTokens` into budgeting.

The three implemented adapters live in `src/providers/{anthropic,openai,google}/`.
`ProviderFamily` also declares `ollama`, `llama_cpp`, and `mistral` for the local
/ future path; those have no catalog entries yet.

---

## 2. Registry and model ids

Models are addressed by a **fully-qualified id**, `family/model`
(e.g. `anthropic/claude-opus-4-8`, `openai/gpt-5.3-codex`). The registry
(`src/providers/registry.ts`) maps an id to a `{ family, modelName, factory }`
entry; each family registers its catalog via `register.ts`. The default when no
`--model` is given is `anthropic/claude-opus-4-8` (`src/providers/default-model.ts`).

The shipped catalogs (`<family>/capabilities.ts`):

| Family | Models |
|---|---|
| **anthropic** | `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| **openai** | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-4o`, `gpt-4o-mini` |
| **google** | `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |

Adding a model is usually a catalog entry (§8); the registry test
(`tests/providers/registry.test.ts`) asserts every catalog model is registered
exactly once.

---

## 3. Capabilities

`ProviderCapabilities` (`src/providers/types.ts`) is the per-model declaration
that gates behavior. Key fields:

| Field | Gates |
|---|---|
| `tools` | `'native' \| 'adapted' \| false` — tool calling support |
| `cache` | `'server_5min' \| 'server_persistent' \| 'client_only' \| false` |
| `streaming`, `vision` | feature flags |
| `constrained` | `'tools' \| 'json_mode' \| 'gbnf' \| 'regex' \| false` — how structured output is forced |
| `context_window`, `output_max_tokens` | size limits |
| `supports_sampling` | `false` ⇒ strip `temperature`/`top_p` (reasoning models 400 on them) |
| `supports_adaptive_thinking` | Anthropic adaptive thinking |
| `supports_reasoning_effort` | reasoning models; on OpenAI this **also routes** gpt-5.x to the Responses path (§5.2) |
| `max_rps`, `recommended_max_tools_per_step` | pacing hints |
| `cost_per_1k_*` | per-**million**-token USD rates (the `_1k_` name is legacy; cost divides by 1e6 — see `src/providers/cost.ts`) |

The capability is the single source of truth: adapters read it to decide what to
send, so a model's quirks are data, not branches.

---

## 4. The streaming contract

All adapters normalize their SDK's stream onto one canonical union
(`StreamEvent`, `src/providers/types.ts`), consumed by the harness collector
(`src/harness/collect.ts`):

```
start{message_id} · text_delta{text} · thinking_delta{text}
tool_use_start{id,name} · tool_use_delta{id,partial_args} · tool_use_stop{id,final_args}
usage{usage} · stop{reason} · error{code,message,retryable}
```

The collector takes the tool args from `tool_use_stop.final_args` (the normalizer
is responsible for accumulating them). `stop.reason` is `tool_use` when the turn
emitted any tool call (so the loop continues), else `end_turn` / `max_tokens` /
etc. Each adapter has its own normalizer: `anthropic/stream.ts`,
`openai/stream.ts` (Chat Completions), `openai/responses-stream.ts` (Responses),
`google/stream.ts`.

---

## 5. Per-provider notes

### 5.1 Anthropic (reference implementation)

The most complete adapter (`anthropic/index.ts`). Native tool use, adaptive
thinking, and the only provider with **explicit, Forja-controlled cache
breakpoints** (`anthropic/cache.ts`): `cache_control: {type:'ephemeral'}` markers
anchored on the stable prefix (system + tools + the breakpoints
`CONTEXT_TUNING.md §3.1` declares). Read at 0.1× input cost; write at 1.25×
(5-minute) or 2× (1-hour). The 1-hour TTL is opt-in via
`FORJA_ANTHROPIC_CACHE_TTL=1h`.

### 5.2 OpenAI (two paths, routed by capability)

`openai/index.ts` routes by `caps.supports_reasoning_effort`:

- **Chat Completions** (`gpt-4o`, `gpt-4o-mini`) — `client.chat.completions`.
  `reasoning_effort` (flat) only for reasoning-capable models; `max_tokens`.
- **Responses API** (`gpt-5.x`, incl. `gpt-5.3-codex`) — `client.responses`,
  `/v1/responses`. Reasoning models 400 on the tools+`reasoning_effort`
  combination in Chat Completions ("use /v1/responses instead"), and the
  Responses API is OpenAI's recommended surface for agentic/tool-heavy flows.
  Different request shape: `input` items (not `messages`), `instructions`, flat
  tools, `reasoning.{effort}`, `max_output_tokens`. Forja drives it **stateless**
  (`store: false`, full input each turn) to keep its own session/resume store
  authoritative. Built in `openai/responses.ts` + `openai/responses-stream.ts`.

Both paths set **`prompt_cache_key`** (a sha256 of system+tools — the stable
prefix) for cache routing, gated on a real-OpenAI `baseURL` (a custom endpoint
may 400 on the unknown param). OpenAI caches automatically; there are no explicit
breakpoints like Anthropic. The **sampling gate** strips `temperature`/`top_p`
for `supports_sampling: false` models (the gpt-5.x reasoning models).

> Reasoning continuity (replaying the Responses `reasoning` items across tool
> round-trips, which OpenAI documents for stateless mode) was implemented and
> **reverted** — an A/B on `gpt-5.3-codex` showed zero measured benefit on the
> structured suite (Forja's full-history-every-turn already gives the model the
> thread it needs to continue). Re-add only with a long-horizon eval.

### 5.3 Google / Gemini

`google/index.ts`. Native function calling; `generateConstrained` forces a call
via `toolConfig.functionCallingConfig {mode:'ANY'}`. Sampling gate present
(currently a no-op — Gemini models accept sampling). Explicit context caching
(`CachedContent`) is **not yet wired** — Gemini relies on whatever implicit
caching the API does.

---

## 6. Cross-cutting conventions

**Usage** is uniform across providers (`UsageInfo`): `input = max(0, prompt −
cached)`, `cache_read = cached`, `cache_creation = 0` except Anthropic (the only
provider with a cache-write premium). Billing is exact from the response usage —
not from `countTokens`.

**Cost** — `computeCost(caps, usage)` and `computeCostBreakdown(caps, usage)`
(`src/providers/cost.ts`); rates are per-million USD on the capability.

**Effort** — one agnostic level (`low|medium|high|max`, `src/providers/effort.ts`)
translated per adapter: Anthropic `effort`; OpenAI `reasoning_effort` /
`reasoning.effort` with `max → xhigh`. Omitted for models that don't support it.

**Cache strategy** at a glance:

| Provider | Mechanism | Forja's lever |
|---|---|---|
| Anthropic | explicit `cache_control` breakpoints (5min / 1h) | full control — Forja places the markers |
| OpenAI | automatic prefix caching | `prompt_cache_key` routing (both paths) |
| Gemini | implicit | none wired yet (`CachedContent` pending) |

**Retry** is **shared, not per-adapter** — `src/harness/retry.ts` wraps the
provider call at the harness level, so all families get the same policy: retry on
5xx / 429 / network with exponential backoff (`base · 4^(attempt−1)`), up to 3
attempts, and only when no events have streamed yet (per `CONTRACTS.md §4`).

---

## 7. Determinism, sampling, and stop reasons

- **Seed** — `deriveSeedFromRequest` (`src/providers/seed.ts`) gives a stable
  seed where the SDK supports it (`PLAYBOOKS.md §1.1` determinism intent).
- **Canonical JSON** — `stableStringify` (`src/providers/canonical-json.ts`)
  sorts keys for any prompt-bound serialization (e.g. the cache-key tool list),
  so cache keys are order-independent.
- **Stop reasons** map onto `StopReason` (`end_turn | tool_use | max_tokens |
  stop_sequence | refusal`); the harness keys loop continuation off `tool_use`.

---

## 8. Extending the layer

**Add a model** to an existing family: add a `capabilities.ts` entry (id, context
window, output cap, cost rates, the `supports_*` flags). Routing and tests follow
from the capability — e.g. an OpenAI model with `supports_reasoning_effort: true`
automatically uses the Responses path. Validate live before trusting it (a probe
+ the structured suite via `bun run src/evals/cli.ts evals/smoke --model <id>`).

**Add a provider family**: implement the `Provider` interface, a `register.ts`
that populates the registry, a `capabilities.ts` catalog, and a `stream.ts`
normalizer onto the canonical `StreamEvent`. Reuse the shared retry/cost/effort
machinery rather than re-implementing it. A subsystem without eval doesn't ship —
add smoke coverage (`evals/`, parameterized via `SMOKE_MODEL`).
