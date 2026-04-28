# Backlog

Forja progress diary. Entries in reverse chronological order (newest on top).

Format:

```
## [YYYY-MM-DD] <milestone>/<step> — <title>

**Done:** ...
**Decisions:** ...
**Pending:** ...
**Next:** ...
```

---

## [2026-04-27] M1 / Step 3.6 — OpenAI (GPT) adapter

**Done:**
- Added `openai@6.34.0` dependency.
- `src/providers/openai/capabilities.ts` — capabilities for `gpt-4o` and `gpt-4o-mini`. Cache mode declared as `client_only` (OpenAI's prefix-cache is automatic and probabilistic — there is no server-side cache the adapter can target the way Anthropic does).
- `src/providers/openai/stream.ts` — `normalizeOpenAIStream` converts Chat Completions chunks into the canonical `StreamEvent` taxonomy. Handles: id from first chunk (synth fallback), text deltas, refusal field (emitted as text_delta), tool_call accumulation per `index` (id and name may straggle, args streamed across deltas), per-tool finalization at end-of-stream (OpenAI has no per-tool stop event), finish_reason mapping, malformed JSON args drop with error event.
- `src/providers/openai/index.ts` — `createOpenAIProvider(modelName, opts)`. Reads API key from `opts.apiKey` or `OPENAI_API_KEY`; supports `baseURL` for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter). Test seam via `opts.client`. Message conversion is the most complex of the three adapters: a single `ProviderMessage` may produce multiple OpenAI messages (assistant text + tool_calls coalesce; tool_result blocks split into separate `role: 'tool'` messages). System prompt prepended as the first message.
- `src/providers/openai/register.ts` — `registerOpenAIModels(reg)`.
- `createDefaultRegistry` got a one-line addition: `registerOpenAIModels(reg)`. No other registry-side changes — the extensibility refactor from Step 3.5 paid off as designed.
- `tests/providers/openai-stream.test.ts` — **13 tests** covering text-only, tool_call lifecycle (incl. straggling id/name), parallel tool_calls finalized in index order, synthesized id, id-overrides-synth, real-id-not-overwritten regression, refusal as text_delta, content+refusal in the same chunk, finish_reason mapping (6 cases), null doesn't clobber, malformed args, empty stream.
- `tests/providers/openai.test.ts` — **17 tests** covering model rejection, env key, capabilities, generateConstrained stub, generate end-to-end, system prepending, config forwarding (`stream: true` enforced), assistant tool_use coalescing, user tool_result splitting into tool-role messages, mixed tool_results+text ordering regression, tool_result-on-assistant throw, tool_use-on-non-assistant throw, countTokens heuristic (chars/4) on text and on tool blocks.
- `tests/providers/registry.test.ts` updated — asserts OpenAI lineup, total count = sum of all three families, OpenAI factory parity test.
- Total suite now **140 tests / 289 expect() calls** in ~285ms.

**Code-review fixes folded in before commit:**
- `ToolCallInProgress` carries an explicit `idIsSynthesized: boolean` flag instead of relying on the `startsWith('call_')` heuristic. Real OpenAI ids start with `call_` too, so the prefix couldn't tell synth from real — a real id arriving in chunk 1 could (in theory) be silently overwritten by a later chunk. The flag flips false the first time a real id is set and stays there.
- `toOpenAIMessages` now emits `tool_result` messages **before** the user text message when both are present in the same `ProviderMessage`. Reversing the order would make the model see a new user prompt before the tool results it requested in the prior assistant turn.
- Throws on `tool_result` blocks in non-user messages, symmetric to the existing throw for `tool_use` blocks in non-assistant messages. Catches malformed callers at the boundary instead of forwarding nonsense to the API.

