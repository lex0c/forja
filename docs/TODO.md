# TODO — deferred work

Items intentionally left for later milestones, with the deferral
rationale and a "pull-in" signal so we know when to revisit.

---

## Monotonic seq tiebreaker on the remaining time-ordered tables

**Status:** noted during the M3/Step 2.4 audit pass (2026-04-29).

**What it is:** migrations 007 (messages.seq) and 008 (sessions.seq)
fixed the timestamp-tie ordering bug for the two tables whose
listings drive resume behavior. The same bug shape exists in three
more time-ordered repos that fall back to UUID lex on tied
timestamps:

- `src/storage/repos/tool-calls.ts:130` — `ORDER BY created_at ASC, id ASC`
- `src/storage/repos/bg-processes.ts:148, 161` — `ORDER BY spawned_at DESC, id ASC`
- `src/storage/repos/approvals.ts:66` — `ORDER BY decided_at ASC, id ASC`

**Effect today:** none observable. Each listing function is
exported but has no production call site (verified via grep).
The listings are reserved for the audit CLI / recap / forensics
work that hasn't landed yet.

**Fix shape:** mirror migrations 007/008 — add `seq INTEGER NOT
NULL DEFAULT 0` to each table, populate atomically at INSERT time
via the `MAX(seq)+1` subquery, backfill via ROW_NUMBER over the
existing ORDER BY, secondary `seq` in each list query.

**Pull-in signal:** any of these listings gets wired to a live
consumer (audit CLI, recap subsystem, the `agent audit` command
in spec §13). At that point the ordering becomes load-bearing
and the same class of bug that hit messages/sessions becomes
visible to users. Apply the migrations together rather than
piecemeal — the schema-change cost amortizes across three repos
that all need it.

**Why deferred:** YAGNI. Adding three migrations + index changes
for tables nobody queries today is schema churn for a theoretical
bug. The pattern is well-established in 007/008 so the eventual
fix is mechanical.

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

---

## Native structured output for compaction / critique / recap

**Status:** noted while reviewing the M4 critique branch
(2026-05-08). The contract slot exists
(`Provider.generateConstrained`) but is unused by the harness
paths that emit JSON-shaped output.

**What it is:** three subsystems currently emit JSON between
sentinel markers and parse the result with a custom parser.
Failure rate observed in the M4 real-eval was ~5% (markers
missing, malformed JSON, Unicode quotes in place of ASCII,
etc.). Today's call sites:

| Surface | Current mechanism | Reliability |
|---|---|---|
| Tool calls (`task`, `bash`, ...) | Native tool calling | Strong |
| Compaction summary | Markers + JSON parse | Weak |
| Critique output | Markers + JSON parse | Weak |
| Recap render | Markers + parse | Weak |
| Memory write proposals | Tool args | Strong |

The marker convention was chosen for cross-provider uniformity
at a time when JSON modes were patchy. Today every cloud
provider in the registry has a native structured-output path:

| Mechanism | Provider support | Guarantee |
|---|---|---|
| Tool calling with `input_schema` | Anthropic, OpenAI, Google | Strong (provider-validated) |
| `response_format: json_object` | OpenAI, partial Anthropic | Medium (no types in schema) |
| `response_schema` (JSON Schema) | Google, OpenAI Structured Outputs | Strong |
| GBNF / EBNF grammar | llama.cpp, vLLM | Strong (token-level) |
| Markers + parse | Any | Weak (best-effort) |

When a parse fails today, the critique engine writes
`strategy='failed'` to `critique_runs` and the run survives
(engine is fail-soft). Compaction falls back to the
deterministic summarizer when the marker close-tag is missing,
so the operator silently loses the semantic summary.

**Why deferred:**

