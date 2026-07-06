// mesh_send — send a textual message to a local Forja peer on the mesh.
//
// Sends over a same-user LOCAL Unix socket. It RESPECTS the operator's posture
// (MESH.md §5.3): supervised confirms each send (showing the outbound payload —
// the two-audiences review); autonomous auto-approves, like any local effect.
// NOT categoryIsEgress — a local same-user boundary, not network egress.
// Fire-and-forget: it delivers the message and returns immediately; a reply, if
// any, arrives later as its own inbound peer_message turn (like bash_background).
// The exchange is SYMMETRIC — send is available even while THIS session is
// serving (a reply is just a message back). The peer is a sovereign instance —
// it decides what to do under ITS operator's approval; this tool carries intent,
// never authority (§0, §1.2). Off the base surface (deferred). See MESH.md §6.4.

import { ALIAS_MAX, ALIAS_RE, MESH_ERROR_CODES } from '../../mesh/types.ts';
import { sanitizeOneLineForDisplay } from '../../sanitize/ansi.ts';
import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

export interface MeshSendInput {
  peer: string;
  message: string;
}
export interface MeshSendOutput {
  id: string;
  delivered: string;
  // A bounded, control-stripped excerpt of what left, surfaced on the tool card so
  // the operator SEES the outbound payload in BOTH postures — under autonomous
  // (no confirm) this is the only place the "nothing leaves in silence" safeguard
  // (§6.1/§7) is met; supervised also gets it in the confirm modal.
  result_detail?: string;
}

export const meshSendTool: Tool<MeshSendInput, MeshSendOutput> = {
  name: 'mesh_send',
  description:
    'Send a textual message to a local Forja peer (discover peers with mesh_peers). Use it to ask, to answer a message a peer sent you, or to follow up — the exchange is free, not a strict request/reply. The peer runs in ITS own repository under ITS operator’s approval and answers in a later message; you send intent, not commands. Returns once the message is delivered. Do not send secrets or absolute paths; the peer is a separate trust domain.',
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: 'The peer alias (from mesh_peers).' },
      message: {
        type: 'string',
        description: 'The textual message (natural language; intent, not a command).',
      },
    },
    required: ['peer', 'message'],
    additionalProperties: false,
  },
  metadata: {
    category: 'mesh.egress',
    writes: false,
    network: true,
    escapesCwd: true,
    idempotent: false,
    deferred: true,
    display: 'raw',
  },
  async execute(input, ctx: ToolContext): Promise<ToolResult<MeshSendOutput>> {
    const mgr = ctx.meshManager;
    if (mgr === undefined) {
      return toolError(ERROR_CODES.meshUnavailable, 'mesh_send: mesh subsystem unavailable');
    }
    if (
      typeof input.peer !== 'string' ||
      !ALIAS_RE.test(input.peer) ||
      input.peer.length > ALIAS_MAX
    ) {
      // Validate against the alias grammar AND length (not just non-empty): the
      // peer becomes the confirm modal's command line, so reject a control/
      // injection or unbounded alias at the tool boundary.
      return toolError(
        ERROR_CODES.invalidArg,
        "mesh_send: 'peer' must be a valid peer alias (from mesh_peers)",
      );
    }
    if (typeof input.message !== 'string' || input.message.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "mesh_send: missing 'message'");
    }
    const messageBytes = Buffer.byteLength(input.message, 'utf8');
    if (messageBytes > mgr.maxMessageBytes) {
      // Reject up front with a DISTINCT code — otherwise the send() throw collapses
      // into the catch-all no_such_peer below, and the model re-runs discovery
      // instead of shortening the message. (A smaller receiver cap can still reject
      // it over the wire; that comes back as a legible peer error message.)
      return toolError(
        ERROR_CODES.meshMessageTooLarge,
        `mesh_send: message is ${messageBytes} bytes, over the ${mgr.maxMessageBytes}-byte peer cap — shorten it`,
      );
    }
    try {
      const { id } = await mgr.send(input.peer, input.message);
      return {
        id,
        delivered: `sent to '${input.peer}' — its reply, if any, arrives on its own as a later turn (no need to wait or poll).`,
        // Surface WHAT left on the tool card (the two-audiences review, §7) — the
        // only outbound-payload visibility the operator gets under autonomous.
        result_detail: `→ ${input.peer}: ${sanitizeOneLineForDisplay(input.message, 160)}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The peer REJECTED it on the wire because its cap is smaller than ours (our
      // up-front check used OUR cap) — same distinct code + "shorten it" guidance as
      // the up-front path, so the model shortens rather than re-discovering.
      if (message.includes(MESH_ERROR_CODES.messageTooLarge)) {
        return toolError(ERROR_CODES.meshMessageTooLarge, `mesh_send: ${message}`);
      }
      // Distinguish a peer that was reachable in discovery but dropped (peer_lost —
      // connect refused / socket closed mid-send; the manager embeds the code in the
      // message) from one that isn't serving at all (no_such_peer). Set the machine-
      // readable retryable/hint too, not just the code — a model keying on `retryable`
      // must retry a transient peer_lost and re-discover a no_such_peer (§6.5).
      if (message.includes(MESH_ERROR_CODES.peerLost)) {
        return toolError(ERROR_CODES.meshPeerLost, `mesh_send: ${message}`, {
          retryable: true,
          hint: "the peer was serving but the connection dropped — retry once; if it fails again, run mesh_peers to check it's still live",
        });
      }
      return toolError(ERROR_CODES.meshNoSuchPeer, `mesh_send: ${message}`, {
        hint: 'run mesh_peers — the alias may be stale, or the peer stopped serving',
      });
    }
  },
};
