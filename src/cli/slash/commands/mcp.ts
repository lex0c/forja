// `/mcp` — operator control over MCP servers (MCP.md §7). `/mcp` lists every
// server with its live state + tool count; `/mcp show <server>` adds the spawned
// command, manifest hash, source layer, last error, and the trust-decision
// history; `/mcp revoke <server>` denies + unregisters a server (durable across
// relaunch); `/mcp reconnect <server>` re-trusts + re-registers it. The mutating
// subcommands run BETWEEN turns (they hot-swap the live tool registry). `/mcp
// logs` lands in a later slice.

import { getServer, listManifestHistory, listServers } from '../../../storage/repos/mcp-servers.ts';
import { localTimestamp } from '../../local-date.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const handleShow = (ctx: SlashContext, name: string): SlashResult => {
  const row = getServer(ctx.db, name);
  if (row === null) {
    return { kind: 'error', message: `/mcp: no server '${name}' (try /mcp to list)` };
  }
  // Prefer the manager's LIVE state over the persisted row; the row is the
  // last-written value and may lag a mid-session transition.
  const live = ctx.baseConfig.mcpManager?.state(name);
  const lines: string[] = [
    `mcp server '${name}':`,
    `  state:    ${live ?? row.state}`,
    `  source:   ${row.source}`,
    `  command:  ${row.command ?? '—'}`,
    `  manifest: ${row.current_manifest_hash ?? '—'}`,
    `  protocol: ${row.protocol_version ?? '—'}${row.server_version !== null ? ` (server ${row.server_version})` : ''}`,
    `  calls:    ${row.total_calls}`,
    `  last connected: ${localTimestamp(row.last_connected_at)}`,
    `  last error:     ${row.last_error ?? 'none'}`,
  ];
  const history = listManifestHistory(ctx.db, name);
  if (history.length > 0) {
    lines.push('  trust history (newest first):');
    for (const h of history.slice(0, 10)) {
      lines.push(
        `    ${h.decision.padEnd(9)} ${h.hash.slice(0, 12)}  by ${h.decided_by}  at ${localTimestamp(h.decided_at)}`,
      );
    }
    if (history.length > 10) lines.push(`    …and ${history.length - 10} older`);
  }
  return { kind: 'ok', notes: lines };
};

const handleList = (ctx: SlashContext): SlashResult => {
  // Live status (state + tool count) from the manager when present; fall back to
  // the persisted rows (headless / no manager) so `/mcp` still works.
  const mgr = ctx.baseConfig.mcpManager;
  const rows = listServers(ctx.db);
  const live = mgr?.status() ?? [];
  const liveByName = new Map(live.map((s) => [s.name, s]));
  const rowByName = new Map(rows.map((r) => [r.name, r]));
  // Union of live (enabled, in the runtime) + persisted rows, by name. Empty
  // exactly when there are no servers at all (covers the headless / no-db case).
  const names = [...new Set([...live.map((s) => s.name), ...rows.map((r) => r.name)])].sort();
  if (names.length === 0) {
    return { kind: 'ok', notes: ['No MCP servers configured (see docs/MCP.md).'] };
  }
  const lines = [`MCP servers (${names.length}):`];
  for (const n of names) {
    const s = liveByName.get(n);
    const r = rowByName.get(n);
    // A server in the persisted rows but absent from the LIVE runtime (when a
    // manager IS present) was skipped by init → it is disabled in config; show
    // that rather than its stale persisted state.
    const disabled = mgr !== undefined && s === undefined;
    const state = disabled ? 'disabled' : (s?.state ?? r?.state ?? '—');
    const tools = s !== undefined ? `${s.tools} tool${s.tools === 1 ? '' : 's'}` : '—';
    lines.push(`  ${n.padEnd(16)} ${state.padEnd(13)} ${tools.padEnd(9)} ${r?.source ?? '—'}`);
  }
  lines.push('Use /mcp show <server> for details.');
  return { kind: 'ok', notes: lines };
};

// The mutating subcommands hot-swap the LIVE tool registry. The harness reads
// its config (incl. the registry) once at turn start, so a mid-turn mutation
// half-applies to the running turn — gate to between-turns.
const requireIdleManager = (
  ctx: SlashContext,
  verb: string,
):
  | { kind: 'error'; message: string }
  | { mgr: NonNullable<SlashContext['baseConfig']['mcpManager']> } => {
  const mgr = ctx.baseConfig.mcpManager;
  if (mgr === undefined) {
    return { kind: 'error', message: `/mcp ${verb}: MCP is not active in this session` };
  }
  if (ctx.isRunning()) {
    return {
      kind: 'error',
      message: `/mcp ${verb}: a turn is in flight — run it between turns (it changes the live tool set)`,
    };
  }
  return { mgr };
};

// A mutating subcommand holds the busy-lock for its whole (possibly async,
// modal-bearing) duration via runExclusive, so a turn can't START mid-mutation
// and snapshot a half-swapped registry. Falls back to a direct call in
// headless/test contexts that don't wire runExclusive.
const withExclusive = <T>(ctx: SlashContext, fn: () => Promise<T>): Promise<T> =>
  ctx.runExclusive !== undefined ? ctx.runExclusive(() => fn()) : fn();

const handleRevoke = async (ctx: SlashContext, name: string): Promise<SlashResult> => {
  const gate = requireIdleManager(ctx, 'revoke');
  if ('kind' in gate) return gate;
  const r = await withExclusive(ctx, () => gate.mgr.revoke(name));
  if (!r.ok) return { kind: 'error', message: `/mcp revoke: ${r.reason ?? 'failed'}` };
  return {
    kind: 'ok',
    notes: [
      `Revoked '${name}' — denied + ${r.tools} tool${r.tools === 1 ? '' : 's'} removed (persists across relaunch).`,
      `Re-enable with /mcp reconnect ${name}.`,
    ],
  };
};

const handleReconnect = async (ctx: SlashContext, name: string): Promise<SlashResult> => {
  const gate = requireIdleManager(ctx, 'reconnect');
  if ('kind' in gate) return gate;
  const r = await withExclusive(ctx, () => gate.mgr.reconnect(name));
  if (!r.ok) {
    // reason is the resulting state ('denied' / 'error') — a re-denied or
    // unreachable server stays revoked, so say so instead of a green "0 tools".
    return {
      kind: 'error',
      message: `/mcp reconnect '${name}': ${r.reason ?? 'failed'} — still revoked (server denied or unreachable)`,
    };
  }
  return {
    kind: 'ok',
    notes: [
      `Reconnected '${name}' — ${r.registered} tool${r.registered === 1 ? '' : 's'} registered.`,
      ...r.warnings,
    ],
  };
};

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Inspect + control MCP servers (show / revoke / reconnect)',
  argHint: '[show|revoke|reconnect <server>]',
  exec: async (args, ctx): Promise<SlashResult> => {
    const sub = args[0];
    if (sub === undefined || sub === 'list') return handleList(ctx);
    if (sub === 'show' || sub === 'revoke' || sub === 'reconnect') {
      const name = args[1];
      if (name === undefined) {
        return { kind: 'error', message: `/mcp ${sub} <server>: name required` };
      }
      if (sub === 'show') return handleShow(ctx, name);
      if (sub === 'revoke') return handleRevoke(ctx, name);
      return handleReconnect(ctx, name);
    }
    return {
      kind: 'error',
      message: `/mcp: unknown subcommand '${sub}' (try: /mcp list, /mcp show|revoke|reconnect <server>)`,
    };
  },
};
