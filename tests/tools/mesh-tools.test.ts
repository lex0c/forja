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
  test('carries the mesh.egress category (posture-respecting — auto-approve is tested in the engine)', () => {
    // The category name stays `mesh.egress` (an outbound send), but it is NOT in
    // categoryIsEgress — so it respects posture (autonomous auto-approves). That
    // behavior is locked in tests/permissions/engine.test.ts; here we just pin the
    // tool metadata. network:true is honest (it opens a socket) but the socket is a
    // local Unix one, so it doesn't feed the risk score.
    expect(meshSendTool.metadata.category).toBe('mesh.egress');
    expect(meshSendTool.metadata.network).toBe(true);
  });

  test('delivers and returns the message id', async () => {
    const mgr = { isServing: () => false, send: async () => ({ id: 'm1' }) };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) expect(r.id).toBe('m1');
  });

  test('sends even while THIS session is serving (symmetric exchange — a reply is just a message)', async () => {
    const mgr = { isServing: () => true, send: async () => ({ id: 'm1' }) };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) expect(r.id).toBe('m1');
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

  test('maps a peer_lost send failure to a DISTINCT code (retry vs re-discover, §6.5)', async () => {
    const mgr = {
      isServing: () => false,
      send: async () => {
        // The manager embeds the peer_lost code in the message on a connect-refused
        // / write-failed send (a peer that WAS in discovery but dropped).
        throw new Error("mesh: peer 'x' is unreachable — mesh.peer_lost");
      },
    };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('mesh.peer_lost');
  });

  test('errors when the mesh subsystem is unavailable', async () => {
    const r = await meshSendTool.execute({ peer: 'x', message: 'y' }, ctxWith(undefined));
    expect(isToolError(r) && r.error_code).toBe('mesh.unavailable');
  });

  test('rejects an invalid peer alias (control/injection defense)', async () => {
    const mgr = { isServing: () => false, send: async () => ({ id: 'm1' }) };
    const r = await meshSendTool.execute({ peer: '../evil[2J', message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects an over-length peer alias (grammar-valid but unbounded)', async () => {
    const mgr = { isServing: () => false, send: async () => ({ id: 'm1' }) };
    const r = await meshSendTool.execute({ peer: 'a'.repeat(5000), message: 'hi' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('tool.invalid_arg');
  });

  test('rejects an over-cap message with a distinct message_too_large code', async () => {
    const mgr = {
      isServing: () => false,
      maxMessageBytes: 10,
      send: async () => ({ id: 'm1' }),
    };
    const r = await meshSendTool.execute(
      { peer: 'billing', message: 'x'.repeat(50) },
      ctxWith(mgr),
    );
    // Distinct from no_such_peer — the model shortens the message, not re-discovers.
    expect(isToolError(r) && r.error_code).toBe('mesh.message_too_large');
  });
});