**Decisions:**
- **`countTokens` is a chars/4 heuristic**, not a real tokenizer call. OpenAI exposes no server-side `countTokens` endpoint (unlike Anthropic and Google) — proper local impl needs `tiktoken`. The heuristic is within ~10% for English, good enough for budget early-warnings. Replaced with tiktoken when M5 wires the local tokenizer. Documented in code.
- **`delta.refusal` becomes `text_delta`**, not a dedicated event kind. OpenAI's safety refusals are user-visible prose; treating them as text matches what reaches the UI. The accompanying `finish_reason` is `'stop'`, not `'content_filter'`, so no special stop reason needed.
- **`baseURL` is exposed in options** to support Azure OpenAI / OpenRouter / Together / Groq / etc. Same SDK shape; just a different host.
- **Tool args stream across chunks** like Anthropic (unlike Gemini). Tracking is keyed by `tool_calls[].index` (stable across chunks, unlike `id` which arrives only once). Edge cases covered: id arriving in a later chunk, name in a different chunk than the index registration, multiple parallel tool_calls finalized in index order at end-of-stream.
- **`ProviderMessage` → multiple `OpenAIMessage`**: a `user` message containing tool_result blocks can't fit OpenAI's schema (which requires `role: 'tool'` for results), so we split. Documented inline; tests pin the contract.
- **Step 3.5's extensibility refactor paid off**: adding GPT was 4 new files in `src/providers/openai/` + 1 line in `createDefaultRegistry`. No edits to shared types, no edits to `registry.ts`'s `ModelEntry`, no changes to other adapters. This is the regression-bar for "easy to add new providers".
- **Model lineup intentionally narrow** (`gpt-4o` + `gpt-4o-mini`) — matches PROVIDERS.md §2's table. Newer models (gpt-5, o-series reasoning) added when their quirks (no system prompt, hidden reasoning tokens) are characterized — that's its own design exercise.

**Out of scope:**
- Real network coverage (deferred to evals)
- `tiktoken`-based token counting (M5)
- Reasoning models (o1/o3/etc) — different shape, deferred
- Structured outputs via `response_format: json_schema` (deferred until `generateConstrained` ships)
- Azure-specific auth (uses `apiKey` + `baseURL` pattern; full Azure AD OAuth deferred)

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Now with three providers behind the same `Provider` interface, the harness in Step 5 has real choice.

---

## [2026-04-27] M1 / Step 3.5 — Gemini adapter + extensibility refactor of the registry

**Done:**
- Added `@google/genai@1.50.1` dependency.
- `src/providers/google/capabilities.ts` — capabilities for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Cache mode is `server_persistent` (Gemini context caching is durable, not 5min like Anthropic). Cost numbers are illustrative (PROVIDERS.md §5 said "to document when adapter is implemented" — covered with placeholder values consistent with the rest of the registry).
- `src/providers/google/stream.ts` — `normalizeGoogleStream` converts Gemini chunks into the canonical `StreamEvent` taxonomy. Handles: synth `start` on first chunk (Gemini has no `message_start` frame), text deltas, function calls (single complete part per chunk → emit start+delta+stop back-to-back), `thought`/`thinkingText` parts, finishReason mapping (STOP/MAX_TOKENS/TOOL_CALLS/FUNCTION_CALL/SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII), null finishReason guard, empty stream fallback.
- `src/providers/google/index.ts` — `createGoogleProvider(modelName, opts)` factory. Reads API key from `opts.apiKey`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY`. Test seam via `opts.client`. Message conversion: `'assistant'`→`'model'`, content string→`parts:[{text}]`, content blocks→parts, `tool_use`→`functionCall`. `tool_result` blocks **throw** with a clear message (Gemini correlates by name not id; the harness will own id↔name resolution in Step 5+). Tool defs convert to Gemini's `functionDeclarations` shape.
- `src/providers/google/register.ts` — `registerGoogleModels(reg)`.
- `src/providers/anthropic/register.ts` — same pattern, extracted from registry.ts.

**Registry refactor (extensibility):**
- `ModelEntry.factory` is now `(opts?: unknown) => Provider` at the registry boundary. The previous `CreateProviderOptions = CreateAnthropicProviderOptions` alias is gone — registry no longer needs to know every family's option shape. Each adapter narrows internally with a structural cast.
- `createDefaultRegistry()` is now a 3-line orchestrator: `createRegistry()`, `registerAnthropicModels(reg)`, `registerGoogleModels(reg)`. Adding GPT later is one new `registerOpenAIModels` import + one call.
- The trade-off: callers wanting compile-time typed options should import the adapter's `create<X>Provider` directly. Going through `entry.factory` is type-erased on options. Documented in the `ModelEntry.factory` comment.

**Tests added:**
- `tests/providers/google-stream.test.ts` — **12 tests** covering text-only, functionCall lifecycle, synthesized vs SDK-provided ids, thought parts, finishReason mapping (8 cases incl. unknown), null doesn't clobber, empty stream, mixed-parts.
- `tests/providers/google.test.ts` — **12 tests** covering model rejection, env var lookup (GOOGLE_API_KEY / GEMINI_API_KEY), capabilities, generateConstrained stub, generate end-to-end through mock client, role/content mapping (`assistant`→`model`), config forwarding, `tool_result` block throw, countTokens (with totalTokens fallback to 0).
- `tests/providers/registry.test.ts` updated to assert both Anthropic and Google lineups, parity per family, and "all default entries can be instantiated with just an apiKey" — the regression test for "easy to add new providers".
- Total suite now **110 tests / 224 expect() calls** in ~500ms.

**Decisions:**
- **`(opts?: unknown) => Provider`** at the registry boundary — chosen over a discriminated union or a generic `ModelEntry<TOpts>` because both alternatives forced every consumer of the registry to either narrow on family or carry generics that erase at lookup time. The `unknown`-with-cast pattern keeps adding a family to a 1-line change in `createDefaultRegistry`. Compile-time safety on options is recovered by importing the family's `create<X>Provider` directly.
- **API key precedence for Google**: `opts.apiKey` → `GOOGLE_API_KEY` → `GEMINI_API_KEY`. Both env vars are common in the wild; we accept either to reduce friction.
- **Gemini `tool_result` blocks throw rather than silently corrupt**. Gemini correlates function calls by name, not id; doing the conversion correctly requires the original function name, which only the harness knows. Throwing is honest until Step 5 wires the resolution.
- **Function call ids are synthesized** for Gemini when the SDK doesn't provide one (`call_<n>_<uuid>`). The same id is used across `tool_use_start` / `_delta` / `_stop` (asserted by test).
- **`thought: true` parts → `thinking_delta`** to mirror Anthropic's extended thinking pass-through. Plain text parts (`thought` absent or false) → `text_delta`.
- **Per-family register* helpers** instead of a generic `buildFamilyEntries(family, ...)` — the per-family helper lives in the family's folder, so adding a family doesn't touch shared `registry.ts` code at all (only the orchestration line).

**Out of scope:**
- Real network coverage (deferred to evals)
- `tool_result` round-trip in messages (Step 5 — harness needs id↔name map)
- OpenAI / Ollama / llama.cpp — adapters land in M5 with the same pattern

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`).