1. **Real-world failure rate is low under default config.**
   5% sounds large until you remember that critique mode `off`
   is the default. The failure envelope only matters for
   opt-in `mode='always'` + long sessions. Compaction shares
   the parser shape but is invoked rarely (per-trigger, not
   per-step). Recap is on-demand. The blast radius today is
   "audit-row noise + fallback to deterministic path", not
   user-visible breakage.
2. **Cross-provider abstraction is non-trivial.** Each
   provider exposes structured output differently; a naive
   wire-up would scatter provider conditionals into the
   engine. The right shape is a schema-aware layer one step
   above the `Provider` interface, accepting a JSON Schema
   and routing to tool_use / response_format / response_schema
   / GBNF, with a marker fallback for providers that lack any
   constrained mode (older local models). Worth designing
   once, not per call site.
3. **Streaming + structured is still emerging.**
   `generateConstrained` returns the full string at the end,
   sacrificing streaming UX. Some providers already support
   streaming structured output (Anthropic tool_use streaming,
   OpenAI delta-mode structured outputs); bundling streaming
   into the same design pass avoids two rewrites.

**Pull-in signal:**

Pull when EITHER:

- A subsystem starts running `mode='always'` critique (or any
  equivalent always-on JSON path) and `parse_failed` /
  `markers_missing` audit rows accumulate enough to be visibly
  noisy. The typed contract pays for itself within weeks at
  that point.
- A new subsystem is added that needs JSON-shaped LLM output
  (planner emits structured plan, reviewer subagent emits
  structured findings). Cheaper to ship the abstraction once
  than to add a third marker-parser call site.

**Concrete shape (when pulled):**

```ts
const tool: ProviderToolDef = {
  name: 'emit_critique',
  description: 'Emit your structured critique',
  input_schema: {
    type: 'object',
    properties: {
      issues: { type: 'array', items: { /* ... */ } },
      overall_confidence: { type: 'number' },
    },
    required: ['issues', 'overall_confidence'],
  },
};
const req: ConstrainedRequest = {
  ...gen,
  tools: [tool],
  tool_choice: { type: 'tool', name: 'emit_critique' },
};
```

**Estimated work:**

- ~1 week — wire `generateConstrained` into the critique
  engine, fallback to markers when the provider lacks a
  structured mode.
- +1 week — same for compaction.
- +2 weeks — schema-aware abstraction above the provider
  contract; route a single JSON Schema to tool_use /
  response_format / response_schema / GBNF.
- Test suite: per-provider conformance (output respects the
  schema, not merely parses) + fallback semantics.

**Comparison vs. status quo:**

| | Markers + parse | Native structured |
|---|---|---|
| Provider effort | none (string interpreted) | provider enforces at token level |
| Observed failure rate | ~5% | <1% |
| Cost | same | same |
| Vendor lock-in | none | per-provider feature mapping |
| DX (engine code) | custom parser | typed contract |

**Spec reference:** `PROVIDERS.md §3` (Provider contract),
`CONTEXT_TUNING.md` (compaction), `AGENTIC_CLI.md §5.4` and
`ORCHESTRATION.md §6` (critique), `RECAP.md`.

---

## Permission policy ergonomics

**Status:** noted during the M4 critique branch review
(2026-05-08). The permission engine is functionally complete;
usability gaps surfaced repeatedly while running multi-step
flows during the branch.

**What it is:** the permission hierarchy (enterprise → user →
project → session) and the YAML rule shape work, but the
operator surface around them has friction. Six concrete pain
points observed:

a) **Discovery.** Operators don't know what permissions they
need until they hit the modal. Typical session yields 10–30
modals. Recurring workflows pay the cost on every restart.

b) **No pattern recognition.** Approving `bash("npm test")`
five times in one session does not surface a "promote to
allowlist?" suggestion. Only the modal's
"yes-allow-all-during-this-session" toggle exists, and it is
volatile (lost on restart).

c) **Visualization gaps.** `/perms` shows the merged policy
but does not show: what was approved this session, the
history of denials, or the practical diff between modes
(`strict` vs `acceptEdits`).

