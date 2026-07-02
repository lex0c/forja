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
             mcp_servers          = per-server STATE, keyed (scope, name) — scoped per project
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
| `url` | sse/http | The endpoint URL — must be `http(s)`. Its **unresolved** form (any `$VAR` left as-is) is the trust identity: persisted + shown in the modal (a change re-triggers trust), so a `?token=$VAR` never lands at rest as the resolved value — only the live connection uses the resolved URL. **No embedded credentials** (`user:pass@…`) — a URL with userinfo is rejected; put a bearer token in `auth`. |
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

`$DATABASE_URL` resolves from the environment at load time; the **unresolved** form (`--dsn $DATABASE_URL`) is what gets persisted and shown in the trust modal, so the secret never lands at rest. For the remote `github` server, the trust identity is its **unresolved** `url` (a `$VAR` stays unexpanded at rest — like the stdio unresolved argv — so a query/path token never persists), and `$GITHUB_MCP_TOKEN` is read at load and sent as a `Bearer` header — only the variable *name* is in config.

---

## 3. Trust

Trusting an MCP server authorizes **two** things: reaching it — spawning a stdio server's `command` (arbitrary local code) or connecting to a remote server's `url` (network egress) — and exposing its declared tools to the model. Trust is keyed on a **manifest hash**.

### 3.1 The manifest hash

