# TODO — deferred work

Items intentionally left for later milestones, with the deferral
rationale and a "pull-in" signal so we know when to revisit.

---

## bash tool: thread `ctx.signal` to the running subprocess

**Status:** noted during the M3/Step 2.2 security audit
(2026-04-29). Out of scope for the wait/monitor hardening pass.

**What it is:** `src/tools/builtin/bash.ts` checks
`ctx.signal.aborted` BEFORE spawning the subprocess, but does not
listen for abort during execution. When the harness aborts mid-
bash (caller cancellation, wall-clock timeout), the child
process keeps running — the bash tool waits on `proc.exited`
without a kill path tied to the caller signal.

**Effect today:** a harness-level abort surfaces to the model as
a tool-call interruption (the harness short-circuits the tool
invocation), but the OS-level child process leaks past the
abort window. For a long `bash { command: 'sleep 600' }`, this
holds a process slot until natural exit despite the harness
giving up on it.

**Fix shape:** add a listener that calls `proc.kill('SIGTERM')`
on `ctx.signal` abort, with a follow-up `SIGKILL` after a grace
window if the child ignores SIGTERM. Mirror the pattern already
implemented in `src/bg/manager.ts` for bash_kill — the kill
grace cycle there is the canonical implementation.

**Pull-in signal:** any incident where a harness abort during
bash leaves orphaned child processes, OR M3+ work on resource
caps / cleanup hooks that expects all spawned children to honor
the harness signal contract.

**Why deferred:** the wait/monitor hardening pass focused on the
explicit user-flagged class of bugs (misc-bypass + wall-clock
cap). Threading abort signals into bash is a parallel hardening
that deserves its own commit + tests, not a drive-by.

---

## Trust prompt for new directories (`AGENTIC_CLI §9.1`)

**Status:** deferred from M2 / Step 4. Hierarchy resolution (the other
half of Step 4) ships standalone; trust prompt waits for the
interactive UI.

**What it is:** first time the agent opens a new directory (or detects
an aggregate-hash mismatch in trusted artifacts), prompt the user
before loading any of the following:

- `AGENTS.md`
- `.agent/config.toml`
- `.agent/permissions.yaml`
- `.agent/hooks.toml`
- `.agent/memory/shared/**`
- `.agent/playbooks/**`
- `.agent/agents/**`
- `.agent/orchestrators/**`

Trusted entries persisted in `~/.config/agent/trusted_dirs` with the
aggregate hash. Mismatch on subsequent run = re-prompt.

**Why deferred:**

1. **No interactive UI yet.** M2 is one-shot CLI. A "headless trust"
   workaround (fail-closed unless `agent trust .` ran first) would
   force a manual approval step on every `git clone` for marginal
   value: the only artifact we currently load is `.agent/permissions.yaml`,
   a single project-local file the user is already editing.
2. **Threat surface today is narrow.** AGENTS.md, hooks, playbooks,
   orchestrators, and MCP manifests don't exist in code yet — they
   land in M3/M4. Trust mechanics ship with their consumers, not
   ahead of them, so the implementation doesn't get rewritten
   when those subsystems land with their own spec details.
3. **Real prompt deserves a real UI.** Spec wires the prompt to a
   `[y/N/inspecionar]` choice; "inspect" lets the user diff the
   artifacts before approving. That's interactive territory.

**Pull-in signal:**

Pull this back into scope when EITHER:

- The interactive Ink UI lands (likely M3+) — trust prompt nasce
  com prompt humano de verdade, tem `inspecionar` mode.
- A second trust-relevant artifact starts being loaded (AGENTS.md,
  playbooks, hooks, MCP manifests) — at that point the threat
  surface widens enough that a headless `agent trust` subcommand
  becomes worth the friction.

**Whichever lands first** triggers a fresh design pass (the headless
flow vs full UI flow are different enough that we shouldn't pre-build
the wrong one).

**Spec reference:** `AGENTIC_CLI.md §9.1`, `SECURITY_GUIDELINE.md §9.1`,
`AUDIT.md §1.5` for `mcp_manifest_history` table that the MCP-trust
half consumes.

---

## Rename `cost_per_1k_*` → `cost_per_1m_*` on `ProviderCapabilities`

**Status:** field-name vs value-unit mismatch. Surfaced during the
M2 / Step 6 smoke baseline run. Math fixed inline; rename
deferred.

