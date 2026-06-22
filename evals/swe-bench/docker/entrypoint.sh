#!/bin/bash
# Ephemeral self-SWE-bench TASK container. The ONLY mount is:
#   /task  — the materialized workspace (parent `C^` tree + the failing-test patch; NO .git, NO
#            corpus, NO gold). The agent fixes src/ here. Also receives the run artifacts below.
# The deps are BAKED in the image at /app/node_modules. The answer repo is NOT present anywhere.
#
# Network: this container sits on an `--internal` docker network (no direct egress). Its ONLY route
# out is the proxy sidecar (reached via $HTTPS_PROXY), which tunnels ONLY to the model host. So a
# direct `curl github` has no route, and a proxied one gets 403 — the agent can't fetch the gold.
#
# DEBUG ARTIFACTS (written to the mounted /task, so the host keeps them even on timeout/kill):
#   /task/.run.log  — this container's execution (stdout+stderr). In the split flow it holds the agent
#                     loop in the agent container and the verifier in the verifier container; the host
#                     preserves the agent's copy (run.log) before the verifier container overwrites it.
#   /task/.result   — the verifier exit code (0 = oracle passed). Network errors show in the proxy
#                     sidecar's logs, captured host-side (`docker logs <proxy>`).
#
# Env:
#   FORJA_PROMPT    — the agent prompt (the failing test). Empty ⇒ skip the agent (verifier-only).
#   FORJA_MODEL     — the model id (e.g. ollama/devstral-2:123b). Required with FORJA_PROMPT.
#   FORJA_MAX_STEPS — the agent's step budget (passed to forja --max-steps; default 40).
#   SWE_SKIP_VERIFY — when set, the container runs the agent ONLY and exits (the host restores the
#                     test surface, then a SEPARATE verifier-only container scores it — see runTask).
#   ORACLE_TESTS    — space-separated oracle test path(s) for the verifier.
#   HTTPS_PROXY     — the egress proxy URL (e.g. http://swe-proxy:8889), passed by the orchestrator.
#   FORJA_NET_TEST  — when set, runs the egress self-check and exits (skips agent/verifier).

# Tee everything to /task/.run.log (on the mounted volume) AND through to stdout (so the host
# orchestrator's own capture still sees it live). Survives a timeout/kill with partial logs intact.
exec > >(tee /task/.run.log) 2>&1

# The materialized workspace ships a node_modules symlink to a HOST path that doesn't exist here;
# repoint it at the image's baked deps. -n (no-deref) + -f so the stale link is overwritten.
ln -sfn /app/node_modules /task/node_modules
cd /task || exit 2

# The container runs as root, so everything it writes into the mounted /task is root-owned. Make the
# tree world-writable on EVERY exit (normal or error) so the (non-root) host orchestrator can rewrite
# (anti-cheat restore between the agent and verifier containers) and clean it up without EPERM. A hard
# timeout/kill is the only path that skips it; the host tolerates a residual EPERM there.
trap 'chmod -R a+rwX /task 2>/dev/null || true' EXIT

# Egress self-check: model reachable through the proxy, github NOT (direct = no route, proxied = 403).
if [ -n "$FORJA_NET_TEST" ]; then
  echo "model  via proxy: $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://ollama.com 2>&1 || echo UNREACHABLE)"
  echo "github direct   : $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --noproxy '*' https://api.github.com 2>&1 || echo NO-ROUTE)"
  echo "github via proxy: $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://api.github.com 2>&1 || echo REFUSED-403)"
  exit 0
fi

# Agent phase — the FULL forja loop (tools, context, state) fixes the bug. The `|| echo …` swallows a
# non-zero agent exit (budget hit, gave up) so the flow continues — the test is the judge, not the agent.
if [ -n "$FORJA_PROMPT" ]; then
  # The container IS the safety boundary (no answer reachable, egress locked, ephemeral), so the agent
  # runs unsupervised. Two things would otherwise dead-end every tool call headless (no TTY to confirm)
  # and trap the agent in a rejection loop:
  #   1. No bwrap inside the container ⇒ forja's engine enters "degraded mode" (no sandbox available →
  #      confirm before continuing). The sandbox_skip sentinel opts out of the inner sandbox — the
  #      container already provides isolation, so tools run directly.
  #   2. The default Supervised/strict policy gates bash/edit. A bypass policy permits every tool call
  #      (the same thing the in-process eval injects: `defaults: { mode: bypass }`).
  mkdir -p "$HOME/.config/forja" && touch "$HOME/.config/forja/sandbox_skip"
  mkdir -p /task/.forja
  printf 'defaults:\n  mode: bypass\n' > /task/.forja/permissions.yaml
  echo ">>> agent: forja '$FORJA_MODEL' on the failing test"
  # Run UNSANDBOXED (the `host` profile). bwrap CANNOT run inside Docker (no new namespaces), so the
  # inner sandbox would be unavailable → forja's engine enters degraded mode (confirm every tool call →
  # headless deadlock). The two-gate host opt-in (SECURITY.md §4.1) bypasses it: --sandbox-host makes
  # `host` selectable, --i-know-what-im-doing emits the host-passthrough sentinel so the planner covers
  # it. Safe here: the CONTAINER is the sandbox (no answer reachable, egress locked, ephemeral) — forja's
  # inner sandbox is redundant.
  forja "$FORJA_PROMPT" --model "$FORJA_MODEL" --sandbox-host --i-know-what-im-doing \
    --max-steps "${FORJA_MAX_STEPS:-40}" \
    || echo ">>> agent exited non-zero (continuing to verify)"
fi

# Split flow: the agent runs in its OWN container; the host then restores the canonical test
# surface (anti-cheat) before a SECOND container runs the verifier. SWE_SKIP_VERIFY ends the
# agent container here (the EXIT trap chmods /task so the host can rewrite + clean it).
if [ -n "$SWE_SKIP_VERIFY" ]; then
  echo ">>> agent phase complete (verifier runs separately after host restore)"
  exit 0
fi

# Verifier phase — the oracle test decides pass/fail. Capture the code, write it for the host, and
# exit with it so `docker run` mirrors the result.
echo ">>> verifier: bun test $ORACLE_TESTS"
bun test $ORACLE_TESTS
code=$?
echo "$code" > /task/.result

# PASS_TO_PASS (anti-cheat #9): sibling tests that must stay green. Run + record SEPARATELY so the
# orchestrator can flag overfit — the oracle passed but a sibling broke (a fix that special-cases the
# visible oracle and corrupts other callers).
if [ -n "$PASS_TO_PASS" ]; then
  echo ">>> pass_to_pass: bun test $PASS_TO_PASS"
  bun test $PASS_TO_PASS
  echo "$?" > /task/.p2p
fi

exit "$code"
