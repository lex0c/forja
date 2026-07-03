// mesh_peers — discover local Forja instances currently serving on the mesh.
//
// Reads the filesystem registry via the mesh manager and returns each live
// peer's alias, branch, and status — never the repo path (§2). Listing also
// sweeps dead-peer runtime files (self-healing GC, not a work-tree write — so
// writes:false holds). Off the base surface (deferred, via tool_search).
// See MESH.md §9.

import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

export type MeshPeersInput = Record<string, never>;
export interface MeshPeersOutput {
  peers: { alias: string; branch: string; status: string }[];
}

export const meshPeersTool: Tool<MeshPeersInput, MeshPeersOutput> = {
  name: 'mesh_peers',
  description:
    'List local Forja instances currently serving on the mesh — peers you can send a textual request to with mesh_send. Returns each alias, branch, and status. Only instances that ran /relay appear.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    deferred: true,
    display: 'table',
  },
  async execute(_input, ctx: ToolContext): Promise<ToolResult<MeshPeersOutput>> {
    const mgr = ctx.meshManager;
    if (mgr === undefined) {
      return toolError(ERROR_CODES.meshUnavailable, 'mesh_peers: mesh subsystem unavailable');
    }
    const peers = mgr.listPeers().map((p) => ({
      alias: p.alias,
      branch: p.branch,
      status: p.status,
    }));
    return { peers };
  },
};
