// `/mcp` — operator control over MCP servers (MCP.md §7). `/mcp` lists every
// server with its live state + tool count; `/mcp show <server>` adds the spawned
// command, manifest hash, source layer, last error, and the trust-decision
// history; `/mcp revoke <server>` denies + unregisters a server (durable across
// relaunch); `/mcp reconnect <server>` re-trusts + re-registers it; `/mcp logs
// <server>` tails the server's captured stderr. The mutating subcommands run
// BETWEEN turns (they hot-swap the live tool registry).

import { existsSync } from 'node:fs';
import { sanitizeOneLineForDisplay, stripControlKeepLines } from '../../../sanitize/ansi.ts';
import {
  getServer,
  getServerAnyScope,
  listManifestHistory,
  listServers,
} from '../../../storage/repos/mcp-servers.ts';
import { localTimestamp } from '../../local-date.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

// Read the last `maxLines` non-empty lines of a (possibly large, ≤10 MB after
// rotation) log file, scanning only the trailing `maxBytes` so `/mcp logs`
// never slurps the whole file. A mid-file slice drops its partial first line —
// UNLESS the whole window is one line (a >maxBytes record with no newline),
// where dropping it would falsely report the log as empty; keep that (truncated)
// tail instead.
const tailLines = async (path: string, maxLines: number, maxBytes = 65536): Promise<string[]> => {
  const file = Bun.file(path);
  const size = file.size;
  const sliced = size > maxBytes;
  const text = await (sliced ? file.slice(size - maxBytes) : file).text();
  const lines = text.split('\n');
  const dropPartial = sliced && lines.length > 1;
  return (dropPartial ? lines.slice(1) : lines).filter((l) => l.length > 0).slice(-maxLines);
};

// The persisted remote identity in `mcp_servers.url` is the raw endpoint, or a
// `{ url, auth }` JSON blob when the server binds a bearer env var (manager.ts
// `remoteUrlIdentity`). Render the endpoint the operator approved, naming the
// bound auth env var when present; fall back to the raw value if it isn't that
// shape. The value is config-derived (unresolved `rawUrl`), not server-authored,
// so no sanitization is needed here.
const renderEndpoint = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; auth?: unknown };
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.url === 'string') {
      return typeof parsed.auth === 'string'
        ? `${parsed.url} (auth env: $${parsed.auth})`
        : parsed.url;
    }
  } catch {
    // Not JSON — a plain raw URL string.
  }
  return raw;
};

