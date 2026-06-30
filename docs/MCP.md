# Forja MCP Operator Guide

This document describes Forja's Model Context Protocol (MCP) integration: how to declare servers, how trust works, how an MCP server's tools appear to the model, the lifecycle that governs a connection, and what is deliberately not in this version.

The canonical specification lives in `docs/spec/MCP.md` (PT-BR) with cross-cuts in `docs/spec/CONTRACTS.md §11` (the A/B contract), `docs/spec/STATE_MACHINE.md §6.5` (the state machine), and `docs/spec/AUDIT.md §1.5` (the table schemas). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What MCP is for

MCP is **the single extension path for the tool catalog** (`CONTRACTS §2.6.7`). The 38 builtin tools are canonical and closed; anything else — a database, a browser, a company service — arrives through an MCP server without touching builtin code. A server advertises a set of tools over a JSON-RPC channel; Forja namespaces them, gates them behind trust + the permission engine, and hands them to the model as ordinary tools.

What MCP integration **is**, in this version:

- A way to run **local stdio MCP servers** declared in a config file and reach their tools from the agent loop.
- Trust-gated: a server's tool set is authorized **per manifest hash** before any of its tools become callable, and trusting it authorizes **running its command** (a local binary).
- Permission-integrated: MCP tools flow through the same risk engine, checkpoints, and policy layers as builtin tools, under a dedicated `mcp` category.

What it **is not** (yet) — see §8:

