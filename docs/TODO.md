# TODO — deferred work

Items intentionally left for later milestones, with the deferral
rationale and a "pull-in" signal so we know when to revisit.

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
