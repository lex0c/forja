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
  replaysReasoning?: boolean;  // does this instance actually replay reasoning on the wire?
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
- **`replaysReasoning`** — whether this provider instance replays reasoning blocks
  onto the wire (resolved in the factory from the env flag + capability + send
  path). Consumers that size the prompt (the compaction trigger, token estimators)
  read it to decide whether replayed reasoning payloads count against the window.
- **`countTokens`** — pre-flight estimate. Anthropic and Google have server
  endpoints; OpenAI uses a chars/4 heuristic (`src/providers/tokens.ts`). It is
  currently **unconsumed** by live call sites (compaction uses its own estimate;
  billing is exact from the response `usage`), so the OpenAI estimate has no
  observable effect today — a real tokenizer lands only when 4.9 wires
  `countTokens` into budgeting.

The five implemented adapters live in
`src/providers/{anthropic,openai,google,ollama,openrouter}/`. `ProviderFamily` also
declares `llama_cpp` and `mistral` for the future local path; those have no catalog
entries yet.

---

## 2. Registry and the model catalog

Models are addressed by a **fully-qualified id**, `family/model`
(e.g. `anthropic/claude-opus-4-8`, `ollama/qwen3:14b`). At boot the registry
(`src/providers/registry.ts`) is built from the operator-owned catalog file
`~/.config/forja/model_providers.json` — `loadModelRegistry`
(`src/providers/catalog-file.ts`) reads it and maps each id to a
`{ family, modelName, capabilities, factory }` entry. That file is the **runtime
source of truth**: running `forja init` to write it is mandatory; with no
catalog, boot aborts pointing at `forja init` rather than silently falling back
to a built-in list. The default when no `--model` is given is
`anthropic/claude-opus-4-8` (`src/providers/default-model.ts`).

The in-binary `<family>/capabilities.ts` constants are no longer the runtime
catalog — they are the **seed** (`src/providers/seed-catalog.ts`,
`CANONICAL_MODEL_PROVIDERS`) that `forja init` materializes into the file. The
seeded models:

| Family | Models |
|---|---|
| **anthropic** | `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| **openai** | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-4o`, `gpt-4o-mini` |
| **google** | `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| **ollama** (local) | `qwen2.5-coder:7b/14b`, `qwen3:8b/14b`, `llama3.1:8b`, `mistral-nemo:12b`, `gpt-oss:20b` — all native tool calling, `$0` |
| **ollama** (cloud) | `glm-5.2`, `qwen3-coder:480b`, `qwen3-coder-next`, `devstral-2:123b` — hosted on `ollama.com`, seeded with `base_url` + `api_key_env`; need `OLLAMA_API_KEY` (see § Ollama — cloud) |
| **openrouter** (gateway) | `deepseek/deepseek-v3.2`, `deepseek/deepseek-r1`, `qwen/qwen3-coder-plus`, `x-ai/grok-4.3`, `z-ai/glm-4.6`, `moonshotai/kimi-k2-thinking`, `meta-llama/llama-3.3-70b-instruct` — models not reachable as a first-class family; ids are `openrouter/<vendor>/<model>` (two slashes) |

To add, remove, or adjust a model, edit the file (§2.1) — no recompile. The
registry test (`tests/providers/registry.test.ts`) asserts every seeded model
builds; `tests/providers/catalog-file.test.ts` covers the file loader.

### 2.1 Configuring the model catalog (`model_providers.json`)

`forja init` writes `~/.config/forja/model_providers.json` (user scope,
profile-aware) seeded with the built-in models. It is operator-owned — edit it to
register a local model you pulled, point at an OpenAI-/Anthropic-compatible
endpoint, tweak a price or window, or remove models you do not use. When the file
is present it is the **exclusive** catalog (a model you delete stays deleted);
the binary never overwrites it. `forja init --force=model_providers` re-syncs it
from the seed.

Each entry:

```json
{
  "version": 1,
  "models": [
    {
      "id": "anthropic/claude-opus-4-8",
      "family": "anthropic",
      "model_name": "claude-opus-4-8",
      "api_key_env": "ANTHROPIC_API_KEY",
      "capabilities": { "tools": "native", "cache": "server_5min", "...": "..." }
    }
  ]
}
```

- **`id`** — `family/model_name`. `family` must be one Forja ships an adapter for
  (`anthropic`, `openai`, `ollama`, `google`, `openrouter`); the file registers
  *models*, not new adapters (those are a code change — §8). For `openrouter` the
  `model_name` itself is `<vendor>/<model>`, so the id carries two slashes
  (`openrouter/deepseek/deepseek-v3.2`).
- **`model_name`** — what the underlying SDK / HTTP API sees.
- **`api_key_env`** — the env var that holds the API key (never the key itself).
  It is **authoritative**: the cloud adapters have no env fallback of their own,
  so the key comes only from this var. If it is set but the var is unset/empty,
  boot fails naming it. Omit it for local Ollama (no key); a Google user on
  `GEMINI_API_KEY` sets `api_key_env` to `GEMINI_API_KEY`.
- **`base_url`** (optional) — a custom endpoint: a remote/cloud Ollama host, or an
  OpenAI-compatible gateway (vLLM, LM Studio, Azure). OpenRouter is its own
  first-class family (§5.5), not the openai adapter pointed at a gateway.
- **`capabilities`** — the `ProviderCapabilities` shape (§3): tool calling, cache
  mode, context window, output cap, per-1k costs, and the `supports_*` reasoning
  flags.

A malformed entry is dropped with a stderr warning (the rest still load); only an
absent/corrupt file, or a catalog with zero valid models, is fatal.

**Register a local Ollama model** you pulled but that is not seeded:

```json
{ "id": "ollama/deepseek-r1:14b", "family": "ollama", "model_name": "deepseek-r1:14b",
  "capabilities": { "tools": "native", "cache": false, "vision": false, "streaming": true,
    "constrained": "json_mode", "context_window": 131072, "output_max_tokens": 16384,
    "cost_per_1k_input": 0, "cost_per_1k_output": 0, "notes": ["local"] } }