---

## [2026-04-27] M1 / Step 3 — Provider Anthropic adapter + Model Registry

**Done:**
- `src/providers/types.ts` — canonical `Provider`, `ProviderCapabilities`, `StreamEvent`, `ProviderMessage`, `GenerateRequest`, `ConstrainedRequest`, `ProviderToolDef`, `StopReason`, family/cache/tools/constrained enums (per `AGENTIC_CLI §14`, `PROVIDERS.md §1`, `CONTRACTS.md §4`).
- `src/providers/anthropic/capabilities.ts` — caps for the three M1 Anthropic models (opus-4-7, sonnet-4-6, haiku-4-5). Costs taken verbatim from `PROVIDERS.md §5`.
- `src/providers/anthropic/stream.ts` — `normalizeAnthropicStream(rawEvents)` converts SDK raw events into the canonical `StreamEvent` taxonomy. Handles parallel tool_use blocks, partial JSON arg accumulation, malformed JSON fallback, thinking deltas, signature-delta drop, unknown stop_reason fallback.
- `src/providers/anthropic/index.ts` — `createAnthropicProvider(modelName, opts)` factory. Reads API key from `opts.apiKey` or `ANTHROPIC_API_KEY`. Exposes a test-seam (`opts.client`) for injecting a pre-built SDK client. `generate()` streams; `countTokens()` calls the SDK; `generateConstrained()` is a deliberate stub that rejects with a clear "not implemented in M1" error.
- `src/providers/registry.ts` — `createRegistry()` factory + `createDefaultRegistry()` pre-populated with the three Anthropic models. Each entry carries id, family, modelName, capabilities, and a `factory(opts)` to instantiate a live `Provider`.
- `src/providers/index.ts` — public surface; re-exports types and constructors.
- `tests/providers/*.test.ts` — 3 files, **31 tests** covering: stream normalization (12 cases incl. text-only, tool_use lifecycle, malformed JSON, non-object args, parallel tool_use, signature_delta drop, default-when-no-stop, null doesn't clobber a prior valid stop_reason, omitted-stop-reason ignored), adapter shape + wiring (model rejection, env vs option key, id/family/capabilities, generateConstrained stub, generate end-to-end through mock client, optional-field omission, countTokens), registry (insert/get/has/list, duplicate refusal, default lineup, factory↔entry capability parity).
- Total suite now **86 tests / 166 expect() calls** in ~180ms.

**Code-review fixes folded in before commit:**
- `mapStopReason` no longer accepts null/undefined. The `message_delta` handler only updates `stopReason` when the SDK actually sends a string. A later `delta: { stop_reason: null }` can no longer clobber an earlier valid `'tool_use'` and turn the canonical `stop` event into the wrong reason.
- `KNOWN_STOP_REASONS` is typed as `ReadonlySet<string>`; the ugly `as Set<string>` cast is gone.
- Combined the duplicate `import` from `./anthropic/capabilities.ts` in the registry.
- Adapter wiring now has real coverage: a mock `Anthropic` client (passed via the `client` test seam) verifies that `generate()` pipes the SDK stream through the normalizer, that optional fields are omitted when absent, and that `countTokens()` calls `messages.countTokens` and returns the SDK's `input_tokens`.

**Decisions:**
- **No real API calls in unit tests.** The stream normalizer takes any `AsyncIterable<RawAnthropicEvent>`; tests construct mock event sequences with async generators. Real-network coverage will live in evals (M5+).
- **`RawAnthropicEvent` is a local minimal type**, structurally compatible with the SDK's `Anthropic.Messages.RawMessageStreamEvent`. Decouples the normalizer from SDK upgrades that touch peripheral fields.
- **`generateConstrained` is a stub.** Anthropic implements constrained output via forced `tool_choice`, but the M1 autonomous loop never calls it — the DAG executor (M6) does. Failing loud beats silent emulation.
- **`metadata` field on `GenerateRequest` is not forwarded** to the SDK (yet). Anthropic's `MetadataParam` is `{ user_id?: string | null }`, narrower than our generic `Record<string, string>`. Telemetry will route user identity through a dedicated channel when needed.
- **`ProviderToolDef.input_schema` is typed as `{ type: 'object'; ... }`**, not arbitrary `Record<string, unknown>`. Matches both Anthropic and OpenAI tool-calling requirements; refusing malformed schemas at compile time beats runtime errors from the provider.
- **Registry as factory, not singleton** — each test gets a fresh registry. Shared global state was the mistake to avoid.
- **`sampling: SamplingSupport`** field from `PROVIDERS.md §1` intentionally omitted in M1; arrives with `TOKEN_TUNING` work.
- **Capabilities are declared honestly** per `PROVIDERS.md` principle 2 — the adapter exposes streaming because it streams; tools because it does native tool-calling; cache because Anthropic's prompt cache is server-side. Nothing claimed that the code doesn't do.

**Out of scope:**
- Vision input (M2+ when CLI accepts image paste)
- Extended thinking *actions* (we pass `thinking_delta` through but don't yet leverage it for the agent loop)
- Cache breakpoints (responsibility of the Context Engine, not the adapter)
- Retry/backoff on 5xx/529 (lives in the harness's provider call wrapper, Step 5)
- Token-counter caching (every `countTokens` call hits the network; harness can memoize)
- OpenAI, Ollama, llama.cpp adapters (M5; this step lays the interface they'll implement)

**Follow-ups (registered now, addressed later):**
- `ModelEntry.factory` is monomorphic over `CreateProviderOptions` (currently aliased to `CreateAnthropicProviderOptions`). Once a second family lands, this needs to become a discriminated union (or the entry generic over its options type) so that calling an OpenAI factory with Anthropic options is a compile error, not a runtime crash. Address in M5 when the second adapter ships.
- `ProviderMessageRole` is `'user' | 'assistant'` (Anthropic represents tool results as user messages with `tool_result` blocks), but storage's `MessageRole` is `'user' | 'assistant' | 'tool'`. A storage→provider converter is needed when the harness joins both ends. Will land in Step 5.
- `ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS)` loses literal types; if we want a typed union of allowed model names, we need `as const` plumbing or a generated constant. Cosmetic — fix when DX pain shows up.

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Glob/prefix policy YAML loader (no regex), `Tool<I, O>` interface, the read/write/edit/grep/glob/bash tools, harness-blocking pre-tool checks. The Anthropic adapter emits `tool_use_*` events; the tool layer will consume them.

---

## [2026-04-27] M1 / Step 2 — Storage layer (SQLite, MVP)

**Done:**
- `src/storage/db.ts` — connection factory over `bun:sqlite`. Sets `PRAGMA foreign_keys = ON` on every connection (Bun default is OFF). For file-backed DBs adds `journal_mode = WAL` and `synchronous = NORMAL`; skipped for `:memory:`. Auto-creates the parent directory.
- `src/storage/paths.ts` — XDG-aware default path resolution: `$XDG_DATA_HOME/forja/sessions.db` or `~/.local/share/forja/sessions.db`.
- `src/storage/migrate.ts` — idempotent runner. Records each applied migration in `_migrations` with `sha256(sql)`. Re-applying a migration whose SQL changed throws (catches accidental drift). Each migration runs inside a transaction.
- `src/storage/migrations/001-initial.ts` — first migration: `sessions`, `messages`, `tool_calls` per `AGENTIC_CLI §13`, with `CHECK` constraints on enum columns, FK cascades, and the indexes from §13. Inlined as TS so it survives `bun build --compile`.
- `src/storage/repos/{sessions,messages,tool-calls}.ts` — thin function-based repositories. No classes, no ORM. Camel-case domain types, snake-case row types, explicit `fromRow`. JSON columns serialized via `JSON.stringify`/`JSON.parse` (SQLite has no JSONB). State transitions enforced at the SQL layer (`UPDATE ... WHERE status = 'running'`) and reflected as thrown errors when the transition is illegal.
- `src/storage/index.ts` — single public surface; re-exports types and functions.
- `tests/storage/*.test.ts` — 6 files, **51 tests** covering: XDG fallback (incl. empty string), migration idempotency, hash-mismatch refusal, whitespace-insensitive hash, table creation, CRUD round-trips, ordering, filters, FK cascades, FK enforcement, CHECK rejection of invalid enums, illegal state transitions, cross-session parent rejection, transaction commit/rollback semantics, `openDb` directory creation, PRAGMA assertions.
- Total suite now **55 tests / 97 expect() calls** in ~150ms.

**Code-review fixes folded in before commit:**
- `finishToolCall` now refuses to overwrite a finished call (`AND status IN ('pending','running')` in the UPDATE). Without this, a buggy retry path could silently turn a `done` row into `error`.
- Migration hash now normalizes whitespace before SHA-256, so reformatting committed SQL no longer trips the drift detector. Semantic changes (renamed column, different type) still produce a different hash.
- Hash-mismatch error includes both the applied hash and the current hash.
- `appendMessage` validates that `parentId` lives in the same session (FK alone only checks existence). Prevents silently-corrupted message threads.
- `tool_calls` got a `created_at INTEGER NOT NULL` column and `idx_tool_calls_message_created`; `listToolCallsByMessage` now orders by `created_at ASC, id ASC` (UUIDs aren't time-sortable).
- `withTransaction(db, fn)` exposed in `src/storage/db.ts` so the harness can group multi-row writes (message + tool_calls) atomically without learning Bun's curried `db.transaction()` API.

**Decisions:**
- **`allowImportingTsExtensions: true`** added to tsconfig — Bun's idiomatic style is `.ts` in imports; without the flag tsc rejects them. Compatible because `noEmit: true`.
- **Disabled Biome rule `performance/noDelete`** — its auto-fix would convert `delete process.env.X` to `process.env.X = undefined`, which in Node/Bun sets the env var to the string literal `"undefined"` instead of removing it. That would silently break our XDG fallback test. The V8 hidden-class concern doesn't apply to non-hot test code.
- **Repos as functions, not classes** — keeps testing trivial (`(db, input) → result`), aligns with "no ORM" rule, matches the spec's pseudocode style.
- **JSON columns are `unknown`** at the type boundary — repos don't claim to know the shape of message content or tool input/output. Caller validates if it cares.
- **`completeSession` and `startToolCall` distinguish "not found" from "wrong state"** — diagnostic value at low cost.
- **Indexes from spec §13.1** included verbatim (`sessions(started_at DESC)`, `(cwd, started_at DESC)`, `(status, started_at DESC)`, `messages(session_id, created_at)`, `tool_calls(tool_name, status)`).

**Out of scope (deferred to the step that needs them):**
- `goal_stack` (with the harness when goal injection lands)
- `approvals` (with permissions)
- `checkpoints` (with rollback / git integration in M3)
- `hook_runs`, `background_processes`, `memory_events`, `recap_runs`, `recap_cache`, `traces`, `artifacts` (each with its own subsystem in M3+)

**Pending:** none for this step.

**Next:** Step 3 — Provider Anthropic adapter + Model Registry skeleton (`AGENTIC_CLI §14`, `PROVIDERS.md`). Minimal `Provider` interface, real `generate()` against `@anthropic-ai/sdk` with streaming, capability declaration, request shape that the harness will consume in Step 5.

---

## [2026-04-27] M1 / Step 1.5 — Production hygiene pass

**Done:**
- `.github/workflows/ci.yml` — runs typecheck → lint → test on push to `main` and on every PR. Bun pinned to `1.3.13`. Concurrency group cancels superseded runs.
- `.editorconfig` at the root — keeps cross-editor formatting aligned with Biome (2-space, LF, UTF-8, final newline). Markdown keeps trailing whitespace (line breaks).
- Trusted Biome's postinstall (`bun pm trust @biomejs/biome`) so the platform binary is fetched at install time instead of lazily on first lint. Bun added `trustedDependencies` to `package.json`.
- `tests/cli.test.ts` — first smoke test: `--version`, `-v`, `--version --json`, no-args exit-1. Also unblocks `bun test` in CI (zero test files makes Bun exit 1).

**Decisions:**
- **Skipped pre-commit hook and README.md** for now (explicit user call). CI gate covers the regression case for the moment.
- **CI uses `bun install --frozen-lockfile`** — fail loud if `bun.lock` drifts from `package.json`.
- **CI Bun version pinned to current dev (`1.3.13`)** rather than floating `latest` — reproducible builds beat free upgrades.
- **Smoke test uses `Bun.spawnSync`** (not `node:child_process`) — consistent with the runtime, no extra type dance.

**Pending:** README and pre-commit hook still owed eventually.

**Next:** Step 2 — Storage layer (SQLite) per `AGENTIC_CLI §13`.

---

## [2026-04-27] M1 / Step 1 — Repository bootstrap

**Done:**
- Branch `feat/m1-foundation` created from `main`.
- `CLAUDE.md` at the root: root premise, Doc→Subsystem map, locked stack, hard rules, workflow.
- `docs/BACKLOG.md` (this file).
- `package.json` with scripts (`dev`, `test`, `lint`, `typecheck`, `build`) and bin `agent`.
- `tsconfig.json` strict (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `biome.json` (linter + formatter, 100 col, single quotes, semicolons).
- `.gitignore` covering runtime state per spec §2.7 (`.agent/sessions.db`, traces, checkpoints, local memory).
- `src/cli/index.ts` stub — responds to `--version` / `-v`; anything else exits 1 with a pointer to the spec.
- Project-wide language policy: English everywhere except `docs/spec/` (PT-BR).

**Decisions:**
- **Test runner:** `bun test` built-in, not Vitest from spec §16. Reason: aligns with principle 5 ("single runtime"); zero extra deps. Revisit if a critical Vitest feature is missing.
- **Linter:** Biome (single binary, Bun-friendly) instead of ESLint + Prettier — same single-runtime alignment.
- **`docs/BACKLOG.md` instead of `.txt`** — markdown renders on GitHub and matches the rest of the repo.
- **Branch per milestone** (`feat/mN-*`) until trunk-based stabilizes.
- **No empty subsystem folders** — they emerge in the step that needs them. `.gitkeep` in empty dirs is noise.
- **Stack matches spec §3** exactly: TS + Bun + bun:sqlite + Ink. No drift.
- **Project language is English**; only `docs/spec/` stays in PT-BR.

**Pending:** none for this step.

**Next:** Step 2 — Storage layer (SQLite) with the minimal schema from `AGENTIC_CLI §13`: tables `sessions`, `messages`, `tool_calls`, `approvals`, `checkpoints`, `traces`. Migrations infra. Thin repository pattern over `bun:sqlite`. Schema + basic CRUD tests.
