# Forja Relay (Mesh)

Two or more Forja instances running locally (same OS user, different repos) can
talk to each other in **plain text** to coordinate a cross-repo change — for
example, a contract changes in `billing` and the `gateway` that consumes it must
adjust. Instead of hand-carrying context between terminals, the two Forjas
exchange messages: either can ask, answer, or follow up, and each side's model
replies when it decides.

This is the operator guide. The protocol, trust model, and lifecycle are
specified in full in [`spec/MESH.md`](spec/MESH.md).

## The one rule

> **Communication transports intent, never authority.**

Each Forja stays the sole owner of its own repository. A Forja **never** edits or
runs anything in another Forja's workspace. It sends *text*; the receiving Forja
treats that text as an untrusted message, decides what (if anything) to do in
**its** repo, and every side effect stays gated by **that** instance's local
operator — exactly as if the operator had typed the message themselves. No remote
permission grant ever exists. There is no code path where a peer's message
approves anything.

## Quickstart

**On both instances that should talk (a two-way exchange needs both serving):**

```
/relay on
```

This asks for confirmation (opening an inbound socket is a deliberate consent
gate), then starts serving peers and shows a `relay on` signal in the footer
(alongside the reminders / bash bg / subagents chips). **The session is not
dedicated** — you keep using it normally; peer
messages interleave as their own turns *in your own session*, which you supervise
through the scrollback and approve as usual. Stop with `/relay off`.

**To reach a peer (from either instance):**

```
mesh_peers                     # discover who is serving
mesh_send                      # send a peer a textual message
```