**What it is:** every `ProviderCapabilities` entry stores rates in
dollars-per-million tokens (the convention Anthropic, OpenAI, and
Google publish in). The fields are spelled `cost_per_1k_input`,
`cost_per_1k_output`, `cost_per_1k_cached_input`,
`cost_per_1k_cache_write`. The math in `src/providers/cost.ts`
now divides by `1_000_000` to match the values; the field name
still says `_1k_`, which is a footgun for anyone adding a new
provider.

**Why deferred:**

1. **Cross-cutting rename.** Touches `src/providers/types.ts`,
   `src/providers/cost.ts`, all three provider capabilities files
   (`anthropic`, `openai`, `google`), and `docs/spec/PROVIDERS.md`
   §5 (which sources the values). Several test files reference
   the field names directly. Doing it as a separate commit keeps
   the diff readable and the Step 6 commit focused on the eval
   harness.
2. **No correctness risk today.** The numbers are right and the
   math is right. The only cost is naming clarity for future
   contributors.
3. **Spec PR first.** The field name lives in the typed contract
   that PROVIDERS.md §5 documents; a rename without a spec
   amendment would diverge code from spec. Per CLAUDE.md, the
   spec leads, code follows.

**Pull-in signal:**

Pull when EITHER:

- A new provider is being added to the registry (we'd write the
  wrong field name otherwise).
- The cost telemetry surface changes (e.g., we add tier rates,
  per-region pricing) — bundle the rename into that PR.

**Spec reference:** `PROVIDERS.md §5`, `src/providers/cost.ts`
(comment block already flags the followup).

---

## Add gpt-5.x family to the OpenAI registry

**Status:** registry stuck on gpt-4o lineage. Surfaced during
the M2 / Step 6 pricing audit when the user shared the
current OpenAI pricing table.

**What it is:** `src/providers/openai/capabilities.ts` declares
`gpt-4o` and `gpt-4o-mini` only. The current OpenAI flagship
family is gpt-5.x:

| Model | Input ($/M) | Cached ($/M) | Output ($/M) |
|---|---|---|---|
| gpt-5.5 | $5.00 | $0.50 | $30.00 |
| gpt-5.5-pro | $30.00 | – | $180.00 |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |
| gpt-5.4-pro | $30.00 | – | $180.00 |

Plus a long-context tier with different pricing for gpt-5.5
and gpt-5.4 — that tier doesn't fit the current
`ProviderCapabilities` shape (single input/output rate per
model) and would require a contract change.

**Why deferred:**

1. **Feature work, not hardening.** Adding new models means
   new defaults (which one becomes `recommended_for:
   autonomous`?), new capabilities matrix entries, and a
   spec amendment to `PROVIDERS.md §5`. That's a feature
   PR, not part of the M2 closure.
2. **gpt-5.x uses `max_completion_tokens`, not `max_tokens`.**
   Our adapter sends `max_tokens`. Adding gpt-5.x models
   without adapter changes would 400 every request. Need a
   capability flag (`uses_max_completion_tokens: true`) and
   a code branch in `src/providers/openai/index.ts`.
3. **Long-context tier requires schema change.** Current
   `cost_per_1k_*` fields assume a single rate per token
   class per model. gpt-5.5 prices Short context vs Long
   context differently — adding this means
   `cost_per_*` becomes a function of effective context
   size, or splitting into per-tier model entries
   (`gpt-5.5-short`, `gpt-5.5-long`). Spec decision.
4. **Reasoning model semantics.** gpt-5.x is a reasoning
   family — `o`-series-style internal thinking that bills
   under `output_tokens` but isn't user-visible. Smoke would
   under-budget if cases assume non-reasoning token costs.
   Need to handle `reasoning_tokens` in usage normalization.

**Pull-in signal:**

Pull this back when EITHER:

- A user prompt requires reasoning quality the gpt-4o family
  can't deliver, AND the cost envelope makes gpt-5.4-mini
  reasonable as the new OpenAI default.
- Anthropic releases a competing reasoning model and we
  want head-to-head measurement (forces the spec PR
  anyway).

**Spec reference:** `PROVIDERS.md §5` (model registry table
needs amendment), `TOKEN_TUNING.md §3` (reasoning token
accounting), `src/providers/openai/index.ts` (param shape).

---

## Smoke baseline against Gemini

**Status:** Gemini adapter has unit coverage but never ran
end-to-end. Surfaced during the M2 / Step 6.3 multi-provider
review.

**What it is:** run `bun run eval:smoke -- --model
google/gemini-2.5-flash --repeat 3` against a real Gemini
endpoint. Same shape as the Anthropic and OpenAI baselines
already documented in BACKLOG (Step 6.2 / 6.3). Goal: 24/24
with `compaction_triggered: { strategy: llm }` confirmed on
the third provider.

