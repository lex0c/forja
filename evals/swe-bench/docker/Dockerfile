# self-SWE-bench task runner image. Contains ONLY: bun (for `bun test`), the project's deps (baked
# at build time), the compiled forja binary (the full agent loop — self-contained, no source), the
# egress proxy (a static Go binary), and the entrypoint. The task workspace is the ONLY run-time
# mount; the answer repo (its .git / corpus / changelog) is NEVER present → the agent can't read,
# `find /`, or `git show` the gold. The same image runs in two roles: the TASK container (default
# entrypoint) and the egress PROXY sidecar (`--entrypoint /usr/local/bin/egress-proxy`).

# --- egress proxy builder: a static Go binary (stdlib only). The toolchain is discarded — only the
#     ~few-MB binary lands in the final image. Go (not bun) for a long-running sidecar across a run. ---
FROM golang:1.23-alpine AS proxy
WORKDIR /build
COPY egress-proxy.go .
RUN go mod init egress-proxy \
  && CGO_ENABLED=0 go build -ldflags='-s -w' -o egress-proxy .

# --- task runner image ---
FROM oven/bun:1.3.13-slim

# curl + ca-certificates for the egress self-check; bash for the entrypoint's tee. No iptables: the
# force-through is a network property (the task container sits on an `--internal` network whose only
# member with egress is the proxy sidecar), not a kernel rule — so no NET_ADMIN, no host-firewall dep.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Bake the deps INTO the image (build-time network). Total isolation: the RUN-time task container
# needs NO registry access. Deps layer (manifest only) caches across binary rebuilds.
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The self-contained forja binary (built host-side via `bun run build`) + the Go egress proxy + the
# entrypoint.
COPY forja /usr/local/bin/forja
COPY --from=proxy /build/egress-proxy /usr/local/bin/egress-proxy
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/forja /usr/local/bin/egress-proxy /entrypoint.sh

WORKDIR /task
ENTRYPOINT ["/entrypoint.sh"]
