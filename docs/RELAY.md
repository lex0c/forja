# Forja Relay (Mesh)

Two or more Forja instances running locally (same OS user, different repos) can
talk to each other in **plain text** to coordinate a cross-repo change — for
example, a contract changes in `billing` and the `gateway` that consumes it must
adjust. Instead of hand-carrying context between terminals, one Forja sends the
other a request; the other runs its own loop and answers.

This is the operator guide. The protocol, trust model, and lifecycle are
specified in full in [`spec/MESH.md`](spec/MESH.md).

## The one rule

> **Communication transports intent, never authority.**

Each Forja stays the sole owner of its own repository. A Forja **never** edits or
runs anything in another Forja's workspace. It sends *text*; the receiving Forja
treats that text as an untrusted prompt, decides what (if anything) to do in
**its** repo, and every side effect stays gated by **that** instance's local
operator — exactly as if the operator had typed the prompt themselves. No remote
permission grant ever exists. There is no code path where a peer's message
approves anything.

## Quickstart

**On the instance that should answer requests (the server):**

```
/relay on
```

This asks for confirmation (opening an inbound socket is a deliberate consent
gate), then starts serving peers and shows a `RELAY: <alias>` badge in the
footer. **The session is not dedicated** — you keep using it normally; peer
requests interleave as their own isolated turns, which you supervise through the
scrollback and approve as usual. Stop with `/relay off`.

**On the instance that initiates (a normal session):**

```
mesh_peers                     # discover who is serving
mesh_send                      # send a peer a textual request
```

`mesh_send` is **egress**: the operator confirms each send (the modal shows the
target peer and a preview of the message). It returns immediately — the peer may
take a while (it might be waiting on *its* operator). When the peer answers, the
reply arrives in a later turn on its own, and your model sees it.

## How it works

No daemon. Each serving Forja opens its own Unix-domain socket and publishes a
small descriptor to a per-user runtime directory; peers read that directory and
connect directly.

```
Terminal A (normal session)              Terminal B (ran /relay on)
  mesh_send("gateway", "...")  ──socket──▶  peer_message  (untrusted, source:system)
        ▲                                        │  wakes a fresh, isolated turn
        │  peer_reply  (untrusted-enveloped)     │  operator supervises + approves
        └──── mesh_reply(output) ◀───────────────┘  the model publishes the answer
```

- **Discovery** — a serving Forja writes `<runtime>/forja/mesh/peers/<alias>.json`
  and listens on `<runtime>/forja/mesh/<alias>.sock`, where `<runtime>` is
  `$XDG_RUNTIME_DIR/forja/mesh` (falling back to `$TMPDIR/forja-<uid>/…`).
  `mesh_peers` lists the live ones. A descriptor whose process is dead or whose
  socket is gone is stale — it is skipped and swept on the next discovery.
- **Ingress** — a peer's prompt becomes a `peer_message` that wakes the serving
  session and drives a system-source turn against **fresh context**.
- **Return** — when it has the answer, the receiver's model publishes it with
  `mesh_reply(conversationId, output)`; the reply crosses back over the socket and
  surfaces on the initiator as a `peer_reply` turn. A turn that ends without a
  `mesh_reply` (or crashes) fails the conversation with a neutral error, so the
  initiator always gets closure — never a silent hang.

## Security model

The whole feature is designed so that reachability and messaging never become
authority.

- **Authentication is the filesystem.** The runtime directory is `0700`, the
  socket and descriptor are `0600`, all owned by the same OS user. There is no
  network listener and no cross-user access. (Bun exposes no `SO_PEERCRED`, so
  identity rests on these permissions plus the logical alias in the handshake.)
