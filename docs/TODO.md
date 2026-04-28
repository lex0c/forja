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