```

**Register an OpenAI-compatible endpoint** (vLLM, a corporate gateway):

```json
{ "id": "openai/gateway-qwen", "family": "openai", "model_name": "Qwen2.5-72B-Instruct",
  "api_key_env": "MY_GATEWAY_KEY", "base_url": "https://gateway.internal/v1",
  "capabilities": { "...": "..." } }
```

Then `--model <id>` (boot) or `/model <id>` (in the REPL) selects it. Because the
catalog is user-scope only, a cloned repo cannot inject a `base_url` / key var.

### 2.2 Quickstart: selecting and running a model

Run `forja init` once (writes the catalog), then pick a model with `--model <id>`
at boot or `/model <id>` in the REPL. Concrete recipes:

#### Ollama — local models

Run on your own machine at `$0`, fully offline. Start the daemon, pull a seeded
model, and select it:

```sh
ollama serve                              # if not already running
ollama pull qwen2.5-coder:14b            # any seeded model (§2)
forja --model ollama/qwen2.5-coder:14b
```

No API key — local inference needs none. Optional tuning (env):

```sh
FORJA_OLLAMA_NUM_CTX=65536               # raise the served window (VRAM trade-off; default cap 32K)
FORJA_OLLAMA_KEEP_ALIVE=30m              # keep the model resident between turns ("-1" = forever)
FORJA_OLLAMA_REASONING_REPLAY=0          # opt out of reasoning replay on thinking models
```

`agent doctor` reports daemon reachability, version, and whether the model is
pulled. To use a pulled model that is not seeded, add a catalog entry (§2.1).

#### Ollama — cloud / remote host

A curated Ollama Cloud tier is already seeded — `glm-5.2`, `qwen3-coder:480b`,
`qwen3-coder-next`, `devstral-2:123b` — each carrying `base_url: https://ollama.com`
and `api_key_env: OLLAMA_API_KEY`, so the only setup is the key:

```sh
export OLLAMA_API_KEY=<your key>
forja --model ollama/qwen3-coder:480b
```

The same adapter also reaches a remote/LAN box or any hosted model NOT in the seed
— point it at the host and pass auth. Via env (applies to every ollama model):

```sh
export FORJA_OLLAMA_BASE_URL=https://ollama.com           # your remote/cloud host
export FORJA_OLLAMA_HEADERS='{"Authorization":"Bearer <OLLAMA_API_KEY>"}'
forja --model ollama/gpt-oss:120b
```

Or persist that model as a catalog entry, so the key comes from an env var that the
adapter maps to a bearer header automatically:

```json
{ "id": "ollama/gpt-oss:120b", "family": "ollama", "model_name": "gpt-oss:120b",
  "base_url": "https://ollama.com", "api_key_env": "OLLAMA_API_KEY",
  "capabilities": { "tools": "native", "cache": false, "vision": false, "streaming": true,
    "constrained": "json_mode", "context_window": 131072, "output_max_tokens": 16384,
    "cost_per_1k_input": 0, "cost_per_1k_output": 0, "notes": ["ollama cloud"] } }
```

