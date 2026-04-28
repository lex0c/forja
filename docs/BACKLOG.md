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

## [2026-04-27] M1 / Step 6 — One-shot CLI + harness lifecycle events (closes M1)

**Done:**
- `src/harness/types.ts` — `HarnessEvent` union (`session_start`, `step_start`, `provider_event`, `tool_invoking`, `tool_decided`, `tool_finished`, `session_finished`) + `onEvent` callback on `HarnessConfig`.
- `src/harness/collect.ts` — `collectStep` now accepts an `onEvent` forwarder so each provider stream event surfaces in real time. Renderer throws are swallowed.
- `src/harness/loop.ts` — emits the lifecycle events around each step, around each tool invocation, and around the session itself. `safeEmit` helper makes the integration crash-proof.
- `src/harness/invoke-tool.ts` — `InvokeToolResult` now carries the `Decision | null` so the loop can fire `tool_decided` events for renderers (null when the tool wasn't found, since no decision happened).
- `src/cli/args.ts` — hand-rolled parser. Flags: `--version`/`-v`, `--help`/`-h`, `--json`, `--model <id>`, `--max-steps <n>`. Unknown flag → reject with diagnostic. Anything not a flag is collected as the prompt (joined by spaces).
- `src/cli/bootstrap.ts` — `bootstrap(input)` builds a `HarnessConfig` from cwd + env. Default model is `anthropic/claude-sonnet-4-6`. Loads `./.agent/permissions.yaml` if present (returns `policySource: 'project'`), otherwise falls back to `defaultPolicy()` (strict + empty rules — refuses everything until explicitly configured). Migrates the DB. Registers the 6 builtin tools. Exposes `providerOverride` and `dbPath` test seams.
- `src/cli/output/{types,plain,json}.ts` — `OutputRenderer` interface, plus two implementations:
  - `plain.ts` for TTY/pipe output: assistant text streams to stdout, tool indicators and lifecycle markers go to stderr (so a piped stdout stays a clean transcript). ANSI colors only when stderr is a TTY and `NO_COLOR` is unset.
  - `json.ts` for `--json`: NDJSON lines to stdout, one per `HarnessEvent`. Spec §2.2: in `--json`, stdout is NDJSON only.
- `src/cli/signal.ts` — `installSignalHandler` wires SIGINT to an `AbortController`. First Ctrl+C requests graceful abort; second forces `process.exit(130)`.
- `src/cli/run.ts` — orchestrator. Picks renderer, builds bootstrap input from args, installs signal handler, calls `runAgent`, maps the `HarnessResult` to a process exit code per spec §2.2 (0 done · 1 error · 2 exhausted · 130 interrupted).
- `src/cli/index.ts` — full rewrite. Was a stub that exited 1; now dispatches to `run` after parsing args, with `--version`/`--help` short-circuits and a `missing prompt` error path.
- `tests/cli/args.test.ts` — **15 cases** covering each flag, value parsing, rejection of unknown flags / non-numeric `--max-steps` / missing `--model` value, mixed-flag prompts, empty argv.
- `tests/cli/bootstrap.test.ts` — **7 cases** with isolated tmpdirs and a mock provider: default model, model override, unknown-model rejection, project policy loading, default-policy fallback, budget forwarding, DB migration.
- `tests/harness/events.test.ts` — **6 cases** for the `onEvent` contract: bracketing events, `step_start` per iteration, `provider_event` forwarding, full `tool_invoking → tool_decided → tool_finished` sequence, `tool_decided` skipped for unknown tools (no decision was made), throwing renderer doesn't derail the loop.
- `tests/cli.test.ts` updated for the new entry: `--help` exit 0 with usage, missing prompt exits 1 with usage, unknown flag rejected, unknown model from bootstrap surfaces in stderr.
- Total suite: **289 pass / 6 skip / 617 expect() calls** in ~1.6s.

**Code-review fixes folded in before commit:**
- **`bootstrap` no longer leaks the DB on throw.** Reordered to load policy and resolve the provider *before* opening SQLite, since those steps can throw on malformed YAML or unknown model. `migrate` (the only remaining throw-source after the DB opens) is wrapped in try/catch that closes the DB on throw. Two regression tests assert the DB file isn't even created when bootstrap aborts.
- **`src/cli/index.ts` now catches stray throws from `main()`.** Top-level `await main()` was unwrapped — any sync throw from `parseArgs` or stdout/stderr writes would surface as Bun's default unhandled-rejection trace instead of a "forja: ..." diagnostic.
- **`--max-steps` rejects decimals, hex, scientific notation, and leading zeros.** Was: `Number.parseInt('3.5', 10)` returned `3` and silently passed validation. Now: regex `^[1-9][0-9]*$` validates the literal before parsing. Three regression tests pin the behavior.
- **Dead code removed from `args.ts`.** `FLAGS_REQUIRING_VALUE` was declared and consulted in the default branch, but the flags it listed were already intercepted by their explicit `case`s — the check could never fire. Default branch simplified to rejecting any `--`-prefixed token outright.

**Decisions:**
- **No Ink in M1.** The roadmap mentioned "Ink mínimo" but plain text + ANSI delivers a working one-shot CLI today. Ink belongs with the *interactive* TUI (input editor, slash commands, ongoing conversation) which is M2 territory. Adding React + Ink for one-shot streaming would be ~300 lines of components for output that ANSI does in 80 lines. Documented as deliberate deferral.
- **Hand-rolled arg parser.** The flag set is small (5 flags) and stable. Adding `commander` or `yargs` would be more surface area than the parser itself. ~80 lines.
- **`OutputRenderer` interface** sits between the harness and the actual renderer. Plain + JSON ship now; an `InkRenderer` can drop in next without touching the harness or the CLI dispatch.
- **Stdout vs stderr split:** assistant text → stdout (clean transcript when piped); everything else (tool indicators, lifecycle markers, summary) → stderr. Aligns with spec §2.2 ("stdout puro, stderr pra log") and lets `agent "summarize X" > out.md` work intuitively.
- **Color detection looks at `stderr.isTTY`**, not stdout. Tool indicators live on stderr; if it's piped, ANSI would corrupt the log. `NO_COLOR` env var disables colors regardless.
- **Default policy is strict + empty.** First-time users hit a deny on every tool, which forces them to opt in via `.agent/permissions.yaml`. Surprising at first but the right default for a tool that runs `bash`. Documented in usage.
- **`onEvent` is synchronous.** Async would let renderers do work before the loop continues but adds complexity (await per event) and doesn't help the current renderers. Sync + crash-proof (try/catch around each call) is the right trade for M1.
- **`tool_decided` is skipped for unknown tools.** No decision happened; emitting an event would imply one. Renderers can rely on the invariant: if `tool_decided` fires, there's a real `Decision`.
- **DB closes on every CLI exit path** — `try/finally` in `run.ts`. SQLite WAL leaves dangling files if not closed cleanly.
- **Exit 130 for both abort and SIGINT.** Unix convention for "terminated by signal 2 (INT)". Even though the wall-clock cap also returns `interrupted`, that's fine — exit 130 means "didn't run to completion", not specifically "user pressed C".

**Out of scope:**
- Ink components and interactive TUI — M2
- Slash commands (`/help`, `/cost`, `/model`, `/clear`) — M3
- Resume / `--resume <id>` — M2
- Plan mode (`--plan`) — M2
- Replay (`--replay <id>`) — M2
- Cost display (no token extraction yet) — M2
- `--list-tools`, `--list-sessions`, `agent doctor` — M2
- Capability detection beyond TTY/NO_COLOR (truecolor, locale, image protocol) — M2
- `agent` with no prompt as REPL — M2
- Hierarchy resolution for permissions (enterprise → user → project) — M2

**Pending:** none for this step. **M1 closes here.**

**Next:** M2. Plenty of options (compaction, telemetry/cost, plan mode, resume, sandbox, doctor, more eval coverage). Decide priority once we run the CLI against real models for a while and see what hurts.

---

## [2026-04-27] M1 / Step 5 — Agent Harness (autonomous loop)

**Done:**
- `src/harness/types.ts` — `RunBudget` (`maxSteps`, `maxWallClockMs`, `maxToolErrors`, `maxRepeatedToolHash`, `maxOutputTokensPerCall`), `DEFAULT_BUDGET`, `ExitReason` enum (`done`/`maxSteps`/`maxWallClockMs`/`maxToolErrors`/`degenerateLoop`/`aborted`/`providerError`/`scriptExhausted`), `HarnessConfig`, `HarnessResult`.
- `src/harness/collect.ts` — `collectStep(events)` drains a provider stream into `{message_id, text, tool_uses, thinking, stop_reason, errors}`. Tool names from `tool_use_start` are tracked by id and reattached on `_stop` (canonical event has only the id at stop time). Orphan stops become `harness.orphan_tool_use_stop` errors instead of crashes.
- `src/harness/invoke-tool.ts` — single-tool pipeline. Lookup → persist `tool_calls` row → engine.check → record approval → start/finish with the right status. `confirm` decisions become `confirm_no` denials in M1 (no UI yet); the original prompt is surfaced to the model in the tool_result. Tool exceptions never propagate; they're wrapped as `tool.exception` errors.
- `src/harness/loop.ts` — `runAgent(config)` autonomous loop. Builds the running message list, calls provider, builds assistant content blocks (text first, then tool_uses) for both DB persistence and the next request, drives every tool through `invokeTool`, accumulates tool_results into the next user message. Snapshots `messages` on each request so post-call mutations don't retroactively change what the provider observed. Sliding-window degenerate-loop detector (sha256 of `name:stableJson(args)`, window 5, threshold from `budget.maxRepeatedToolHash`).
- `src/harness/index.ts` — public surface.
- `tests/harness/collect.test.ts` — **8 tests**: text-only, single tool_use lifecycle, parallel tool_uses tracked by id, text+tool_use coexistence, thinking_delta, error events captured, orphan-stop defensive path, default stop_reason.
- `tests/harness/invoke-tool.test.ts` — **6 tests**: happy path with approval row + tool_call lifecycle, unknown tool (no DB rows), policy deny, M1 confirm-becomes-denied with prompt surfaced, tool returning ToolError, tool throwing → `tool.exception`.
- `tests/harness/loop.test.ts` — **10 tests** with a scripted mock provider: text-only one-step done, tool→result→done two-step (with assertion that the second request observes the tool_result message), maxSteps cap, pre-aborted signal, unknown tool (loop continues), policy deny (loop continues), maxToolErrors cap, degenerateLoop detection (identical args), session/messages persisted to SQLite, provider crash → providerError with detail.
- Total suite: **254 pass / 6 skip / 529 expect() calls** in ~670ms.

**Code-review fixes folded in before commit:**
- **Gemini integration unblocked.** The harness emits user messages with `tool_result` blocks; the Gemini adapter rejected them because Gemini correlates by function name, not id. Now `ProviderToolResultBlock` carries an optional `name`, the harness populates it from `input.toolName` on every result (success and error paths), and the Gemini adapter converts to `functionResponse` instead of throwing. Anthropic and OpenAI ignore the field. Two new tests pin the contract: Gemini conversion with `name` works; the missing-`name` case still throws (for catching harness bugs).
- **Empty error messages no longer get lost.** `(e as Error).message ?? String(e)` returned `""` when an `Error` had an empty message (nullish coalescing only catches null/undefined). Replaced with `e.message || e.name || String(e)` — falls through to the constructor name and finally `toString` so we never report `tool crashed: ` with no body. Same fix in the harness `providerError` path.

**Decisions:**
- **`maxCostUsd` deferred to M2.** Stream events don't expose token usage in M1 (the normalizer drops `message_delta.usage`); cost tracking lives with telemetry.
- **`confirm` → `confirm_no` in M1**, with the prompt text mirrored into the tool_result so the model sees *why* it was denied. Step 6 (TUI) replaces this branch with a real prompt and decides `confirm_yes`/`confirm_no` based on user input.
- **No checkpoint creation in this step.** The plan listed "checkpoints básicos" but the table doesn't exist yet; adding a stub now would be dead code. Migration 003 + git-stash integration land in M3 with the rest of the rollback subsystem.
- **`messages` array is cloned per request** (`{...messages}`). The previous version passed a shared reference; mutations during the next iteration would have changed what the provider observed (caught by a test asserting the second request sees the tool_result message as the last entry).
- **Hash window is in-memory.** Spec §13 has `tool_calls.input_hash` for SQL-side analysis; the harness's degenerate-loop detection uses an in-process sliding window keyed on `sha256(name + stableJson(args))`. SQL-side detection is M2.
- **All registered tools are sent to the provider.** No filtering by playbook/role yet — the harness exposes the full registry. Filtering is a Step 6 / playbooks (M3) concern.
- **Aborted signal is checked before each step AND between tool invocations within a step.** A multi-tool step honors abort mid-execution rather than waiting for the next iteration.
- **`scriptExhausted` exit reason** is reserved for the mock provider draining (test-only path); production providers never hit it.

**Out of scope:**
- Streaming UI — the harness collects whole steps before persisting (Step 6 will tee events to UI)
- Compaction — full message history sent every turn (M2)
- Checkpoints — `tool.metadata.writes` flag is read but no snapshot is taken (M3)
- Hooks (PreToolUse, PostToolUse, Stop, etc.) — M4
- Subagents (`task_*`) — M3
- Resume from DB — current loop only runs forward from a fresh user prompt (M2)
- Cost tracking — needs token usage extraction in stream normalizer (M2)
- Provider retry/backoff on 5xx — would wrap provider.generate; harness in M2

**Pending:** none for this step.

**Next:** Step 6 — Ink TUI mínimo + one-shot mode wiring. Connect the CLI entry (`src/cli/index.ts` is still a stub) to `runAgent` with a real Anthropic provider, render streaming output and tool calls in the terminal, wire `Ctrl+C` to the AbortSignal. Closes M1.

---

## [2026-04-27] M1 / Step 4 — Permission Engine + Tool System + 6 builtin tools

**Done:**
- `src/storage/migrations/002-approvals.ts` — adds the `approvals` table per AGENTIC_CLI §13 (FK cascades from `tool_calls`, CHECK constraints on `decision` and `decided_by`, index on `tool_call_id`).
- `src/storage/repos/approvals.ts` — `recordApproval`, `listApprovalsByToolCall`. Exported through `src/storage/index.ts`.
- `src/permissions/types.ts` — `Policy`, `PolicyMode` (`strict` | `acceptEdits` | `bypass`), `PolicyCategory` (`fs.read` | `fs.write` | `bash` | `web.fetch` | `misc`), `Decision` (allow / deny / confirm), per-tool rule shapes (`BashPolicy`, `PathPolicy`, `FetchPolicy`), `PermissionsView`.
- `src/permissions/matcher.ts` — `matchPath` (Bun.Glob, cwd-anchored so `**/foo` can't reach `/etc/passwd`), `matchCommand` and `matchHost` (custom glob→regex compiler so `*` matches across `/` and spaces), plus `firstMatching*` helpers for diagnostics.
- `src/permissions/engine.ts` — `createPermissionEngine(policy, opts)` returns `check(toolName, category, args) → Decision`. Order: deny rules first (always win), then allow, then confirm; default = deny. `bypass` short-circuits to allow. `acceptEdits` upgrades unmatched writes from deny to confirm (not auto-allow — see Decisions).
- `src/permissions/config.ts` — `parsePolicy`, `loadPolicyFromString`, `loadPolicyFromFile`, `defaultPolicy`. Strict validator: rejects mistyped keys (`allow_path` instead of `allow_paths` is the bug class), rejects malformed mode values, rejects non-mapping top-level.
- `src/permissions/index.ts` — public surface.
- `src/tools/types.ts` — `Tool<I, O>`, `ToolContext` (signal + cwd + sessionId + stepId + permissions per CONTRACTS §2), `ToolResult<O> = O | ToolError`, `isToolError` discriminator, `toolError` constructor, `ERROR_CODES` enum.
- `src/tools/registry.ts` — `createToolRegistry`.
- `src/tools/builtin/{read-file,write-file,edit-file,glob,grep,bash}.ts` — six tools, all returning `ToolResult` (no thrown errors).
- `src/tools/builtin/index.ts` — `BUILTIN_TOOLS` array + `registerBuiltinTools(reg)` helper.
- `src/tools/index.ts` — public surface.
- `.github/workflows/ci.yml` — adds `apt install ripgrep` step so the grep tool's tests run instead of skipping.
- New dep: `yaml@latest` (parser).
- New tests:
  - `tests/storage/approvals.test.ts` — 6 cases: roundtrip, ordering, FK cascade, CHECK rejections, FK rejection on unknown tool_call_id.
  - `tests/permissions/matcher.test.ts` — 18 cases covering path resolution (relative, absolute, outside-cwd), command matching (exact, prefix, wildcard with spaces and slashes), host matching (case, glob), `firstMatching*` helpers.
  - `tests/permissions/engine.test.ts` — 17 cases: bash allow/deny/confirm, path allow/deny/confirm, mode behaviors (strict/acceptEdits/bypass), web.fetch hosts, misc category, missing-arg rejections.
  - `tests/permissions/config.test.ts` — 10 cases: full policy parse, mode default, malformed-key rejection, YAML syntax errors, default policy.
  - `tests/tools/registry.test.ts` — 4 cases.
  - `tests/tools/_helpers.ts` — shared `makeCtx()` for tool tests.
  - `tests/tools/{read-file,write-file,edit-file,glob,bash}.test.ts` — 5 happy-path + error-path + abort-signal coverage per tool.
  - `tests/tools/grep.test.ts` — 6 cases gated on `rg` availability via `describe.if(RG_AVAILABLE)` (skips locally if ripgrep missing; CI installs it).
- Existing `tests/storage/migrate.test.ts` updated to assert ≥ 2 migrations (was hardcoded to 1).
- Total suite: **228 pass / 6 skip / 446 expect() calls** in ~600ms.

**Code-review fixes folded in before commit:**
- **`acceptEdits` mode now matches spec §8 semantics.** Was: `confirm_paths` still required confirmation AND unmatched writes escalated to confirm. Now: `confirm_paths` for writes auto-allows (skip confirmation step — the actual convenience the mode promises); unmatched writes default-deny (mode is convenience, not bypass); reads keep the same confirm behavior. Deny still wins over confirm in all modes.
- **`PermissionsView.hasPathRule` removed.** It was hardcoded to look up `write_file`/`read_file` rules, ignoring per-tool overrides on `edit_file`/`glob`/etc. — wrong by construction, with no caller. The harness in Step 5 will call `engine.check(toolName, ...)` directly with the right tool name. The view now exposes only `mode`.
- **`parsePolicy` rejects top-level arrays.** Previously slipped through the `typeof === 'object'` check.
- **`bash` wraps `SIGTERM` in try/catch** (was already wrapped on the SIGKILL escalation). The proc can exit on its own between the timer firing and `proc.kill()` running — kill on a dead pid throws ESRCH; we swallow it now.
- **`edit_file` rejects empty `old_string` explicitly** (`edit.old_string_empty`) with a hint pointing to `write_file`. Previously fell through to `old_string_not_found`, which was less diagnostic.

**Decisions:**
- **`Tool.execute` returns `O | ToolError` instead of throwing** (CONTRACTS §2, cláusula 7). Errors are *data*. Tests use `isToolError(out)` discriminator instead of try/catch. The harness in Step 5 catches stray throws and converts them, but builtins don't throw.
- **Custom glob→regex compiler for commands and hosts** instead of `Bun.Glob`. Bun's `*` doesn't cross `/` (correct for paths, wrong for `curl * | sh` where the URL contains `/`). The compiler escapes regex metachars and translates `*`→`.*`, `?`→`.`. The "no regex in policy" rule (CLAUDE.md) is preserved — the user still authors with glob syntax; regex is an internal implementation detail.
- **`acceptEdits` mode upgrades unmatched writes from deny to confirm**, not to auto-allow. The mode is opt-in convenience for refactor sessions, not a free-for-all. Auto-allow lives in `bypass` (which requires an explicit dangerous flag, deferred).
- **Permission categories instead of per-tool rules everywhere.** New tools join an existing category instead of needing a new policy section. The YAML still supports per-tool overrides (`tools.bash`, `tools.write_file`).
- **Path matcher is cwd-anchored.** A pattern like `src/**` resolves against cwd before matching, and an absolute target outside the cwd subtree falls back to direct absolute match. Result: bare `**/foo` can't reach `/etc/passwd` — security property by construction.
- **Strict validator rejects unknown shapes** (e.g., `allow_path` typo'd as singular). Silently ignoring unrecognized keys is how YAML-driven policies turn into "allow-everything" in production.
- **`bash` is `writes: true` pessimistically** (per CONTRACTS §2.6.3). The `read_only` flag in the input schema is a hint *from the caller*, not the tool — Step 5 harness can use it to route through a different policy path.
- **`grep` shells out to `rg`** instead of pure-TS implementation. Performance + battle-tested feature set. Tests skip cleanly if `rg` is missing; CI installs it.
- **Hierarchy resolution is project-only in M1** — no enterprise/user/project/session merging yet. Spec §8 requires it; landing in M2 with the trust subsystem.
- **`yaml` over `js-yaml`** — newer API surface, comparable battle-testing, smaller install footprint.

**Out of scope:**
- Sandbox (`bwrap` / `sandbox-exec`) — M2
- Checkpoint creation before writes — Step 5 / M3
- Hook integration (PreToolUse / PostToolUse) — M4
- Hierarchy enterprise → user → project → session — M2
- Output sanitization (CSI escape stripping) — M2
- The other 15 tools in CONTRACTS §2.6 (background, task_*, memory_*, fetch_url, code retrieval) — later steps/milestones
- Confirmation UI — Step 6 (Ink); engine returns `Decision` shape ready for the UI to consume
- Real-API/network tests for grep — would need fixtures; current coverage is enough for the wrapper

**Pending:** none for this step.

**Next:** Step 5 — Agent Harness loop (autonomous profile) per AGENTIC_CLI §5. Ties storage + provider + permissions + tools together: session lifecycle, message loop with budget, tool invocation pipeline (engine.check → record approval → execute → persist), abort/cancel, basic checkpoint stub.

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
