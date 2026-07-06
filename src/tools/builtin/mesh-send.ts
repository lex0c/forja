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

import { ALIAS_MAX, ALIAS_RE } from '../../mesh/types.ts';
import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

export interface MeshSendInput {
  peer: string;
  message: string;
}
export interface MeshSendOutput {
  id: string;
  delivered: string;
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
        delivered: `sent to '${input.peer}' — it may answer in a later message (or report it couldn't).`,
      };
    } catch (err) {
      return toolError(
        ERROR_CODES.meshNoSuchPeer,
        `mesh_send: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