A non-localhost host sends your context off the machine — treat it like any cloud
provider.

#### OpenRouter — one key, many models

A gateway: a single `OPENROUTER_API_KEY` reaches models Forja does not ship
first-class (DeepSeek, Qwen-Coder, Grok, GLM, Kimi, Llama). Set the key and select
a seeded model — the id carries the vendor, so it has **two slashes**:

```sh
export OPENROUTER_API_KEY=sk-or-...
forja --model openrouter/deepseek/deepseek-v3.2
```

Any other OpenRouter model works via a catalog entry (§2.1) with
`family: "openrouter"` and `model_name: "<vendor>/<model>"`. Optional env:

```sh
FORJA_OPENROUTER_REFERER=https://your.app      # attribution on the OpenRouter rankings
FORJA_OPENROUTER_TITLE="Your App"
FORJA_OPENROUTER_REASONING_REPLAY=0            # opt out of reasoning replay
```

See §5.5 for what the adapter does with caching, reasoning, and routing.

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
| `supports_adaptive_thinking` | Anthropic adaptive thinking (also gates thinking/replay default-on) |
| `supports_reasoning_effort` | reasoning models; on OpenAI this **also routes** gpt-5.x to the Responses path (§5.2) |
| `supports_effort_xhigh` | model accepts the `xhigh` effort level (Opus 4.7/4.8); else `xhigh` clamps to `high` |
| `extended_prompt_cache` | model supports OpenAI's 24h prompt-cache retention (gpt-5.5, gpt-5.4) |
| `extended_prompt_cache_24h_only` | among those, accepts ONLY `24h` (gpt-5.5) — rejects the `in_memory` opt-out |
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
`google/stream.ts`, `ollama/stream.ts` (native NDJSON).

---

## 5. Per-provider notes

### 5.1 Anthropic (reference implementation)

The most complete adapter (`anthropic/index.ts`). Native tool use, adaptive
thinking, and the only provider with **explicit, Forja-controlled cache
breakpoints** (`anthropic/cache.ts`): `cache_control: {type:'ephemeral'}` markers
anchored on the stable prefix (system + tools + the breakpoints
`CONTEXT_TUNING.md §3.1` declares). Read at 0.1× input cost; write at 1.25×
(5-minute) or 2× (1-hour). The 1-hour TTL is opt-in via
`FORJA_ANTHROPIC_CACHE_TTL=1h`. The cache breakpoint never lands on a
`thinking`/`redacted_thinking` block (Anthropic rejects `cache_control` there) —
it anchors the last cache-eligible block.

**Adaptive thinking is ON by default** on adaptive models (Opus 4.7/4.8, Sonnet
4.6), per Anthropic's guidance to default to adaptive thinking; `effort` guides
DEPTH (`output_config.effort`), not on/off. Opt out globally with
`FORJA_ANTHROPIC_THINKING=0`, or per-call with `thinking_budget: 0`
(disable-via-zero); evals pin it off for determinism. Legacy models (Haiku) stay
off unless given an explicit `thinking_budget`. Because Anthropic 400s on
`thinking` sent with `temperature`/`top_p`, **sampling is stripped whenever
thinking is engaged** (Opus already strips it via `supports_sampling: false`; this
covers Sonnet).

**Reasoning replay is ON by default** (`FORJA_ANTHROPIC_REASONING_REPLAY=0` to opt
out), gated to adaptive models. When thinking is engaged, the signed `thinking` /
`redacted_thinking` blocks round-trip byte-identical with the next `tool_result`
(Anthropic *requires* this) — lifting the old tool-turn suppression so thinking
stays on through the agentic loop. Block order (including thinking interleaved with
tool_use) is preserved verbatim. Replay is near-inert when thinking is off (nothing
to round-trip).

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
breakpoints like Anthropic. **Extended (24h) prompt-cache retention** is sent only
for models OpenAI lists for it (`extended_prompt_cache` — gpt-5.5, gpt-5.4) and
only on real OpenAI; opt out / pick `in_memory` via `FORJA_OPENAI_PROMPT_CACHE_RETENTION`
(a 24h-only model like gpt-5.5 can't honor `in_memory`, so the adapter omits +
warns). The **sampling gate** strips `temperature`/`top_p` for `supports_sampling:
false` models (the gpt-5.x reasoning models).

