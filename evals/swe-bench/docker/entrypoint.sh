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
# repoint it at the image's baked deps. rm -rf FIRST, not just `ln -sfn`: the agent can replace
# /task/node_modules with a real DIRECTORY (its own `bun install`), and GNU ln would then drop the link
# INSIDE it (node_modules/node_modules) rather than replacing it — so the verifier container would
# resolve the AGENT's packages and the oracle could pass via dependency tampering, not a src/ fix. The
# rm guarantees both phases (agent + verifier) always resolve the BAKED deps.
rm -rf /task/node_modules
ln -sfn /app/node_modules /task/node_modules
cd /task || exit 2

# The container runs as root, so everything it writes into the mounted /task is root-owned. Make the
# tree world-writable on EVERY exit (normal or error) so the (non-root) host orchestrator can rewrite
# (anti-cheat restore between the agent and verifier containers) and clean it up without EPERM. A hard
# timeout/kill is the only path that skips it; the host tolerates a residual EPERM there.
trap 'chmod -R a+rwX /task 2>/dev/null || true' EXIT

# Egress self-check — the preflight the orchestrator runs before the corpus. The model host MUST be
# reachable THROUGH the proxy via BUN fetch (the same client forja's providers use, so a Bun that stops
# honoring HTTPS_PROXY is caught HERE, not as silent per-task model failures), AND github MUST be blocked
# both ways (no direct route on the --internal net; the proxy allowlist 403s it). Exit non-zero on any
# violation so the orchestrator aborts loudly rather than scoring a network-broken run as model incapacity.
if [ -n "$FORJA_NET_TEST" ]; then
  host="${FORJA_NET_TEST_HOST:-ollama.com}"
  # Bun fetch, NOT curl: curl honors $HTTPS_PROXY natively, so a curl probe would pass even if Bun did
  # not — masking the very regression this guards. 'FAIL' = bun fetch never reached the host.
  model=$(bun -e "console.log(await fetch('https://$host',{signal:AbortSignal.timeout(15000)}).then(r=>r.status).catch(()=>'FAIL'))" 2>/dev/null || echo FAIL)
  # The egress LOCK is a network property (internal net + proxy allowlist), client-independent → curl.
  # curl's -w writes the http_code itself (000 when nothing answered), so NO `|| echo` — that would
  # DOUBLE it to "000000". A real 3-digit code = the host answered (a leak); 000 / empty = blocked.
  gh_direct=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --noproxy '*' https://api.github.com 2>/dev/null)
  gh_proxy=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://api.github.com 2>/dev/null)
  echo "NET model $host via proxy (bun fetch): $model"
  echo "NET github direct: ${gh_direct:-000}"
  echo "NET github via proxy: ${gh_proxy:-000}"
  rc=0
  [ "$model" = "FAIL" ] && { echo "NET FAIL: bun fetch can't reach the model host through the proxy (proxy down, or this Bun doesn't honor HTTPS_PROXY)"; rc=1; }
  case "$gh_direct" in [1-5][0-9][0-9]) echo "NET FAIL: github answered on DIRECT egress — the network is not --internal"; rc=1 ;; esac
  case "$gh_proxy" in [23][0-9][0-9]) echo "NET FAIL: github reachable VIA the proxy — allowlist leak"; rc=1 ;; esac
  [ "$rc" = 0 ] && echo "NET OK: model reachable via the proxy (bun fetch), github blocked both ways"
  exit "$rc"
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