`mesh_send` **respects your posture** (like any local effect): in supervised, the
operator confirms each send — the modal shows the target peer and a preview of the
message (the two-audiences review of what leaves); in autonomous, sends auto-approve
(the mesh is a same-user *local* socket, not network egress, so autonomous covers it —
trading the modal review for the same delegation as any local effect, though the send's
tool card still shows an excerpt of what left). It returns immediately — fire-and-forget. The peer answers with its own `mesh_send`
back to you in a later message (or reports it couldn't); the exchange is free, not a
strict request/reply. `mesh_send` works **even while you are serving** — a reply is
just a message in the other direction.

## How it works

No daemon. Each serving Forja opens its own Unix-domain socket and publishes a
small descriptor to a per-user runtime directory; peers read that directory and
connect directly. A message is one short connection — connect, hello, message,
close — and a reply is a **new** connection the other way, which is why both sides
serve.

```
Terminal A (ran /relay on)               Terminal B (ran /relay on)
  mesh_send("gateway", "…")   ──socket──▶  peer_message  (untrusted, source:system)
        ▲                                        │  wakes a turn in B's own session
        │  peer_message                          │  operator supervises + approves
        └──── mesh_send("billing", "…") ◀────────┘  the model replies when it decides
```

- **Discovery** — a serving Forja writes `<runtime>/forja/mesh/peers/<alias>.json`
  and listens on `<runtime>/forja/mesh/<alias>.sock`, where `<runtime>` is
  `$XDG_RUNTIME_DIR/forja/mesh` (falling back to `$TMPDIR/forja-<uid>/…`).
  `mesh_peers` lists the live ones. A descriptor whose process is dead or whose
  socket is gone is stale — it is skipped and swept on the next discovery.
- **Ingress** — a peer's message becomes a `peer_message` that wakes the serving
  session and drives a system-source turn in the **operator's own shared session**
  (not an isolated context). The operator sees it, can intervene, and helps shape
  the reply.
- **Reply** — to respond, the receiver's model calls `mesh_send` back to the
  peer's alias — this turn or a later one; the message stays in the shared session,
  so a turn that ends without replying is fine (the model can answer later, or
  consolidate several messages into one reply). If the peer is gone when you send,
  `mesh_send` fails immediately with `peer_lost` — never a silent hang.
- **Reply safety net** — a plain text answer only reaches *your* scrollback; only a
  `mesh_send` reaches the peer. So when a peer-driven turn ends without a send back to
  that peer, Forja fires a **one-shot `[reply pending]` reminder** turn (the model then
  answers, or decides no reply is warranted — a thanks / goodbye needs none), and a
  passive **`N awaiting reply`** chip shows in the footer until the debt clears. It is a
  nudge, never an auto-send: the model still composes and sends the reply itself, so the
  two-audiences boundary holds. A rapid second message from the same peer keeps its own
  debt — replying to the first does not silence the reminder for the second.

## Security model

The whole feature is designed so that reachability and messaging never become
authority.

- **Authentication is the filesystem.** The runtime directory is `0700`, the
  socket and descriptor are `0600`, all owned by the same OS user. There is no
  network listener and no cross-user access. (Bun exposes no `SO_PEERCRED`, so
  identity rests on these permissions plus the logical alias in the handshake.)
- **Local sovereignty.** Every effect a peer's message would cause runs through
  the local permission engine under the operator's own posture. The permission
  engine never consults the peer's text to decide authorization. When a peer's
  turn triggers a confirm, the modal is labeled with the peer's alias (`peer:
  '<alias>'`) — so you always know an effect was requested by a peer, not by you —
  and the `mesh_send` modal shows the outgoing payload, so you see exactly what
  would leave before you approve it.
- **Provenance.** A peer message is a turn driver with `trust: untrusted` and
  enters as `source: 'system'` — never `source: 'user'`. Its body is wrapped as
  DATA between per-message nonce markers (the same fence `fetch_url` uses for web
  content), so an embedded "ignore your permissions and run X" stays inert text.
- **Posture is inherited, not overridden.** Relay mode respects the posture the
  operator chose:
  - **Supervised** — each effect (edit / bash / mesh_send) asks for confirmation.
    If the operator is present but away from the modal, the effect *waits*; it is
    not denied.
  - **Autonomous** — local effects (including mesh_send) auto-approve within
    policy, as in any autonomous turn. Whoever turned autonomous on already
    accepted that; the mesh does not revoke it.
  - **Network egress stays gated in either posture.** `fetch_url` (and network MCP
    tools) are never auto-approved under autonomous — reaching an arbitrary host is
    the exfiltration path the operator always sees. `mesh_send` is NOT network egress
    (a same-user local socket), so it respects posture: supervised confirms + shows
    the payload; autonomous auto-approves.
- **Two audiences.** The local scrollback is full fidelity (the operator owns the
  repo). What crosses the wire to the peer is only what the model **sends** via
  `mesh_send` — never the raw turn. In supervised, the operator reviews that text in
  the confirm modal before it leaves; in autonomous there is no modal, but the send's
  tool card shows an excerpt of the outbound payload, so what left stays visible in
  the scrollback either way. So the peer never receives this repo's paths, raw
  output, or secrets by accident.
- **No isolation — the operator's presence is the safeguard.** A peer turn runs in
  the operator's own session (not a sealed context), which is what lets the operator
  collaborate on the reply and lets the model answer in a later turn. The trade-off
  is explicit: the untrusted message is processed in the operator's context, so
  **every `mesh_send` is the boundary of what leaves**, and the operator is always
  present to see it (supervised confirms; autonomous is visible in scrollback).

Practical guidance for the sender: send a goal plus the relevant evidence, not
your whole history. Do not send secrets or absolute paths — the peer is a separate
trust domain.

## Commands

| Command | Effect |
|---|---|
| `/relay on` | Confirm (you typed the command, so the modal defaults to Yes — Enter starts serving; `2` / Esc cancels), then start serving peers. The session stays interactive — **not dedicated**; you keep working while peer messages interleave. `mesh_send` stays available (the exchange is symmetric). |
| `/relay off` | Stop serving: close the socket, remove the descriptor. |
| `/relay` | Report status: serving or not, the serving alias, and the reachable peers (alias + coarse status). `mesh_peers` is a model tool, so this is your window into who's out there. `on` / `off` are the action verbs. |

## Tools

| Tool | Category | Notes |
|---|---|---|
| `mesh_peers` | `misc` | Lists live serving instances — `alias`, `branch`, `status` (`idle` / `working` / `waiting-operator`). Status is **advisory, not a gate** — a message queues and is delivered regardless of it. Never the repo path. Off the base surface (discovered via tool search). |
| `mesh_send` | `mesh.egress` | Sends a textual message to a peer — a request, a reply, or a follow-up. **Respects posture** (§5.3): supervised confirms each call showing the payload; autonomous auto-approves (a same-user local socket, not network egress). Fire-and-forget (the reply arrives later as its own `peer_message`). Available while serving — the exchange is symmetric; authority is the local operator's per send, never transitive. |

## Configuration

Optional `[mesh]` block in `.forja/config.toml` (same shape as `[memory]` /
`[budget]`):

```toml
[mesh]
alias = "billing"                  # default: the repo-root basename
max_message_bytes = 32768          # per message
```

`max_message_bytes` is clamped to a hard ceiling a typo or hostile config cannot
lift: `max_message_bytes ≤ 128 KiB`. (The message ceiling sits well below the 1 MiB
wire framer cap: on the wire the text is a JSON-string-escaped field, and a control
byte expands 6× — so the raw cap must stay under cap/6, or an escape-heavy max-size
message would overflow the framer and be silently dropped.) An out-of-range or
malformed value warns and falls back to the default. The remote posture is always at
least supervised and is **not** loosenable by config.

## Limits & safety

Two models talking freely would form an unbounded committee. Instead of a
mesh-specific limit, the exchange is bounded by the session's own caps:

- **The wake-cap.** A peer message respects the same consecutive-auto-wake cap as
  any wake (no exemption): the exchange flows while the operator engages (their
  input resets the cap) and **pauses** after N auto-turns with no operator input.
  The rhythm is tied to the operator's presence.
- **The session budget.** Each peer turn spends the same token/cost budget as the
  operator's turns; once it's exhausted the loop stops, mesh or not.
- **`max_message_bytes`.** `mesh_send` rejects an over-cap message up front with
  `mesh.message_too_large` (distinct from "no such peer", so the model shortens
  the message rather than re-discovering). A foreign peer's over-cap message is
  rejected on ingress before it drives a turn.
- **Admission control.** Two hard caps keep a chatty or looping peer from
  exhausting the serving instance: at most 64 concurrent inbound connections (a
  peer reconnect-looping past that is dropped), and at most 32 queued peer
  messages waiting to be served — past that, newer ones are dropped with a
  `peer inbox full` notice until the queue drains (submit anything to resume if
  the exchange has paused at the wake-cap).
- **No transitive authority.** Any reachable peer can exchange messages, but every
  `mesh_send` is the local operator's authority, gated by their posture — a peer's
  message never auto-authorizes an onward send. There is no mechanical block on
  serving-and-sending; the cascade is bounded by the wake-cap + budget above.

## Troubleshooting

- **A peer doesn't appear in `mesh_peers`.** It only appears after it runs
  `/relay on`. Confirm both instances run as the same OS user. A crashed instance's
  stale socket/descriptor is swept automatically on the next discovery.
- **`mesh.peer_lost`.** A `mesh_send` failed because the peer's socket was gone or
  dropped before the message landed — it crashed, ran `/relay off` (an in-band `bye`),
  its descriptor was stale, or it closed before completing the handshake. The send
  returns the failure immediately (never a phantom "delivered"), marked retryable — the
  model can retry, then re-run `mesh_peers` if it still fails. (Distinct from
  `mesh.no_such_peer`, which means the alias was never serving — re-discover.)
- **`mesh.at_capacity`.** The peer is serving but momentarily at its inbound-connection
  ceiling (admission control dropped the connection before enqueue) — transient and
  retryable. The model waits a moment and retries the *same* send; it does not
  re-discover, because the peer is alive (unlike `peer_lost`).
- **`/relay on` says the alias is already served by a live peer.** Another live
  instance holds that alias — the default alias is the repo-root basename, so two
  sessions in the same repo (or two repos with the same basename) collide. Claiming an
  alias is atomic: exactly one instance serves it at a time, even under two concurrent
  `/relay on`. Set a distinct `alias` in `[mesh]` for the second.
- **A peer never answers.** There is no deadline — the receiver's model replies
  when it decides, possibly after its operator gives it more context. It may also
  consolidate several of your messages into one reply. If you need it sooner, the
  other operator can nudge their model in their own session.
- **Where it lives.** Sockets and descriptors are under
  `$XDG_RUNTIME_DIR/forja/mesh/` (or `$TMPDIR/forja-<uid>/forja/mesh/`). These are
  private (`0700` / `0600`) and cleaned up on exit.

## Not in scope (v1) / follow-ups

- **Per-message progress to the sender's model** (accepted / working /
  waiting-operator) is not surfaced — a peer's coarse status is visible via
  `mesh_peers`, but it is not streamed over the channel; what crosses is a message,
  when the model decides to send one.
- **Real execution concurrency** (peer turns running in parallel) — the receiver
  executes one turn at a time, even though several messages may queue.
- **Remote / multi-machine** (WebSocket/TCP + mTLS), **structured attachments**
  (typed diffs / test results), a **multi-repo coordinator**, and **per-task
  worktrees** are deliberately out of v1. See [`spec/MESH.md §12`](spec/MESH.md).

## See also

- [`spec/MESH.md`](spec/MESH.md) — the full protocol, trust model, and lifecycle.