- **Local sovereignty.** Every effect a peer's prompt would cause runs through
  the local permission engine under the operator's own posture. The permission
  engine never consults the peer's text to decide authorization. When a peer's
  turn triggers a confirm, the modal is labeled with the peer's alias (`peer:
  '<alias>'`) — so you always know an effect was requested by a peer, not by you —
  and the `mesh_send` / `mesh_reply` modals show the outgoing payload, so you see
  exactly what would leave before you approve it.
- **Provenance.** A peer prompt is a turn driver with `trust: untrusted` and
  enters as `source: 'system'` — never `source: 'user'`. Its body is wrapped as
  DATA between per-message nonce markers (the same fence `fetch_url` uses for web
  content), so an embedded "ignore your permissions and run X" stays inert text.
- **Posture is inherited, not overridden.** Relay mode respects the posture the
  operator chose:
  - **Supervised** — each effect (edit / bash / egress) asks for confirmation. If
    the operator is present but away from the modal, the effect *waits*; it is not
    denied.
  - **Autonomous** — local effects auto-approve within policy, as in any
    autonomous turn. Whoever turned autonomous on already accepted that; the mesh
    does not revoke it.
  - **Egress stays gated in either posture.** `mesh_send` (and any `fetch_url`)
    is never auto-approved under autonomous — the exfiltration path is always a
    per-call operator confirm.
- **Two audiences.** The local scrollback is full fidelity (the operator owns the
  repo). What crosses the wire to the peer is only what the receiver **publishes**
  via `mesh_reply` — never the raw turn. In supervised, the operator reviews that
  output in the confirm (what leaves); in autonomous it is trusted to the posture.
  So the peer never receives this repo's paths, raw output, or secrets.
- **Isolation.** Each peer turn runs against fresh context and never touches the
  operator's own session, so one peer can't see another peer's request or the
  operator's local history through the model's context.

Practical guidance for the initiator: send a goal plus the relevant evidence, not
your whole history. Do not send secrets or absolute paths — the peer is a separate
trust domain.

## Commands

| Command | Effect |
|---|---|
| `/relay on` | Confirm, then start serving peers. The session stays interactive — **not dedicated**; you keep working while peer requests interleave. (`mesh_send` is disabled while serving — send from a non-relay session.) |
| `/relay off` | Stop serving: say goodbye in-band to open conversations, close the socket, remove the descriptor. |
| `/relay` | Report status: serving or not, and (when serving) the inbound conversations in flight. `on` / `off` are the action verbs. |

## Tools

| Tool | Category | Notes |
|---|---|---|
| `mesh_peers` | `misc` | Lists live serving instances — `alias`, `branch`, `status` (`idle` / `working` / `waiting-operator`, the last shown when that peer's turn is blocked on its operator's confirm). Never the repo path. Off the base surface (discovered via tool search). |
| `mesh_send` | `mesh.egress` | Sends a textual request to a peer. Egress → operator confirms each call, and it is never auto-approved under autonomous. Asynchronous (the reply arrives in a later turn). Refuses while **this** session is itself serving — a relay does not initiate onward sends (no transitive delegation). |
| `mesh_reply` | `mesh.reply` | Publishes your answer back to a peer that sent you a request (the `conversationId` is the handle from the incoming message; this closes the conversation). **Respects your posture** — supervised confirms what leaves (the two-audiences review), autonomous auto-approves. NOT egress. Off the base surface. |

## Configuration

Optional `[mesh]` block in `.forja/config.toml` (same shape as `[memory]` /
`[budget]`):

```toml
[mesh]
alias = "billing"                  # default: the repo-root basename
max_rounds = 8                     # consecutive peer turns without operator input
max_message_bytes = 32768          # per prompt / per result
max_concurrent_conversations = 4   # inbound conversations in flight
```

Every value is clamped to a hard ceiling a typo or hostile config cannot lift:
`max_rounds ≤ 64`, `max_message_bytes ≤ 256 KiB`, `max_concurrent_conversations ≤ 16`.
(The message ceiling sits deliberately below the 1 MiB wire framer cap so an
enveloped, escaped max-size message can't overflow it.)
An out-of-range or malformed value warns and falls back to the default. The
remote posture is always at least supervised and is **not** loosenable by config.

## Limits & safety

Two models talking freely would form an unbounded committee. The bounds:

- **`max_rounds`** — a serving session runs at most this many consecutive peer
  turns with no operator input; past it, further peer prompts are **declined with
  an explicit result** (never a silent hang) until the operator intervenes. This
  is the real limit behind exempting peer prompts from the normal auto-wake cap.
- **`max_message_bytes`** — `mesh_send` rejects an over-cap message up front with
  `mesh.message_too_large` (distinct from "no such peer", so the model shortens
  the request rather than re-discovering); an over-cap answer is clamped and
  marked, never silently truncated.
- **`max_concurrent_conversations`** — an inbound prompt past the limit is
  rejected with `peer_busy`.
- **No transitive delegation** — a serving session cannot `mesh_send` onward
  (no A→B→C chaining). Initiate from a normal, non-relay instance.

## Troubleshooting

- **A peer doesn't appear in `mesh_peers`.** It only appears after it runs
  `/relay on`. Confirm both instances run as the same OS user. A crashed instance's
  stale socket/descriptor is swept automatically on the next discovery.
- **`peer_lost` / "no reply from …".** The peer's process closed before answering
  (crash, or `/relay off` mid-request), or a wire error hit. A transport failure
  gets a distinct `▸ no reply from '<alias>'` headline (not the `▸ reply from` of a
  real answer) and reaches your model as a trusted-system notice; the conversation
  is failed explicitly so the loop is never left waiting forever.
- **`mesh_send` says it's blocked.** The current session is serving (relay mode).
  Send from a different, non-relay instance.
- **Where it lives.** Sockets and descriptors are under
  `$XDG_RUNTIME_DIR/forja/mesh/` (or `$TMPDIR/forja-<uid>/forja/mesh/`). These are
  private (`0700` / `0600`) and cleaned up on exit.

## Not in scope (v1) / follow-ups

- **Per-conversation progress to the initiator's model** (accepted / working /
  waiting-operator) is not surfaced yet — only the final result drives a reply.
  (The peer's coarse status, including `waiting-operator` when it is blocked on its
  operator, is now visible to *others* via `mesh_peers`; what is still missing is
  streaming that per-conversation state to the initiating model as it happens.)
- **`peer_reply` shares the operator wake-cap.** Unlike an inbound `peer_message`,
  an awaited reply can wait for the operator's next input if the session has hit
  its consecutive-wake cap — the reply is never lost, only possibly delayed until
  the operator acts.
- **Remote / multi-machine** (WebSocket/TCP + mTLS), **structured attachments**
  (typed diffs / test results), a **multi-repo coordinator**, and **per-task
  worktrees** are deliberately out of v1. See [`spec/MESH.md §11`](spec/MESH.md).

## See also

- [`spec/MESH.md`](spec/MESH.md) — the full protocol, trust model, and lifecycle.