d) **Mode names are opaque.** `strict | acceptEdits | bypass`
require reading `AGENTIC_CLI.md §8` to interpret. New
operators have no inline hint.

e) **Glob is fragile for shell.** `command_glob: 'rm *'`
matches both `rm -rf /` (intended) and `git rm file.txt`
(probably not intended). Bash's command space is semantically
rich; text glob over the raw command string is a leaky
abstraction.

f) **Denial errors are unhelpful.** Tool denied → `ToolError`
with a generic message to both the model and the operator.
Neither sees which rule fired or which layer holds it.

**Why deferred:**

1. **Not a correctness gap.** Every pain point above is
   friction, not a bug. The engine refuses what it should
   refuse and allows what it should allow. Operators
   tolerate the friction today because session count is
   low and the team is small.
2. **Adjacent subsystems should land first.** Pattern
   learning (Tier 2 below) needs durable session-scoped
   audit history that today only exists transiently. Tier 4
   (AST-based bash matching) needs a shell-parser dependency
   decision the codebase hasn't made yet.
3. **Risk of incentivizing `bypass`.** Premature ergonomics
   work that surfaces "easy approve" affordances without
   first exposing the underlying policy can push operators
   toward `bypass` mode, the opposite of the safety goal.
   Order matters: discoverability before promotion.
4. **Composes with sandbox.** Sandbox of tool execution is
   the structural defense layer; ergonomics is the operator
   layer above it. Doing ergonomics first means redoing some
   of the surface once sandbox lands.

**Pull-in signal:**

Pull when EITHER:

- A second operator joins the project and modal volume
  becomes a complaint (the discovery pain compounds with
  team size).
- The session-history audit work referenced in `AUDIT.md`
  lands, unblocking pattern learning without a new schema.
- An incident is traced to a glob false-positive — Tier 4
  becomes load-bearing the moment a permissive `*` rule
  allows something the operator did not intend.

**Tier breakdown (when pulled):**

| Tier | Scope | Estimated work |
|---|---|---|
| 1 | Discoverability: `--explain-permissions`, modal cites matching rule + layer, `/perms why <tool>` | ~2 weeks |
| 2 | Pattern learning (opt-in): N-approval prompt to promote, `--learn-mode`, `/perms suggestions` | ~3 weeks |
| 3 | Policy templates: `safe-readonly`, `trusted-fullstack`, `ci-locked`; `agent init --template=<name>` | ~1 week |
| 4 | AST-based bash matching; explicit relative-vs-absolute path glob semantics; rule composability (any-of / all-of) | ~2 weeks |
| 5 | `/perms diff session`, `/perms commit` (promote session-allowlist to project layer with confirm), `/perms revert` | ~1 week |

**Trade-offs:**

- **Pro:** UX value per engineer-day is high; zero
  architectural risk (pure surface work).
- **Pro:** Reduces modal fatigue, so operators leave strict
  mode on rather than defaulting to bypass.
- **Pro:** Pattern learning is a positive safety layer
  (visibility into accumulated session approvals).
- **Pro:** Composes with sandbox-of-tool-execution as
  defense in depth.
- **Con:** Policy UX is a known-difficult design space;
  rolling Tier 2 without a thoughtful flow can backfire
  (auto-promote surprises).
- **Con:** Risk of pushing operators toward `bypass` if the
  "fast path" is too prominent.

**Mitigations to bake into the design when pulled:**

- `--no-auto-promote` flag for operators who want the modal
  flow as-is.
- Every promote action requires explicit confirm; never
  silent.
- Tier 2 reads from durable audit, not in-memory state, so
  suggestions survive restarts and can be reviewed offline.

**Spec reference:** `AGENTIC_CLI.md §8` (permissions),
`SECURITY_GUIDELINE.md` (threat model), `AUDIT.md` (session
history that pattern learning would consume).
