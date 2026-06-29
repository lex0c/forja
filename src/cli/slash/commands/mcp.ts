// `/mcp` — operator visibility into MCP servers (MCP.md §7). Read-only in this
// slice: `/mcp` lists every server with its live state + tool count, and
// `/mcp show <server>` adds the spawned command, manifest hash, source layer,
// last error, and the trust-decision history. Mutating subcommands
// (revoke/reconnect/trust/logs) land in a later slice.

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

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Inspect MCP servers (state, tools, trust history)',
  argHint: '[show <server>]',
  exec: async (args, ctx): Promise<SlashResult> => {
    const sub = args[0];
    if (sub === undefined || sub === 'list') return handleList(ctx);
    if (sub === 'show') {
      const name = args[1];
      if (name === undefined)
        return { kind: 'error', message: '/mcp show <server>: name required' };
      return handleShow(ctx, name);
    }
    return {
      kind: 'error',
      message: `/mcp: unknown subcommand '${sub}' (try: /mcp list, /mcp show <server>)`,
    };
  },
};
