import { describe, expect, test } from 'bun:test';
import { meshPeersTool } from '../../src/tools/builtin/mesh-peers.ts';
import { meshSendTool } from '../../src/tools/builtin/mesh-send.ts';
import { type ToolContext, isToolError } from '../../src/tools/types.ts';

const ctxWith = (meshManager: unknown): ToolContext =>
  ({ meshManager, signal: new AbortController().signal }) as unknown as ToolContext;

describe('mesh_peers tool', () => {
  test('returns peers from the manager', async () => {
    const mgr = { listPeers: () => [{ alias: 'billing', branch: 'main', status: 'idle' }] };
    const r = await meshPeersTool.execute({}, ctxWith(mgr));
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) {
      expect(r.peers).toEqual([{ alias: 'billing', branch: 'main', status: 'idle' }]);
    }
  });

  test('errors when the mesh subsystem is unavailable', async () => {
    const r = await meshPeersTool.execute({}, ctxWith(undefined));
    expect(isToolError(r) && r.error_code).toBe('mesh.unavailable');
  });
});

describe('mesh_send tool', () => {
  test('is gated as egress (never auto-approved under autonomous)', () => {
    expect(meshSendTool.metadata.category).toBe('mesh.egress');
    expect(meshSendTool.metadata.network).toBe(true);
  });

  test('delivers and returns the conversation id', async () => {
    const mgr = { isServing: () => false, send: async () => ({ conversationId: 'c1' }) };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) expect(r.conversationId).toBe('c1');
  });

  test('errors on a non-existent peer', async () => {
    const mgr = {
      isServing: () => false,
      send: async () => {
        throw new Error('no live peer');
      },
    };
    const r = await meshSendTool.execute({ peer: 'ghost', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('mesh.no_such_peer');
  });

  test('errors when the mesh subsystem is unavailable', async () => {
    const r = await meshSendTool.execute({ peer: 'x', message: 'y' }, ctxWith(undefined));
    expect(isToolError(r) && r.error_code).toBe('mesh.unavailable');
  });

  test('rejects an invalid peer alias (control/injection defense)', async () => {
    const mgr = { isServing: () => false, send: async () => ({ conversationId: 'c1' }) };
    const r = await meshSendTool.execute({ peer: '../evil[2J', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('tool.invalid_arg');
  });

  test('refuses to send while THIS session is serving (no transitive delegation, §8)', async () => {
    const mgr = { isServing: () => true, send: async () => ({ conversationId: 'c1' }) };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('mesh.delegation_blocked');
  });
});