**Why deferred:**

1. **Gemini pricing in registry is illustrative, not real.**
   `src/providers/google/capabilities.ts` literally says so
   in a comment ("Numbers below match the unit convention
   used elsewhere in the registry — they are not committed
   real Gemini prices"). Running smoke today would test the
   adapter's wire shape against fake pricing, conflating
   two issues. Cost numbers in the baseline would be
   meaningless.
2. **Gemini has different correlation semantics for
   tool_results.** Spec calls this out in
   `ProviderToolResultBlock.name` — Gemini correlates
   results to calls by name, not by id. The Anthropic
   adapter strips `name` before sending; the OpenAI adapter
   uses `tool_call_id`. The Google adapter's behavior here
   needs validation under load — high probability of a
   `name`-class bug analogous to what the Anthropic smoke
   surfaced.
3. **Need a Gemini API key.** Operational dependency, not
   technical.

**Pull-in signal:**

Pull when EITHER:

- The pricing values in `google/capabilities.ts` get updated
  to real Gemini pricing (likely bundled with the
  `cost_per_1k_*` → `cost_per_1m_*` rename and a
  `PROVIDERS.md §5` amendment).
- A user workflow calls for Gemini specifically (the 2M
  context window or the price/quality on simple summarization
  tasks).

**Whichever lands first.** Bundle the smoke run with the
pricing fix so the baseline numbers are trustworthy from
day one.

**Spec reference:** `PROVIDERS.md §5` and `§7`,
`src/providers/google/{capabilities,index,stream}.ts`.

---

## CI gate on smoke

**Status:** smoke harness is CI-ready but no pipeline wired.
Tracked since Step 6.

**What it is:** GitHub Actions (or equivalent) workflow that
runs `bun run eval:smoke --repeat 3 --model
anthropic/claude-haiku-4-5` on every PR (and/or main push)
and blocks merge on regression. Gates on:

- 100% pass rate (24/24 with strict-pass semantics).
- Cost envelope: total ≤ $0.20/run (10× headroom over
  current baseline).
- Per-case stability: no `failCount > 0` in the
  `eval_case_aggregate` output.

**Why deferred:**

1. **Cost per PR is recurring spend.** Anthropic baseline
   today: $0.15 per CI run. At 50 PRs/week that's ~$30/mo.
   Trivial in absolute terms but real ops cost; needs a
   budgeting decision before turning on.
2. **Single-provider gate or multi-provider?** Running both
   Anthropic and OpenAI smoke per PR doubles cost
   ($0.16/run total). Multi-provider catches more
   regressions but costs more. Decision waits until
   Gemini lands so the spread is visible.
3. **Secret management.** `ANTHROPIC_API_KEY` (and OpenAI/
   Gemini if multi-provider) needs to live as a repo secret.
   Threshold question: who has merge access to the workflow
   file? A malicious workflow change could exfiltrate the
   key. Current repo is solo-author so low risk, but the
   policy should be set before the second contributor lands.
4. **Smoke catches the wrong class of bug for some PRs.**
   A docs-only PR shouldn't pay $0.15 to re-validate the
   adapter. Need a `paths-ignore` filter (skip on
   `docs/**`, `*.md`, etc.) to avoid burning budget on
   no-op runs. Easy but worth doing right.
5. **Need a baseline-drift detection mechanism.** If
   gpt-4o-mini tomorrow costs 10% more per request (OpenAI
   re-prices, infrastructure shift, etc.), should the gate
   fail or warn? Hard threshold means false-positives;
   warn-only means the gate is decorative. Need to decide
   the policy first.

**Pull-in signal:**

Pull this when EITHER:

- A second contributor is merging PRs (gate prevents merge
  of broken adapter changes, value is concrete).
- A regression actually slips through and burns time
  debugging post-merge — that's the moment the gate
  becomes obviously cheap.

**Pre-requisites the gate depends on:**

- Multi-provider baseline stable (this is in place after
  Step 6.3).
- A `eval:regression` tier (~100 cases) so smoke doesn't
  carry the full validation load. Spec §16 places this in
  M3+.
- Baseline-drift policy decision (above).

**Spec reference:** `AGENTIC_CLI.md §16` ("Roda em CI.
Comparação contra **golden traces** versionados. Mudou
prompt do system? Roda eval. Regrediu? PR bloqueado.").