- Not an OAuth client yet — remote SSE / streamable-HTTP servers work with env-bearer auth; the OAuth flow is a later slice.
- Not a sandbox (the server process runs with the agent's own privileges in this version).
- Not exposed to subagents (MCP tools are parent-session-scoped).
- Not operable mid-session via slash commands (changes mean a config edit + restart).

### 1.1 Architecture at a glance

Everything lives under `src/mcp/`. The rest of the harness sees MCP tools only as ordinary `Tool` objects in the registry — nothing in the loop or the provider adapters knows MCP exists.

```
                    ┌──────────────────────────────────────┐
                    │  src/mcp/config.ts                    │
                    │  - loads the mcp.toml family (3 layers)│
                    │  - merge by precedence, $VAR resolve   │
                    └───────────────────┬──────────────────┘
                                        │ McpServerConfig[]
                    ┌───────────────────▼──────────────────┐
                    │  src/mcp/manager.ts  (McpManager)     │
                    │  - built broker-style in bootstrap     │
                    │  - owns connections + the state machine│
                    │  - init():     trust → register tools  │
                    │  - callTool(): lazy connect → proxy    │
                    │  - cleanup():  disconnect all          │
                    └───┬────────────────┬───────────────┬──┘
          McpClient     │       hash     │      Tool     │
        ┌───────────────▼──┐ ┌───────────▼────┐ ┌────────▼─────────┐
        │ src/mcp/client.ts│ │ manifest.ts    │ │ tool-factory.ts  │
        │ THE SDK boundary │ │ canonicalize + │ │ manifest → Tool  │
        │ stdio transport  │ │ sha256 (trust  │ │ mcp__srv__tool   │
        │ (official SDK)   │ │ key)           │ │ + metadata map   │
        └──────────────────┘ └────────────────┘ └──────────────────┘

   storage:  migrations/081-mcp-servers.ts + repos/mcp-servers.ts
             mcp_servers          = per-server STATE (swept when it leaves config)
             mcp_manifest_history = trust decisions, APPEND-ONLY FOREVER
```

- **`config.ts`** loads and merges the `mcp.toml` family into `McpServerConfig[]`.
- **`client.ts`** is the *only* file that imports `@modelcontextprotocol/sdk`. A shared `sdkClientFrom` wraps the SDK `Client` behind the internal `McpClient` interface (defensively parsing untrusted server output); the stdio, SSE, and streamable-HTTP factories differ only in how they build the transport, and `createMcpClient` dispatches on the configured kind.
- **`manifest.ts`** canonicalizes a `tools/list` response and hashes it — the hash is the trust key.
- **`tool-factory.ts`** turns a manifest tool into a Forja `Tool`: the wire name, the metadata mapping, and an `execute` that proxies back to the manager.
- **`manager.ts`** ties it together: built once in `bootstrap` (like the `broker`), it owns each server's connection and state, registers trusted tools at `init()`, lazily connects on the first `callTool()`, and disconnects every child at `cleanup()`.

---

## 2. Declaring servers — the `mcp.toml` family

MCP servers live in a **dedicated config-file family**, not a section of `config.toml`. Three layers, in increasing precedence:

| Layer | Path | Intended use |
|---|---|---|
| user | `~/.config/forja/mcp.toml` | per-user global servers |
| project | `.forja/mcp.toml` | per-project, committed/shared |
| local | `.forja/mcp.local.toml` | per-project, gitignored (secrets, machine-specific) |

**Precedence is local > project > user.** A server name defined in more than one layer resolves to the highest-precedence definition; the override emits a warning, not an error. Loading is **fail-soft**: a malformed file or entry emits a warning and is skipped — it never aborts boot. Config warnings surface on the startup banner.

Each server is a `[servers.<name>]` table. The **name** must match `^[a-z][a-z0-9_]*$` and be ≤ 40 chars (it becomes the middle segment of `mcp__<server>__<tool>`, so it needs no sanitization).

### 2.1 Keys

| Key | Required | Notes |
|---|---|---|
| `transport` | yes | `"stdio"` (a spawned subprocess), or `"sse"` / `"http"` (a remote endpoint; `"http"` is streamable-HTTP). The keys below are grouped by which transport they apply to. |
| `command` | stdio | Non-empty array of strings. `command[0]` is the executable; the rest are argv. |
| `env` | stdio | Table of `string → string` added to the child's environment. |
| `cwd` | stdio | Working directory for the child process. |
| `sandbox` | stdio | `false` runs the server **unconfined**. Omit (or `true`) → **sandboxed by default** when a sandbox tool (bwrap / sandbox-exec) is available (§7). |
| `network` | stdio | A `[servers.<name>.network] allow_hosts = [...]` sub-table grants the server network. The host list is **advisory** (shown in the trust modal + audited), NOT kernel-enforced, and network-granted tools become **egress** (always confirmed, never auto-approved). |
| `url` | sse/http | The endpoint URL — must be `http(s)`. The trust identity for a remote server (a change re-triggers trust). **No embedded credentials** (`user:pass@…`) — a URL with userinfo is rejected; put the token in `auth`. |
| `auth` | no (sse/http) | `auth = { kind = "bearer", env = "VAR" }`. The token is read from `$VAR` **at load** and sent as `Authorization: Bearer …`; only the env-var *name* lives in config — the token never persists. An unset/blank `$VAR` warns and sends no header. OAuth is a later slice. |
| `surface` | no | `"base"` (always on the wire) or `"deferred"` (reached via `tool_search`). **Default `"deferred"`** so a many-tool server doesn't bloat the base surface. |
| `disabled` | no | `true` to parse-but-skip the server (keeps its trust + state rows). Default enabled. |

A **remote** (sse/http) server has no subprocess, so the stdio-only keys (`command`/`env`/`cwd`/`sandbox`/`network`) don't apply — its tools are inherently **egress** (always confirmed, never auto-approved), and `sandbox`/`network` set on a remote entry warn and are ignored.

**`$VAR` / `${VAR}`** in `command`, `env` values, `cwd`, and `url` are resolved from the agent session environment. An **unset** variable substitutes an empty string and warns (rather than leaking a literal `$VAR`). Keep secrets in the environment (and the server entry in the gitignored `mcp.local.toml`) — never inline them.

### 2.2 Example

```toml
# .forja/mcp.toml  (committed)
[servers.everything]
transport = "stdio"
command   = ["npx", "-y", "@modelcontextprotocol/server-everything"]

[servers.postgres]
transport = "stdio"
command   = ["mcp-server-postgres", "--dsn", "$DATABASE_URL"]
surface   = "base"          # put its tools on the base wire
env       = { PGCONNECT_TIMEOUT = "5" }
```

```toml
# .forja/mcp.local.toml  (gitignored — holds the auth env-var binding)
[servers.github]
transport = "http"          # streamable-HTTP; "sse" for the legacy transport
url       = "https://api.githubcopilot.com/mcp/"
auth      = { kind = "bearer", env = "GITHUB_MCP_TOKEN" }
```

`$DATABASE_URL` resolves from the environment at load time; the **unresolved** form (`--dsn $DATABASE_URL`) is what gets persisted and shown in the trust modal, so the secret never lands at rest. For the remote `github` server, the trust identity is its `url` (a change re-prompts), and `$GITHUB_MCP_TOKEN` is read at load and sent as a `Bearer` header — only the variable *name* is in config.

---

## 3. Trust

Trusting an MCP server authorizes **two** things: reaching it — spawning a stdio server's `command` (arbitrary local code) or connecting to a remote server's `url` (network egress) — and exposing its declared tools to the model. Trust is keyed on a **manifest hash**.

### 3.1 The manifest hash

`manifest_hash = sha256(canonical_json(...))` over each tool's `name`, `description`, `inputSchema`, **and** `meta` (the `_meta.agentic_cli` hints). Covering `meta` is the core integrity property: a trusted server cannot silently downgrade a tool's declared `category` or flip `writes` after the fact — any such change re-hashes and re-prompts. The MCP `protocolVersion` is deliberately **not** hashed (it's transport noise, not capability).

### 3.2 First-visit vs drift

- **first-visit** — a server whose manifest hash has never been granted.
- **drift** — a previously-trusted server whose hash changed (its tools or its command). Re-authorization is required; until then the server is held `degraded` and its old tool set stays pinned.

### 3.3 Interactive: the trust modal

When a TTY operator is present, an unknown/changed manifest raises the `askMcpTrust` modal. It is a **trust-gate** modal (the same warn-toned "stop and read" family as cwd-trust and shared-memory trust). It shows:

- the **server name**,
- the **command** being authorized (the headline — this is the binary you are about to run, shown from the unresolved argv so no secret leaks),
- the **tool inventory** (name + description, capped at 8 with an overflow line),
- the **manifest hash**.

Every string in the modal is sanitized at the render boundary (a hostile manifest can't repaint the terminal). The **conservative default is "No, do not run it"** — hitting Enter without reading declines. Esc / timeout / cancel all resolve to deny. Tools the server declares as writing are marked `[writes]` in the inventory so the operator can see which ones carry side effects.

> **Limitation — `$VAR` in a command is trust over the *literal*.** Both the modal and the command-change re-trust use the **unresolved** argv. If a command contains a variable (e.g. `command = ["$MCP_BIN"]`), re-pointing that variable in the environment swaps the real binary **without** re-triggering trust, and the modal only ever shows the literal `$MCP_BIN`. Trusting such a server means trusting whatever the operator's environment resolves it to. Hashing the *resolved* command for change-detection is a deferred follow-up (§8); until then, prefer a literal executable for servers you don't fully control and keep `$VAR` for arguments/secrets, not the binary itself.

### 3.4 Headless: fail-closed

With no interactive confirmer (one-shot `run`, evals, CI), a server is **denied unless explicitly allowed** via:

```
forja --auto-approve-mcp <comma-separated-server-names>
```

The flag lists servers by name; it rejects an empty list and rejects `*` (no blanket auto-approve — `ANTI_PATTERNS §6.6`). A denied server is never spawned and its tools never register.

### 3.5 History

Every decision (`granted` / `denied` / `revoked` / `superseded`) appends to `mcp_manifest_history`, which is **append-only and never pruned**. A re-added or re-seen server with a matching command + hash re-uses its cached grant with no fresh prompt.

---

## 4. How an MCP tool appears to the model

### 4.1 Naming

A manifest tool `t` from server `s` registers as **`mcp__<s>__<sanitize(t)>`** (double underscore). The double-underscore wire form is required because tool names must match `^[a-zA-Z0-9_-]{1,64}$` (provider constraint) and colons collide with the `<kind>:<scope>` capability grammar and the `Bash(...)` rule grammar. Tool-half names are sanitized and de-duplicated so registration never throws on a hostile manifest (long names, illegal chars, two tools colliding).

### 4.2 Metadata mapping (`_meta.agentic_cli`)

A server may attach non-authoritative hints under each tool's `_meta.agentic_cli`. The harness decides policy; these only tune defaults:

| Hint | Effect if present | Default if absent |
|---|---|---|
| `category` | **ignored in this version** — every MCP tool gets the `mcp` category (a server can't self-select a softer one, e.g. `read`); still parsed + hashed, so a change re-prompts, but it never reaches policy | `mcp` |
| `writes` | drives checkpointing | **`true`** (pessimistic — a write is checkpointed) |
| `network` | informational | — |
| `parallel_safe` | — | `false` (MCP calls are not parallel-batched) |
| `deferred` | per-tool surface override | server's `surface` |
| `idempotent` | informational | — |

### 4.3 Permission category

MCP tools sit in a dedicated **`mcp` policy category**. No policy section is consulted for `mcp` in this version, so the category-level default decision is **allow** — manifest trust already gated the whole tool set and its declared metadata. This is *not* a bypass:

- the **risk engine still runs** — the `mcp_tool` supply-chain weight can tip a risky call into a score-confirm before it executes,
- `writes: true` still forces a **checkpoint** before the call.

A plain stdio server's `mcp` category is **not** egress (a local subprocess). But a server **granted network** (`[servers.<name>.network]`, §7) uses the **`mcp.egress`** category instead: it defaults to **confirm** and is never auto-approved under the autonomous posture — once a server can reach the network, its tools can exfil, so each call is seen. (A remote transport reuses `mcp.egress` when it lands.) Per-tool MCP policy rules — an operator denying/confirming a specific `mcp__<server>__<tool>` pattern — are a later slice (§8); in this version trust is all-or-nothing at the server level.

---

## 5. Lifecycle — the state machine

A server moves through eight states (`STATE_MACHINE §6.5`); the current value is persisted in `mcp_servers.state`.

| State | Meaning |
|---|---|
| `disconnected` | known from config, no live connection |
| `handshaking` | transport up, doing `initialize` + `tools/list` |
| `trust_pending` | manifest in hand, awaiting a trust decision |
| `trusted` | manifest granted; tools registered; not currently connected |
| `active` | connected and serving `tools/call` |
| `degraded` | reachable but drifted (hash changed) — old tools pinned, awaiting re-trust |
| `denied` | trust declined (or headless fail-closed) — no tools |
| `error` | connect/handshake failure |

**Connections are lazy.** `init()` performs the handshake needed to obtain + hash the manifest and resolve trust, then registers the tools and drops the connection. The server is re-spawned on the **first `tools/call`**, and the handshake at both points is **timeout-bounded** so a wedged server can't hang startup. `cleanup()` (run at every teardown site — REPL shutdown, one-shot `run`, and per-eval-case) disconnects every child.

---

## 6. Storage + audit

Two tables (migration `081-mcp-servers.ts`, repo `repos/mcp-servers.ts`):

- **`mcp_servers`** — per-server STATE: transport, the redacted command, source layer, current state + manifest hash, counters. This is mutable state, so it is **swept when the server leaves config**: `manager.init()` deletes any `mcp_servers` row whose name is in neither the enabled nor disabled config set (toggling `disabled` keeps the row).
- **`mcp_manifest_history`** — every trust decision, **append-only forever**. It is deliberately absent from `GC_TABLES`, so `forja gc` never prunes it; the forever-retention holds by construction. The server's history survives even after its `mcp_servers` row is swept, so a re-added server re-uses its cached grant.

---

## 7. Operating notes

- **Warnings** from config parsing and trust (`server 'x' redefined…`, `'url' must be http(s)…`, `bearer token env var $Y is not set…`) surface on the startup banner.
- **Managing servers in-session:** `/mcp` lists every server with its live state + tool count;
  `/mcp show <server>` adds the command, manifest hash, and trust history; `/mcp revoke <server>`
  denies a server and removes its tools (durable — it stays denied across a relaunch until you
  reconnect); `/mcp reconnect <server>` clears the revocation and re-trusts + re-registers it (no
  restart needed); `/mcp logs <server>` tails the server's captured stderr. The mutating commands
  run **between turns** (they hot-swap the live tool set).
- **Server stderr** is captured to `<dataDir>/traces/mcp-<name>.log` (operator-only, lazily created
  on the first byte, rotated at 10 MB with one kept generation). It is *always drained* even when no
  trace dir is configured — an unread pipe would otherwise block the server on its next stderr write.
- **Sandbox.** When a sandbox tool (Linux `bwrap`, macOS `sandbox-exec`) is present, every stdio server is confined **by default** — host filesystem read-only, the cwd read-write, no network — unless you set `sandbox = false` or grant `network`. The trust modal shows the effective posture; a server that can't be sandboxed (no tool, or your opt-out) is flagged **UNSANDBOXED**. If a tool was present at boot and later vanishes, the server fails closed rather than running exposed. bwrap network is all-or-nothing — `allow_hosts` is advisory, not kernel-enforced (§8), and a network-granted server's tools are treated as egress (always confirmed).
- **Secrets** belong in the environment + the gitignored `mcp.local.toml`. The persisted command and the trust modal both use the unresolved argv, so a `$VAR` secret is never written to the DB or shown on screen.
- **End-to-end proof.** `tests/mcp/real-subprocess.test.ts` drives the real SDK adapter against `evals/mcp/fixtures/echo-server.ts` (a real stdio server) — the happy path, the headless fail-closed path, and the cached-grant path — so the whole stack is exercised over real pipes in CI without a model in the loop.

---

## 8. Not in this version (deferred)

These are specified but intentionally out of the first MCP release; each is its own slice when its ecosystem need is real:

- **Remote OAuth — not planned.** The MCP auth model is env-bearer (§2.1), which covers the common case (a PAT / token in an env var, sent as `Authorization: Bearer …`). The SDK exposes an interactive `authProvider` flow (discovery + dynamic client registration + the authorization-code redirect), but adopting it would add a refresh-token + client-registration **credential-at-rest** surface the project deliberately avoids, plus a loopback-callback browser dance not worth it for a CLI where the operator can supply a token directly. Revisit only for a server that is OAuth-only.
- **Remote heartbeat health** — proactive staleness detection for a remote (sse/http) connection (`heartbeat_max_age_ms`, spec §2.2/§5). Today a dead idle remote is discovered lazily on the next `tools/call` (which degrades + surfaces the fault), not by a background liveness probe.
- **Per-host network filtering + ulimits** — the sandbox (§7) confines the filesystem and toggles network on/off, but bwrap network is all-or-nothing: the `allow_hosts` list is advisory, not kernel-enforced (per-host filtering via proxy/nftables is future), and the CPU/memory/file ulimits in the spec are not yet applied. Treat a network-granted server's reach as "the whole network".
- **Resolved-command change-detection** — hashing the `$VAR`-resolved argv (persisted as a hash, never plaintext) so a re-pointed `$MCP_BIN` re-triggers trust. Today change-detection compares only the unresolved literal (see the §3.3 limitation note).
- **Per-tool MCP policy rules** — an operator policy section that can `confirm`/`deny`/`lock` a specific `mcp__<server>__<tool>` pattern. In this version trust is all-or-nothing at the server level and no `mcp` policy section is consulted.
- **MCP tools inside subagents** — v1 MCP tools are parent-session-scoped; subagent access goes through the parent↔child IPC seam in a later slice.
- **Model-in-the-loop eval** — a case where the model itself picks an MCP tool. The real-subprocess integration test is the CI signal in the meantime.
