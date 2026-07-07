import { describe, expect, test } from 'bun:test';
import { meshPeersTool } from '../../src/tools/builtin/mesh-peers.ts';
import { meshSendTool } from '../../src/tools/builtin/mesh-send.ts';
import { type ToolContext, isEnvelopeSideEffect, isToolError } from '../../src/tools/types.ts';

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

  test('counts as an envelope side effect — network egress cannot slip a narrowed subagent', () => {
    // mesh_send's resolver emits NO capabilities, so the §10.3 envelope gate falls back
    // to isEnvelopeSideEffect for a zero-cap resolver. writes is false, so before the fix
    // it passed under effectiveCapabilities:[] and a narrowed subagent could send
    // arbitrary text (secrets) to a peer. network / escapesCwd now make it a side effect.
    expect(isEnvelopeSideEffect(meshSendTool.metadata)).toBe(true);
    // Contrast: mesh_peers is read-only (misc, no writes/network/escapesCwd) → still
    // allowed under an empty envelope; discovery leaks nothing outbound.
    expect(isEnvelopeSideEffect(meshPeersTool.metadata)).toBe(false);
  });

  test('delivers, returns the message id, and surfaces the payload excerpt on the card', async () => {
    const mgr = { isServing: () => false, send: async () => ({ id: 'm1' }) };
    const r = await meshSendTool.execute(
      { peer: 'billing', message: 'bump the auth contract to v2' },
      ctxWith(mgr),
    );
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) {
      expect(r.id).toBe('m1');
      // result_detail shows WHAT left — the operator's only payload window under
      // autonomous (no confirm modal).
      expect(r.result_detail).toContain('billing');
      expect(r.result_detail).toContain('bump the auth contract to v2');
    }
  });

  test('surfaces how much of a long message is hidden past the excerpt on the card', async () => {
    // Under autonomous the card is the ONLY payload window; a bare truncation would
    // hide a kilobyte tail (a path/secret). Show the scale of what left.
    const mgr = { isServing: () => false, send: async () => ({ id: 'm2' }) };
    const message = `${'x'.repeat(200)} tail`;
    const r = await meshSendTool.execute({ peer: 'billing', message }, ctxWith(mgr));
    expect(isToolError(r)).toBe(false);
    if (!isToolError(r)) {
      expect(r.result_detail).toContain(`+${message.length - 160} more chars`);
    }
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
    // peer_lost is transient → the model should retry, so it's marked retryable
    // (not just distinguished by code) with an actionable hint.
    expect(isToolError(r) && r.retryable).toBe(true);
    expect(isToolError(r) && typeof r.hint === 'string').toBe(true);
  });

  test('maps an at_capacity send failure to a DISTINCT retryable code (wait vs re-discover)', async () => {
    const mgr = {
      isServing: () => false,
      send: async () => {
        // The manager embeds at_capacity when the peer's admission control dropped
        // the connection at its ceiling — the peer is alive, just momentarily full.
        throw new Error(
          "mesh: peer 'x' rejected the message — mesh.at_capacity: at the 64-connection ceiling",
        );
      },
    };
    const r = await meshSendTool.execute({ peer: 'billing', message: 'hi' }, ctxWith(mgr));
    // Distinct code (not peer_lost / no_such_peer) so the model waits and retries the
    // SAME send rather than re-running discovery for a peer it thinks is gone.
    expect(isToolError(r) && r.error_code).toBe('mesh.at_capacity');
    expect(isToolError(r) && r.retryable).toBe(true);
    expect(isToolError(r) && typeof r.hint === 'string').toBe(true);
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