**Reasoning replay (default ON for the Responses path).** Captured `reasoning`
items are replayed as input on later tool turns (`input` items + `include:
['reasoning.encrypted_content']`), the continuity OpenAI "highly recommends" for
agentic function-calling. Reasoning items are emitted FIRST (before the assistant
message and tool calls) to match the model's output order — OpenAI rejects a
reasoning item not directly followed by the item it generated. Items lacking
`encrypted_content` (captured before replay was on) are dropped rather than 400 in
stateless mode; the gpt-5.3-codex `phase` field rides the same channel. Only the
Responses path replays (Chat Completions drops reasoning); `Provider.replaysReasoning`
reflects this so the prompt-token estimator counts replayed payloads. Opt out with
`FORJA_OPENAI_REASONING_REPLAY=0`. (History: #25 built this, measured zero benefit
on the short suite, and reverted; re-added once the long-horizon eval existed — it
no longer 400s, value is workload-dependent.)

### 5.3 Google / Gemini

`google/index.ts`. Native function calling; `generateConstrained` forces a call
via `toolConfig.functionCallingConfig {mode:'ANY'}`. Sampling gate present
(currently a no-op — Gemini models accept sampling). Explicit context caching
(`CachedContent`) is **not yet wired** — Gemini relies on whatever implicit
caching the API does.

### 5.4 Ollama (local, native `/api/chat`)

`ollama/index.ts` — a native client (raw `fetch`, no SDK) on the daemon's
`/api/chat`. `generate` streams the NDJSON chunk sequence and `ollama/stream.ts`
normalizes it incrementally: `tool_use` is derived from the **accumulated**
`tool_calls` (not just the final chunk), and a stream that ends without a `done`
chunk becomes a typed `local.stream_incomplete` error rather than a fake
zero-token turn. `generateConstrained` is single-shot with `format` (a full JSON
Schema), failing fast on `done_reason: 'length'`. Ollama applies the chat template
itself, so the adapter sends no dialect.

- **Static curated catalog** (`ollama/capabilities.ts`) — only models with
  **native** tool calling; capabilities are honest data (`tools: 'native'`,
  `cache: false`, `vision: false`, cost `$0`). The formal tool-calling adapter for
  non-native models is future work.
- **`num_ctx`** is sent explicitly, capped at 32K (`DEFAULT_OLLAMA_NUM_CTX`) —
  Ollama's own default truncates silently and its full window (up to 256K) would
  OOM typical hardware; override with `FORJA_OLLAMA_NUM_CTX`.
- **`effort` → `think`** (boolean) on thinking-capable models; `thinking_budget`
  is the explicit on/off override (0 disables, >0 enables) and wins over `effort`.
- **Probe / version-gate** (`ollama/probe.ts`): `probeOllama` (reachable + version
  + pulled models) and `ollamaReadiness` (ok/warn/fail + remediation) — backs
  `doctor` and the integration smoke's run-or-skip.
- **Config (env):** `FORJA_OLLAMA_BASE_URL` (daemon host — point it at a remote /
  LAN box), `FORJA_OLLAMA_NUM_CTX`, `FORJA_OLLAMA_KEEP_ALIVE` (model lifetime —
  bare integer ⇒ seconds, Go duration `"5m"` ⇒ string), `FORJA_OLLAMA_HEADERS`
  (extra HTTP headers as JSON, for remote/cloud auth).
- **Defenses:** NDJSON framing with a line cap (anti-OOM) and `safeJsonParse`
  (proto-pollution at the remote boundary); typed errors
  (`local.daemon.unavailable` / `local.model.not_loaded`) with actionable hints;
  abort cancels the in-flight fetch via the stream reader.

### 5.5 OpenRouter (OpenAI-compatible gateway)

`openrouter/index.ts` — a thin adapter reusing the OpenAI SDK as transport
(`baseURL` = `https://openrouter.ai/api/v1` + optional attribution headers), with
its own request builder, normalizer, and curated static catalog. Models are
`openrouter/<vendor>/<model>` (two slashes); the catalog is **OpenRouter-exclusive**
(no anthropic/openai/google duplicates — use those families directly). Operators
add any other OpenRouter model via a catalog entry (§2.1).

- **Reasoning** — the unified `reasoning` object. Only models whose
  `/api/v1/models` exposes `supported_efforts` (here: Grok, `supports_reasoning_effort`)
  get `reasoning.effort` (the shared agnostic ladder, `max`→`xhigh`) /
  `thinking_budget`→`reasoning.max_tokens`, with `effort:'none'` to disable.
  Thinking models that expose only the generic reasoning toggle (DeepSeek / GLM /
  Kimi, `supports_reasoning`) are driven via `reasoning.enabled` — never an effort
  level they would reject. Reasoning
  replay round-trips `reasoning_details` — or, for models that stream only
  plaintext (`delta.reasoning` / the `reasoning_content` alias) with no structured
  details, the accumulated plaintext via the assistant `reasoning` field — across
  tool turns (default ON, `FORJA_OPENROUTER_REASONING_REPLAY=0` to opt out).
