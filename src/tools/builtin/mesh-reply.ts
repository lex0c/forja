// mesh_reply — publish an answer to a peer that opened a conversation with us.
//
// The receiver's model calls this to return the result of a peer's request
// (it arrives as an untrusted peer_message carrying a conversationId handle).
// Unlike mesh_send (EGRESS — initiating outbound contact with an arbitrary
// peer), mesh_reply closes an inbound obligation that `/relay on` already took
// on, so it is NOT egress (§9): it RESPECTS the operator's posture — auto-
// approving under autonomous, and confirming under supervised (where the
// operator reviews what leaves — the two-audiences filter, §7). Asynchronous by
// nature: the initiator absorbed no block waiting for it. Off the base surface
// (deferred). See MESH.md §6.4.

import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

export interface MeshReplyInput {
  conversationId: string;
  output: string;
}
export interface MeshReplyOutput {
  conversationId: string;
  delivered: string;
}

export const meshReplyTool: Tool<MeshReplyInput, MeshReplyOutput> = {
  name: 'mesh_reply',
  description:
    'Publish your answer back to a peer that sent you a request. The conversationId is the handle from the incoming peer message you are answering; this closes that conversation. The output crosses to a separate trust domain — do not include secrets or absolute paths. Returns once delivered.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation handle from the peer message you are answering.',
      },
      output: {
        type: 'string',
        description: 'The answer to send back to the peer (natural language).',
      },
    },
    required: ['conversationId', 'output'],
    additionalProperties: false,
  },
  metadata: {
    category: 'mesh.reply',
    writes: false,
    // NOT network: unlike mesh_send (which OPENS an outbound connection to a peer
    // — network:true, egress), mesh_reply writes to the ALREADY-OPEN inbound
    // connection the manager holds, in-process. No new connection, no external
    // reach. It also must not be scored as net-egress, or the resolver would
    // force a confirm even under autonomous, defeating the posture (§5.3).
    network: false,
    idempotent: false,
    deferred: true,
    display: 'raw',
  },
  async execute(input, ctx: ToolContext): Promise<ToolResult<MeshReplyOutput>> {
    const mgr = ctx.meshManager;
    if (mgr === undefined) {
      return toolError(ERROR_CODES.meshUnavailable, 'mesh_reply: mesh subsystem unavailable');
    }
    if (typeof input.conversationId !== 'string' || input.conversationId.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "mesh_reply: missing 'conversationId'");
    }
    if (typeof input.output !== 'string' || input.output.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "mesh_reply: missing 'output'");
    }
    // sendResult returns false when the conversation is unknown / already closed
    // (stale handle, or the peer disconnected) — surface that instead of a silent
    // no-op, so the model knows the answer didn't land.
    const delivered = mgr.sendResult(input.conversationId, input.output);
    if (!delivered) {
      return toolError(
        ERROR_CODES.meshNoSuchConversation,
        'mesh_reply: no such open conversation (unknown id, or it already closed)',
      );
    }
    return {
      conversationId: input.conversationId,
      delivered: 'published to the peer; the conversation is now closed.',
    };
  },
};