`manifest_hash = sha256(canonical_json(...))` over the server's reported `serverInfo` (`{ name, version }`) **and** each tool's `name`, `description`, `inputSchema`, `meta` (the `_meta.agentic_cli` hints). Covering `meta` is the core integrity property: a trusted server cannot silently downgrade a tool's declared `category` or flip `writes` after the fact — any such change re-hashes and re-prompts. The `serverInfo.name` is the server's **own** reported name (from `initialize`), not your config alias — so a replaced server at the same command/URL that re-brands itself, even while keeping identical tools + version, re-triggers trust. The MCP `protocolVersion` is deliberately **not** hashed (it's transport noise, not capability).

### 3.2 First-visit vs drift

- **first-visit** — a server whose manifest hash has never been granted.
- **drift** — a previously-trusted server whose hash changed (its tools or its command). Re-authorization is required; until then the server is held `degraded` and its old tool set stays pinned.

### 3.3 Interactive: the trust modal

When a TTY operator is present, trusting an unknown/changed server is a **two-step** gate (the same warn-toned "stop and read" family as cwd-trust and shared-memory trust) — so nothing runs or connects before you approve:

1. **Identity gate (before connecting).** Forja shows the **server name**, the **command / URL** being authorized (the headline — the binary it is about to run, shown from the unresolved argv **plus the server's `env` bindings and an explicit `cwd` when set**, so no secret leaks yet the full spawn surface is visible, or the endpoint it is about to reach with any configured auth), and the **sandbox posture**. The tool inventory is *not* shown — the tools aren't fetched yet, and fetching them is the very spawn/connection this gate authorizes. Decline and **nothing is run and no token is sent**.
2. **Manifest review (after connecting).** Once the identity is authorized, Forja connects, fetches the manifest, and raises the manifest-trust modal: the **tool inventory** (name + description + `[writes]` markers, capped at 8 with an overflow line) and the **manifest hash** — where you review what the server exposes. A `--auto-approve-mcp` server clears both steps without a prompt; headless without it is fail-closed.

Every string in the modal is sanitized at the render boundary (a hostile manifest can't repaint the terminal). The **conservative default is "No, do not run it"** — hitting Enter without reading declines. Esc / timeout / cancel all resolve to deny. Tools the server declares as writing are marked `[writes]` in the inventory so the operator can see which ones carry side effects.

> **Limitation — `$VAR` in a command is trust over the *literal*.** Both the modal and the command-change re-trust use the **unresolved** argv. If a command contains a variable (e.g. `command = ["$MCP_BIN"]`), re-pointing that variable in the environment swaps the real binary **without** re-triggering trust, and the modal only ever shows the literal `$MCP_BIN`. Trusting such a server means trusting whatever the operator's environment resolves it to. Hashing the *resolved* command for change-detection is a deferred follow-up (§8); until then, prefer a literal executable for servers you don't fully control and keep `$VAR` for arguments/secrets, not the binary itself.

> **Stdio trust is *per working-directory*.** A stdio server's effective `cwd` (its configured `cwd`, else the directory forja was launched from) is folded into the trust identity, because that directory is load-bearing twice: it is the base every relative `argv[0]`/script resolves against (`command = ["node", "./server.js"]` runs a *different* script from a different directory) **and** it is the sandbox's writable root (`cwd-rw` makes only the cwd writable). So **any** `cwd` change — even for an absolute or PATH-binary `argv[0]` — moves what runs or what the server can write, and re-triggers the trust prompt rather than riding the cached grant. The argv itself stays unresolved in the identity (so the `$VAR`-binary limitation above still applies to the *executable*). To avoid a re-prompt each time you launch forja from a new directory, pin the server's `cwd` in its config.

> **Credential bindings are part of the identity.** The trust identity also folds in a server's **unresolved** credential bindings — a stdio `env` table (e.g. `SECRET = "$SECRET"`) and a remote `auth`'s env-var **name**. Adding or re-pointing a binding re-triggers trust before the next spawn/connection hands the newly-resolved secret to a previously-approved command or endpoint. Only the `$VAR` literal / the env-var name enters the identity — never the resolved token. The trust modal **shows** these `env` bindings (and an explicit `cwd`) next to the argv, so the operator sees the full spawn surface — an `env` like `LD_PRELOAD` / `NODE_OPTIONS` injects code into the spawned process (surviving even the sandbox `--clearenv`) and is as load-bearing as the binary itself. (As with `$VAR` in a command, changing what the *same* `$SECRET` resolves to in your environment is trust over the literal binding and does not re-prompt.)

> **Containment posture is part of the identity.** A stdio server's declared **sandbox opt-out** (`sandbox = false`) and its **network grant** (a non-empty `network.allow_hosts`) are folded into the trust identity as well. Flipping `sandbox = false`, or adding a network allowlist, on an already-trusted server — e.g. through a gitignored `.forja/mcp.local.toml` — **re-triggers trust** instead of silently reusing the cached grant to spawn the server with reduced containment. The **declared** intent is folded (not the resolved profile), so moving between a machine with and without a sandbox tool doesn't spuriously re-prompt.

> **An env-expanded remote URL is trust *per resolved origin*.** A remote `url` may itself be a `$VAR` (`url = "$MCP_URL"`), so the raw form alone can't detect a re-point. The identity therefore also folds in the **resolved origin** (`scheme://host:port`) — a non-secret value: a `$VAR` token expands into the path/query (never the authority), and embedded credentials (`user:pass@`) are rejected at parse. Re-pointing `$MCP_URL` to a **different origin** re-triggers trust before the configured bearer is sent to the new endpoint; a token that rotates *within the same origin* (a `?token=$VAR` in the query) does not re-prompt (the origin + raw form are unchanged, and the token never entered the identity). The trust modal **shows that resolved origin** next to the raw form (`$MCP_URL → https://actual-host`) when the raw URL hides it, so you can verify which host will receive the connection + bearer before approving — with the path/query (where a `$VAR` secret lives) stripped.

### 3.4 Headless: fail-closed

With no interactive confirmer (one-shot `run`, evals, CI), a server is **denied unless explicitly allowed** via:

```
forja --auto-approve-mcp <comma-separated-server-names>
```

The flag lists servers by name; it rejects an empty list and rejects `*` (no blanket auto-approve — `ANTI_PATTERNS §6.6`). A denied server is never spawned and its tools never register.

`--auto-approve-mcp` clears **trust**, but it does not override the **per-call** permission decision. A **sandboxed** stdio server's tools are the `mcp` category (auto-allowed), so they run headless. But a server that is **unsandboxed** (`sandbox = false`, or no sandbox tool available) or **remote** produces `mcp.egress` tools — `confirm` by default, which headless resolves to **deny** (egress never auto-approves). To call such a tool headless, pre-authorize it in policy with a `[tools.mcp]` `allow` rule for its `mcp__<server>__<tool>` name.

A **refusing** permission boot (a broken audit chain without `--accept-broken-chain`, or a required-but-unavailable sandbox) skips MCP init entirely: no server is loaded, connected, or spawned — not even an `--auto-approve-mcp` one — since that boot is meant to run nothing at all. This holds in interactive runs too, not just headless.

### 3.5 History

Every decision (`granted` / `denied` / `revoked` / `superseded`) appends to `mcp_manifest_history`, which is **append-only and never pruned**. A re-**seen** server whose identity row is still present (a restart, a `disabled` toggle) with a matching command + hash re-uses its cached grant with no fresh prompt. A server **removed from config and re-added** — its identity row swept — re-trusts through the pre-connect identity gate: the grant is not inherited by name, so a re-added entry pointing at a different command/URL can't ride the old trust.

The `(scope, server, hash)` triple holds **one** decision row (it is unique). If you **decline** a manifest and later approve the *same* manifest (via `/mcp reconnect` or `--auto-approve-mcp`), that row flips `denied → granted` in place, so the approval is durable across the next boot rather than being re-prompted every time. When a **changed identity** (a swapped command or re-pointed URL) re-prompts but the server still reports the *same* manifest hash, the row's `decided_at` / `decided_by` are refreshed on re-approval even though the decision value is unchanged — so `/mcp show` and the history record who approved the **new** identity, not the stale original grant.

The orphan sweep that removes an `mcp_servers` row when its server leaves config is **skipped for any scope whose config layer failed to load** (a malformed `mcp.toml` / `mcp.local.toml` / user file, or a skipped entry). A temporary typo therefore never erases a still-configured server's cached trust + counters: the row lingers until the config parses cleanly again.

---

## 4. How an MCP tool appears to the model

### 4.1 Naming

A manifest tool `t` from server `s` registers as **`mcp__<s>__<sanitize(t)>`** (double underscore). The double-underscore wire form is required because tool names must match `^[a-zA-Z0-9_-]{1,64}$` (provider constraint) and colons collide with the `<kind>:<scope>` capability grammar and the `Bash(...)` rule grammar. Tool-half names are sanitized and de-duplicated so registration never throws on a hostile manifest (long names, illegal chars, two tools colliding).

**Untrusted output is size-bounded at the SDK boundary.** A hostile or wedged server can't OOM the process or blow the model context: a `tools/list` manifest is capped at **256 tools** with per-field limits (tool name, description, `inputSchema` serialized size — an oversized schema degrades to `{type:'object'}`), so the hash/register/`manifest_json` step can't be flooded; and a single `tools/call` text result is capped at **1 MiB** (truncated with a marker) before it is forwarded to the model or retained in history. These bound what Forja forwards, hashes, persists, and registers — the transient SDK-side parse of the raw JSON-RPC frame is the SDK's own concern.

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

A plain stdio server's `mcp` category is **not** egress (a local subprocess). But a server **granted network** (`[servers.<name>.network]`, §7) — and every remote (sse/http) server — uses the **`mcp.egress`** category instead: it defaults to **confirm** and is never auto-approved under the autonomous posture — once a server can reach the network, its tools can exfil, so each call is seen.

On top of the per-server manifest trust, a **`[tools.mcp]` policy section** gives per-tool control: `allow` / `confirm` / `deny` (+ `locked`) lists of `mcp__<server>__<tool>` glob patterns (same matcher as `tools.bash` — no regex). Precedence is **deny > allow > confirm**, then the category default (`mcp` → allow, `mcp.egress` → confirm). An explicit `allow` precedes the egress default, so it opts a specific egress tool out of its confirm — the operator pre-authorized that exact tool (mirroring `fetch_url`'s `allow_hosts`); the "egress never auto-approves" rule still governs everything the operator didn't list. So you can trust a many-tool server's manifest yet still `deny mcp__github__delete_*` or pre-`allow` one egress tool, without disabling the whole server.

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

**Connections are lazy.** `init()` performs the handshake needed to obtain + hash the manifest and resolve trust, then registers the tools and drops the connection. The server is re-spawned on the **first `tools/call`**, and the handshake at both points is **timeout-bounded (30s) around the *entire* connect** — transport start included, not just the `initialize` request — so a remote server that opens the stream but never completes the handshake (an SSE server that withholds its `endpoint` event) can't hang startup or the first tool call. `cleanup()` (run at every teardown site — REPL shutdown, one-shot `run`, and per-eval-case) disconnects every child.

---

## 6. Storage + audit

Two tables (migrations `081-mcp-servers.ts` / `083-mcp-servers-scoped.ts`, repo `repos/mcp-servers.ts`):

- **Rows are keyed by `(scope, name)`, not by name alone.** `sessions.db` is user-global but project MCP config is per-repo, so the same `<name>` (`db`, `postgres`) in different repos would otherwise collide on one row — approving one repo's server would overwrite the other's identity + cached trust, and the other would re-prompt / fail closed on its next run despite a prior approval. `scope` = the **project root** for `project_shared` / `project_local` servers, `''` (global) for `user` servers (shared across repos on purpose).
- **`mcp_servers`** — per-server STATE: transport, the redacted command, source layer, current state + manifest hash, counters. Mutable state, so a row is **swept when its `(scope, name)` leaves config**: `manager.init()` deletes any row — within THIS invocation's scopes (the current repo + the global `''`) — whose name is in neither the enabled nor disabled config set (toggling `disabled` keeps the row). Rows in **another repo's scope** are never even looked at, so their cached trust is untouched. Revoked rows always survive (the revocation must outlast a config round-trip).
- **`mcp_manifest_history`** — every trust decision, **append-only forever**. It is deliberately absent from `GC_TABLES`, so `forja gc` never prunes it; the forever-retention holds by construction. The server's history survives even after its `mcp_servers` row is swept — but the manager will **not** reuse a grant by name once the identity row is gone: the row is what records the command/URL a grant authorized, so a re-added server re-trusts through the identity gate rather than silently inheriting the grant.

---

## 7. Operating notes

- **Warnings** from config parsing and trust surface on the startup banner under the `mcp:` prefix. Each names the **file** it came from (`.forja/mcp.local.toml [servers.x]`, not an internal layer enum) and echoes the offending value; an **unrecognized key** (a typo'd `disable`/`sanbox`, or a key that belongs to the other transport) is flagged rather than silently dropped, since TOML has no schema. A headless run that fails a server closed for lack of an interactive prompt **says so** and names `--auto-approve-mcp` (it isn't a silent missing tool).
- **Managing servers in-session:** `/mcp` lists every server (a labeled `SERVER / STATE / TOOLS / SOURCE` table) with its live state + tool count, and — when any server is denied/degraded — a footer pointing at `/mcp reconnect`;
  `/mcp show <server>` **leads with the last error** (glossed from its bare code, with the recovery lever) when there is one, then the command / endpoint URL, manifest hash, and trust history; `/mcp revoke <server>`
  denies a server and removes its tools (durable — it stays denied across a relaunch until you
  reconnect); `/mcp reconnect <server>` re-runs the trust handshake — on success it re-registers the
  tools + clears any revocation (no restart needed); a **declined or failed** reconnect leaves the
  server revoked across relaunch (a server you just re-declined never silently returns from its cached
  grant) and **surfaces the underlying fault** (the handshake error) plus a `/mcp logs` pointer for an unreachable one; `/mcp logs <server>` tails the server's captured stderr. The mutating commands
  run **between turns** (they hot-swap the live tool set).
- **Tool-call errors carry an accurate `retryable`.** A pinned manifest drift, an exhausted per-session budget, or a terminal (denied/error) state is **not retryable** — the model is told to stop rather than burn turns re-calling something that throws identically until `/mcp reconnect`; a per-call timeout and a transport fault (`mcp.server_unreachable`, framed with the server name, not a raw SDK string) stay retryable.
- **Server stderr** is captured to `<dataDir>/traces/mcp-<name>.log` (operator-only, lazily created
  on the first byte, rotated at 10 MB with one kept generation). It is *always drained* even when no
  trace dir is configured — an unread pipe would otherwise block the server on its next stderr write.
  `/mcp logs` **sanitizes** each tailed line (strips ANSI + control bytes) before rendering, so a hostile
  server can't repaint the terminal or forge UI text through its stderr when you inspect it. `/mcp show`
  applies the same anti-spoof to the fields that originate outside the harness — the persisted command / URL
  (from a repo's `mcp.toml`) and the server-reported protocol / version / last error.
- **Sandbox.** When a sandbox tool (Linux `bwrap`, macOS `sandbox-exec`) is present, every stdio server is confined **by default** — host filesystem read-only, the cwd read-write, no network — unless you set `sandbox = false` or grant `network`. The trust modal shows the effective posture; a server that can't be sandboxed (no tool, or your opt-out) is flagged **UNSANDBOXED**. If a tool was present at boot and later vanishes, the server fails closed rather than running exposed. bwrap network is all-or-nothing — `allow_hosts` is advisory, not kernel-enforced (§8), and a network-granted server's tools are treated as egress (always confirmed).
- **Secrets** belong in the environment + the gitignored `mcp.local.toml`. The persisted command and the trust modal both use the unresolved argv, so a `$VAR` secret is never written to the DB or shown on screen.
- **End-to-end proof.** The whole stack is exercised over real transports in CI without needing a model: `tests/mcp/real-subprocess.test.ts` drives the SDK **stdio** adapter against a real stdio server (`evals/mcp/fixtures/echo-server.ts`) — happy path, headless fail-closed, cached-grant; `tests/mcp/remote-real-server.test.ts` drives the **remote (streamable-HTTP)** adapter against a real SDK HTTP server, proving the env-bearer reaches the wire and a missing bearer 401s → connect fails. `bun run eval:smoke:mcp` additionally proves the SDK runs inside the compiled `dist/forja` binary. **Model-in-the-loop:** `evals/mcp/*.yaml` (`bun run eval:mcp`) run a real model against a fake, auto-approved MCP server (`setup.mcp` injects a stub client) to measure whether the model discovers + calls an MCP tool and uses its result.

---

## 8. Not in this version (deferred)

These are specified but intentionally out of the first MCP release; each is its own slice when its ecosystem need is real:

- **Remote OAuth — not planned.** The MCP auth model is env-bearer (§2.1), which covers the common case (a PAT / token in an env var, sent as `Authorization: Bearer …`). The SDK exposes an interactive `authProvider` flow (discovery + dynamic client registration + the authorization-code redirect), but adopting it would add a refresh-token + client-registration **credential-at-rest** surface the project deliberately avoids, plus a loopback-callback browser dance not worth it for a CLI where the operator can supply a token directly. Revisit only for a server that is OAuth-only.
- **Remote heartbeat health** — proactive staleness detection for a remote (sse/http) connection (`heartbeat_max_age_ms`, spec §2.2/§5). Today a dead idle remote is discovered lazily on the next `tools/call` (which degrades + surfaces the fault), not by a background liveness probe.
- **Per-host network filtering + ulimits** — the sandbox (§7) confines the filesystem and toggles network on/off, but bwrap network is all-or-nothing: the `allow_hosts` list is advisory, not kernel-enforced (per-host filtering via proxy/nftables is future), and the CPU/memory/file ulimits in the spec are not yet applied. Treat a network-granted server's reach as "the whole network".
- **Resolved-command change-detection** — hashing the `$VAR`-resolved argv (persisted as a hash, never plaintext) so a re-pointed `$MCP_BIN` re-triggers trust. Today change-detection compares only the unresolved literal (see the §3.3 limitation note).
- **MCP tools inside subagents** — v1 MCP tools are parent-session-scoped; subagent access goes through the parent↔child IPC seam in a later slice.