- **Caching** — automatic server-side caches are captured passively
  (`cached_tokens` → `cache_read`, `cache_write_tokens` → `cache_creation`). Models
  that need **explicit** breakpoints (Qwen, capability `cache_explicit_breakpoints`)
  get `cache_control` markers on the stable system segments, reusing the same
  `systemSegments` hint as Anthropic (the `\n\n` joiner is re-added so the bytes
  match the canonical system string).
- **Honest window** — `transforms: []` disables OpenRouter's middle-out compression
  so the Forja context engine owns truncation; `context_window` is seeded from the
  served (top-provider) window, not the headline max (same premise as the Ollama
  served-window cap).
- **Usage** — always returned (the legacy `usage:{include}` / `stream_options`
  flags are no-ops; the adapter sends `usage:{include:true}` defensively); cost via
  the seeded per-model rates (`usage.cost` is not consumed yet).
- **Errors** — in-band stream failures (HTTP 200 + `finish_reason:"error"` or an
  `error` object on the chunk) normalize to a typed `error` event, retryable on
  429/5xx.
- **Config (env):** `OPENROUTER_API_KEY` (sole key source, no fallback),
  `FORJA_OPENROUTER_REFERER` / `FORJA_OPENROUTER_TITLE` (attribution),
  `FORJA_OPENROUTER_REASONING_REPLAY`.
- **Not wired (deferred):** response caching (`X-OpenRouter-Cache`), `session_id`
  sticky routing, and `:exacto`/provider-routing controls.

---

## 6. Cross-cutting conventions

**Usage** is uniform across providers (`UsageInfo`): `input = max(0, prompt −
cached)`, `cache_read = cached`, `cache_creation = 0` except Anthropic (the only
provider with a cache-write premium). Billing is exact from the response usage —
not from `countTokens`.

**Cost** — `computeCost(caps, usage)` and `computeCostBreakdown(caps, usage)`
(`src/providers/cost.ts`); rates are per-million USD on the capability.

**Effort** — one agnostic level (`low|medium|high|xhigh|max`, `src/providers/effort.ts`)
translated per adapter: Anthropic `output_config.effort` (`xhigh` clamps to `high`
on models without `supports_effort_xhigh`); OpenAI `reasoning_effort` /
`reasoning.effort` (both `xhigh` and `max` → OpenAI's top `xhigh`). `xhigh` is the
coding/agentic sweet spot (Opus 4.7/4.8). Omitted for models that don't support it.

**Cache strategy** at a glance:

| Provider | Mechanism | Forja's lever |
|---|---|---|
| Anthropic | explicit `cache_control` breakpoints (5min / 1h) | full control — Forja places the markers |
| OpenAI | automatic prefix caching (+ opt-in 24h retention on supported models) | `prompt_cache_key` routing (both paths) |
| Gemini | implicit | none wired yet (`CachedContent` pending) |
| Ollama | none (local, `$0`) | n/a — no server-side cache |
| OpenRouter | per-model: automatic (most) or explicit `cache_control` (Qwen) | passive `cached_tokens` capture; markers on the stable prefix for explicit-cache models |

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

**Add a model** to a family Forja already adapts: edit
`~/.config/forja/model_providers.json` (§2.1) — no recompile. To ship it as a
default (so `forja init` seeds it), add a `<family>/capabilities.ts` entry (id,
context window, output cap, cost rates, the `supports_*` flags); it flows into
`CANONICAL_MODEL_PROVIDERS` automatically. Routing and tests follow from the
capability — e.g. an OpenAI model with `supports_reasoning_effort: true`
automatically uses the Responses path. Validate live before trusting it (a probe
+ the structured suite via `bun run src/evals/cli.ts evals/smoke --model <id>`).

**Add a provider family**: implement the `Provider` interface, a `capabilities.ts`
seed catalog, and a `stream.ts` normalizer onto the canonical `StreamEvent`, then
wire the family into `entryToFactory` (`src/providers/catalog-file.ts`) so a
catalog entry of that family builds the right adapter (passing `capabilities` /
`base_url` / the resolved `api_key_env`). Reuse the shared retry/cost/effort
machinery rather than re-implementing it. A subsystem without eval doesn't ship —
add smoke coverage (`evals/`, parameterized via `SMOKE_MODEL`).
