import { describe, expect, test } from 'bun:test';
import { meshPeersTool } from '../../src/tools/builtin/mesh-peers.ts';
import { meshReplyTool } from '../../src/tools/builtin/mesh-reply.ts';
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

describe('mesh_reply tool', () => {
  test('is NOT egress — mesh.reply respects posture (autonomous can auto-approve)', () => {
    expect(meshReplyTool.metadata.category).toBe('mesh.reply');
  });

  test('publishes to the conversation and returns its id', async () => {
    const mgr = { sendResult: () => true };
    const r = await meshReplyTool.execute(
      { conversationId: 'c1', output: 'here it is' },
      ctxWith(mgr),
    );
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) expect(r.conversationId).toBe('c1');
  });

  test('errors when the conversation is unknown or already closed', async () => {
    const mgr = { sendResult: () => false };
    const r = await meshReplyTool.execute({ conversationId: 'gone', output: 'x' }, ctxWith(mgr));
    expect(isToolError(r) && r.error_code).toBe('mesh.no_such_conversation');
  });

  test('errors when the mesh subsystem is unavailable', async () => {
    const r = await meshReplyTool.execute({ conversationId: 'c', output: 'y' }, ctxWith(undefined));
    expect(isToolError(r) && r.error_code).toBe('mesh.unavailable');
  });

  test('rejects an empty conversationId or output before delivering', async () => {
    let called = false;
    const mgr = {
      sendResult: () => {
        called = true;
        return true;
      },
    };
    const r1 = await meshReplyTool.execute({ conversationId: '', output: 'x' }, ctxWith(mgr));
    expect(isToolError(r1) && r1.error_code).toBe('tool.invalid_arg');
    const r2 = await meshReplyTool.execute({ conversationId: 'c1', output: '' }, ctxWith(mgr));
    expect(isToolError(r2) && r2.error_code).toBe('tool.invalid_arg');
    expect(called).toBe(false); // never reached the transport
  });
});