const handleShow = (ctx: SlashContext, name: string): SlashResult => {
  // Read the right `(scope, name)` row: the manager knows this server's scope
  // (from its config source); without a manager (or a server not in config) fall
  // back to the first row matching the name across scopes.
  const mgr = ctx.baseConfig.mcpManager;
  const scope = mgr?.scopeFor(name) ?? null;
  const row = scope !== null ? getServer(ctx.db, scope, name) : getServerAnyScope(ctx.db, name);
  if (row === null) {
    return { kind: 'error', message: `/mcp: no server '${name}' (try /mcp to list)` };
  }
  // Prefer the manager's LIVE state over the persisted row; the row is the
  // last-written value and may lag a mid-session transition.
  const live = mgr?.state(name);
  // Sanitize every field that originates OUTSIDE the harness before it lands in a
  // note the info renderer prints verbatim: the persisted identity (command / URL)
  // comes from a repo's mcp.toml, and protocol/server version + last_error come
  // from the server's own initialize/handshake — a hostile repo or server could
  // otherwise embed ANSI/control bytes to repaint or forge the operator's terminal
  // when they inspect it (same anti-spoof the trust modal + /mcp logs already do).
  // The remaining fields are harness-controlled (validated name, state/source/
  // decision enums, hex hash, numbers, formatted timestamps) — left as-is.
  const s = sanitizeOneLineForDisplay;
  const lines: string[] = [
    `mcp server '${name}':`,
    `  state:    ${live ?? row.state}`,
    `  source:   ${row.source}`,
    // stdio persists its identity in `command` (url null); a remote server in
    // `url` (command null). Show whichever this transport uses so a remote
    // server's approved endpoint is visible instead of `command: —`.
    row.transport === 'stdio'
      ? `  command:  ${row.command !== null ? s(row.command) : '—'}`
      : `  url:      ${row.url !== null ? s(renderEndpoint(row.url)) : '—'}`,
    `  manifest: ${row.current_manifest_hash ?? '—'}`,
    `  protocol: ${row.protocol_version !== null ? s(row.protocol_version) : '—'}${row.server_version !== null ? ` (server ${s(row.server_version)})` : ''}`,
    `  calls:    ${row.total_calls}`,
    `  last connected: ${localTimestamp(row.last_connected_at)}`,
    `  last error:     ${row.last_error !== null ? s(row.last_error) : 'none'}`,
  ];
  const history = listManifestHistory(ctx.db, row.scope, name);
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
  // With a manager, restrict to THIS session's scopes (the repo + the global user
  // scope) so another repo's rows don't leak into the list; without one, show all.
  const rows = mgr !== undefined ? listServers(ctx.db, mgr.scopes()) : listServers(ctx.db);
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

const handleLogs = async (ctx: SlashContext, name: string): Promise<SlashResult> => {
  const mgr = ctx.baseConfig.mcpManager;
  if (mgr === undefined) {
    return { kind: 'error', message: '/mcp logs: MCP is not active in this session' };
  }
  const scope = mgr.scopeFor(name);
  if (scope === null || getServer(ctx.db, scope, name) === null) {
    return { kind: 'error', message: `/mcp: no server '${name}' (try /mcp to list)` };
  }
  const path = mgr.logPath(name);
  if (path === null) {
    return { kind: 'ok', notes: [`No stderr log is configured for '${name}' (headless session).`] };
  }
  if (!existsSync(path)) {
    return {
      kind: 'ok',
      notes: [
        `No stderr captured for '${name}' yet — the server hasn't written to stderr or hasn't been spawned.`,
        `(log: ${path})`,
      ],
    };
  }
  let tail: string[];
  try {
    tail = await tailLines(path, 40);
  } catch {
    // The file existed at the existsSync check but the read failed — most likely
    // a 10 MB rotation renamed it in between. A retry will land on the fresh log.
    return {
      kind: 'ok',
      notes: [
        `Could not read '${name}' stderr just now (it may have just rotated) — try again. (${path})`,
      ],
    };
  }
  if (tail.length === 0) {
    return { kind: 'ok', notes: [`'${name}' stderr log is empty (${path}).`] };
  }
  return {
    kind: 'ok',
    notes: [
      `mcp '${name}' stderr — last ${tail.length} line${tail.length === 1 ? '' : 's'} (${path}):`,
      // Untrusted server output landing in the operator's scrollback — strip ANSI
      // + control bytes (ESC / \r / \b / bell …) so a hostile server can't repaint
      // the terminal or forge UI text when its logs are inspected.
      ...tail.map(stripControlKeepLines),
    ],
  };
};

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Inspect + control MCP servers (show / revoke / reconnect / logs)',
  argHint: '[show|revoke|reconnect|logs <server>]',
  exec: async (args, ctx): Promise<SlashResult> => {
    const sub = args[0];
    if (sub === undefined || sub === 'list') return handleList(ctx);
    if (sub === 'show' || sub === 'revoke' || sub === 'reconnect' || sub === 'logs') {
      const name = args[1];
      if (name === undefined) {
        return { kind: 'error', message: `/mcp ${sub} <server>: name required` };
      }
      if (sub === 'show') return handleShow(ctx, name);
      if (sub === 'revoke') return handleRevoke(ctx, name);
      if (sub === 'reconnect') return handleReconnect(ctx, name);
      return handleLogs(ctx, name);
    }
    return {
      kind: 'error',
      message: `/mcp: unknown subcommand '${sub}' (try: /mcp list, /mcp show|revoke|reconnect|logs <server>)`,
    };
  },
};
