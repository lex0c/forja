// /relay — serve mesh peers on a local Unix socket (on / off).
//
// `/relay on` opens a confirm modal (opening the listen socket is the first
// inbound channel Forja creates, so it gets an explicit consent gate —
// MESH.md §6.1); on yes the session starts serving peers WITHOUT becoming
// dedicated — the operator keeps working, and peer messages interleave as system
// turns in the operator's OWN session, under their approval (§6.1). `/relay off`
// stops it. Bare `/relay` reports status. A peer message is intent, never authority.

import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const statusNotes = (ctx: SlashContext): SlashResult => {
  const mgr = ctx.baseConfig.meshManager;
  if (mgr === undefined) return { kind: 'ok', notes: ['relay: mesh subsystem unavailable'] };
  if (!mgr.isServing()) {
    return { kind: 'ok', notes: ['relay: off (run /relay on to start serving mesh peers)'] };
  }
  // Surface reachable peers on demand — mesh_peers is a model-only tool, so this is
  // the operator's only window into who's out there (and their coarse status) when
  // deciding whether to jump in and help the exchange (§6.3).
  const peers = mgr.listPeers();
  const peerNote =
    peers.length === 0
      ? 'no other peers serving'
      : `peers: ${peers.map((p) => `${p.alias} (${p.status})`).join(', ')}`;
  return { kind: 'ok', notes: [`relay: on — serving as '${mgr.alias}'`, peerNote] };
};

export const relayCommand: SlashCommand = {
  name: 'relay',
  description: 'serve mesh peers on a local socket (on / off)',
  argHint: 'on | off',
  exec: async (args, ctx): Promise<SlashResult> => {
    const mgr = ctx.baseConfig.meshManager;
    if (mgr === undefined) {
      return { kind: 'error', message: '/relay: mesh subsystem unavailable' };
    }
    const sub = (args[0] ?? '').toLowerCase();

    // Repaint the footer badge from the manager's REAL serving state after any
    // action — isServing() is the source of truth (§6.1), so this also
    // reconciles the badge if a prior partial failure left it out of sync.
    const syncBadge = (): void => {
      const active = mgr.isServing();
      ctx.bus.emit({
        type: 'relay:change',
        ts: ctx.now(),
        active,
        alias: active ? mgr.alias : null,
      });
    };

    if (sub === 'off') {
      if (!mgr.isServing()) return { kind: 'ok', notes: ['relay: already off'] };
      try {
        await mgr.stopServing();
      } finally {
        syncBadge();
      }
      return { kind: 'ok', notes: ['relay: off'] };
    }

    if (sub === 'on') {
      if (mgr.isServing()) {
        syncBadge();
        return statusNotes(ctx);
      }
      // Consent gate before opening the socket (§6.1). Headless (no modal) → the
      // enqueueConfirm bridge resolves 'cancel', so we simply don't start.
      const answer = await ctx.modalManager.askRelayStart({ alias: mgr.alias });
      if (answer !== 'yes') return { kind: 'ok', notes: ['relay: not started'] };
      try {
        await mgr.startServing();
      } catch (err) {
        // startServing rolls its socket back on failure; sync the badge to OFF.
        syncBadge();
        return {
          kind: 'error',
          message: `/relay: could not start — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      syncBadge();
      return {
        kind: 'ok',
        notes: [
          `relay: on — serving as '${mgr.alias}'; keep working, peer messages interleave`,
          'you can still mesh_send to peers while serving — the exchange is symmetric',
        ],
      };
    }

    // Bare `/relay` reports status — `on`/`off` are the action verbs.
    if (sub.length === 0) {
      syncBadge();
      return statusNotes(ctx);
    }

    return { kind: 'error', message: `/relay: unknown arg '${args[0]}' (usage: /relay on | off)` };
  },
};
