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
#   /task/.run.log  — the FULL execution (agent loop + verifier, stdout+stderr). Internal errors here.
#   /task/.result   — the verifier exit code (0 = oracle passed). Network errors show in the proxy
#                     sidecar's logs, captured host-side (`docker logs <proxy>`).
#
# Env:
#   FORJA_PROMPT   — the agent prompt (the failing test). Empty ⇒ skip the agent (verifier-only).
#   FORJA_MODEL    — the model id (e.g. ollama/devstral-2:123b). Required with FORJA_PROMPT.
#   ORACLE_TESTS   — space-separated oracle test path(s) for the verifier.
#   HTTPS_PROXY    — the egress proxy URL (e.g. http://swe-proxy:8889), passed by the orchestrator.
#   FORJA_NET_TEST — when set, runs the egress self-check and exits (skips agent/verifier).

# Tee everything to /task/.run.log (on the mounted volume) AND through to stdout (so the host
# orchestrator's own capture still sees it live). Survives a timeout/kill with partial logs intact.
exec > >(tee /task/.run.log) 2>&1

# The materialized workspace ships a node_modules symlink to a HOST path that doesn't exist here;
# repoint it at the image's baked deps. -n (no-deref) + -f so the stale link is overwritten.
ln -sfn /app/node_modules /task/node_modules
cd /task || exit 2

# Egress self-check: model reachable through the proxy, github NOT (direct = no route, proxied = 403).
if [ -n "$FORJA_NET_TEST" ]; then
  echo "model  via proxy: $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://ollama.com 2>&1 || echo UNREACHABLE)"
  echo "github direct   : $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --noproxy '*' https://api.github.com 2>&1 || echo NO-ROUTE)"
  echo "github via proxy: $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://api.github.com 2>&1 || echo REFUSED-403)"
  exit 0
fi

# Agent phase — the FULL forja loop (tools, context, state) fixes the bug. `|| true`: a non-zero
# agent exit (budget hit, gave up) still goes to verification — the test is the judge, not the agent.
if [ -n "$FORJA_PROMPT" ]; then
  echo ">>> agent: forja '$FORJA_MODEL' on the failing test"
  forja "$FORJA_PROMPT" --model "$FORJA_MODEL" || echo ">>> agent exited non-zero (continuing to verify)"
fi

# Verifier phase — the oracle test decides pass/fail. Capture the code, write it for the host, and
# exit with it so `docker run` mirrors the result.
echo ">>> verifier: bun test $ORACLE_TESTS"
bun test $ORACLE_TESTS
code=$?
echo "$code" > /task/.result
exit "$code"
