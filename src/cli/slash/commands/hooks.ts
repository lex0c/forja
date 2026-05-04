// /hooks — inspect resolved hook configuration and recent
// dispatch history (spec AGENTIC_CLI.md §10.4).
//
// Read-only by design. Mutating hooks goes through the on-disk
// hooks.toml hierarchy (`<repo>/.agent/hooks.toml`,
// `~/.config/agent/hooks.toml`, `/etc/agent/hooks.toml`) — keeps
// a single source of truth and avoids inventing a runtime
// mutation path that would diverge from the file format.
//
// Subcommands:
//   /hooks               summary (count by event + layer)
//   /hooks list          every loaded hook in resolution order
//     [--layer <l>]      filter by enterprise / user / project
//     [--event <e>]      filter by hook event name
//   /hooks audit         recent hook_runs rows
//     [--session]        only this REPL session's runs
//     [--event <e>]      filter by event
//     [--limit N]        cap output (default 20, max 200)

import type { HookEvent, HookLayer, HookSpec } from '../../../hooks/index.ts';
import {
  type HookRun,
  listHookRunsBySession,
  listRecentHookRuns,
} from '../../../storage/repos/hook-runs.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const ALL_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'Notification',
  'PreCheckpoint',
  'MemoryWrite',
  'Stop',
];

const ALL_LAYERS: readonly HookLayer[] = ['enterprise', 'user', 'project'];

const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 200;

const isHookEvent = (value: string): value is HookEvent =>
  (ALL_EVENTS as readonly string[]).includes(value);

const isHookLayer = (value: string): value is HookLayer =>
  (ALL_LAYERS as readonly string[]).includes(value);

// Truncate command preview at this width so a long template-
// expanded shell string doesn't overflow the scrollback line.
// Operator reads the source file for the full text; the slash
// surface is a forensic glance, not the source of truth.
const COMMAND_PREVIEW_LIMIT = 60;

const previewCommand = (cmd: string): string => {
  if (cmd.length <= COMMAND_PREVIEW_LIMIT) return cmd;
  return `${cmd.slice(0, COMMAND_PREVIEW_LIMIT - 1)}…`;
};

const formatHook = (h: HookSpec, idx: number): string => {
  const matcherFrag = h.matcher.tool !== undefined ? ` matcher=tool:${h.matcher.tool}` : '';
  const flags: string[] = [];
  if (h.locked) flags.push('locked');
  if (h.failClosed) flags.push('fail_closed');
  const flagFrag = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  const timeoutFrag = ` timeout=${h.timeoutMs}ms`;
  return `  [${idx}] ${h.event}${matcherFrag}${timeoutFrag}${flagFrag}\n      cmd: ${previewCommand(h.command)}\n      from: ${h.sourcePath}`;
};

const handleSummary = (hooks: readonly HookSpec[]): SlashResult => {
  if (hooks.length === 0) {
    return {
      kind: 'ok',
      notes: [
        'hooks: 0 loaded',
        '  no hooks.toml at /etc/agent, ~/.config/agent, or <repo>/.agent',
        '  spec: AGENTIC_CLI.md §10',
      ],
    };
  }
  // Counts by event + layer for at-a-glance inventory.
  const byEvent = new Map<HookEvent, number>();
  const byLayer = new Map<HookLayer, number>();
  for (const h of hooks) {
    byEvent.set(h.event, (byEvent.get(h.event) ?? 0) + 1);
    byLayer.set(h.layer, (byLayer.get(h.layer) ?? 0) + 1);
  }
  const lines = [`hooks: ${hooks.length} loaded`];
  // Layers in resolution order (enterprise → user → project)
  // so the reader sees the precedence visually.
  lines.push('  by layer:');
  for (const layer of ALL_LAYERS) {
    const n = byLayer.get(layer) ?? 0;
    if (n > 0) lines.push(`    ${layer}: ${n}`);
  }
  // Events in spec order so a reader scanning down lands on the
  // expected progression (lifecycle → tool → memory → stop).
  lines.push('  by event:');
  for (const event of ALL_EVENTS) {
    const n = byEvent.get(event) ?? 0;
    if (n > 0) lines.push(`    ${event}: ${n}`);
  }
  lines.push("  '/hooks list' for the full list, '/hooks audit' for recent runs");
  return { kind: 'ok', notes: lines };
};

interface ListFilters {
  layer?: HookLayer;
  event?: HookEvent;
}

// Tiny flag parser for `--layer <l> --event <e>`. Rejects unknown
// flags and missing values up front so the operator gets a clean
// error instead of silently-applied bogus filters.
const parseListFlags = (args: readonly string[]): ListFilters | { error: string } => {
  const filters: ListFilters = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--layer') {
      const val = args[i + 1];
      if (val === undefined) return { error: '/hooks list: --layer requires a value' };
      if (!isHookLayer(val)) {
        return {
          error: `/hooks list: unknown layer '${val}' (use: ${ALL_LAYERS.join(', ')})`,
        };
      }
      filters.layer = val;
      i += 1;
    } else if (arg === '--event') {
      const val = args[i + 1];
      if (val === undefined) return { error: '/hooks list: --event requires a value' };
      if (!isHookEvent(val)) {
        return {
          error: `/hooks list: unknown event '${val}' (use one of: ${ALL_EVENTS.join(', ')})`,
        };
      }
      filters.event = val;
      i += 1;
    } else if (arg !== undefined) {
      return { error: `/hooks list: unknown argument '${arg}'` };
    }
  }
  return filters;
};

const handleList = (hooks: readonly HookSpec[], args: readonly string[]): SlashResult => {
  const parsed = parseListFlags(args);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };

  const filtered = hooks.filter((h) => {
    if (parsed.layer !== undefined && h.layer !== parsed.layer) return false;
    if (parsed.event !== undefined && h.event !== parsed.event) return false;
    return true;
  });

  if (filtered.length === 0) {
    const filterDesc = [
      parsed.layer !== undefined ? `layer=${parsed.layer}` : null,
      parsed.event !== undefined ? `event=${parsed.event}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(', ');
    return {
      kind: 'ok',
      notes: [`hooks list: no hooks matched${filterDesc.length > 0 ? ` (${filterDesc})` : ''}`],
    };
  }

  const lines = [`hooks list: ${filtered.length}/${hooks.length}`];
  // Group by layer in resolution order so the reader sees
  // precedence inline. Within a layer we keep insertion order
  // (the resolver's order — same order the dispatcher will iterate).
  for (const layer of ALL_LAYERS) {
    const inLayer = filtered.filter((h) => h.layer === layer);
    if (inLayer.length === 0) continue;
    lines.push(`  ${layer}:`);
    inLayer.forEach((h, i) => {
      lines.push(formatHook(h, i));
    });
  }
  return { kind: 'ok', notes: lines };
};

interface AuditFilters {
  session: boolean;
  event?: HookEvent;
  limit: number;
}

const parseAuditFlags = (args: readonly string[]): AuditFilters | { error: string } => {
  const filters: AuditFilters = { session: false, limit: DEFAULT_AUDIT_LIMIT };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--session') {
      filters.session = true;
    } else if (arg === '--event') {
      const val = args[i + 1];
      if (val === undefined) return { error: '/hooks audit: --event requires a value' };
      if (!isHookEvent(val)) {
        return {
          error: `/hooks audit: unknown event '${val}' (use one of: ${ALL_EVENTS.join(', ')})`,
        };
      }
      filters.event = val;
      i += 1;
    } else if (arg === '--limit') {
      const val = args[i + 1];
      if (val === undefined) return { error: '/hooks audit: --limit requires a value' };
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `/hooks audit: invalid --limit '${val}' (need positive integer)` };
      }
      filters.limit = Math.min(n, MAX_AUDIT_LIMIT);
      i += 1;
    } else if (arg !== undefined) {
      return { error: `/hooks audit: unknown argument '${arg}'` };
    }
  }
  return filters;
};

const formatAuditRow = (row: HookRun): string => {
  // Compact one-liner: outcome, event, source, exit code, duration.
  // Operator queries hook_runs directly for full payload.
  const ts = new Date(row.createdAt).toISOString().replace('T', ' ').replace('Z', '');
  const exitFrag = row.exitCode !== null ? ` exit=${row.exitCode}` : '';
  const toolFrag = row.matchedTool !== null ? ` tool=${row.matchedTool}` : '';
  return `  ${ts} ${row.event} [${row.layer}] outcome=${row.outcome}${exitFrag}${toolFrag} (${row.durationMs}ms)`;
};

const handleAudit = (ctx: SlashContext, args: readonly string[]): SlashResult => {
  const parsed = parseAuditFlags(args);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };

  // --session uses currentSessionId() which can return null between
  // boot and first turn (no session yet). Surface a clean message
  // instead of silently dumping cross-session rows.
  let rows: HookRun[];
  if (parsed.session) {
    const sid = ctx.currentSessionId();
    if (sid === null) {
      return {
        kind: 'ok',
        notes: ['hooks audit: no session yet (run a turn first to populate)'],
      };
    }
    rows = listHookRunsBySession(ctx.db, sid, parsed.limit);
  } else {
    rows = listRecentHookRuns(ctx.db, parsed.limit);
  }
  if (parsed.event !== undefined) {
    const event = parsed.event;
    rows = rows.filter((r) => r.event === event);
  }

  if (rows.length === 0) {
    const scopeFrag = parsed.session ? ' in current session' : '';
    const eventFrag = parsed.event !== undefined ? ` for event ${parsed.event}` : '';
    return {
      kind: 'ok',
      notes: [`hooks audit: no runs${scopeFrag}${eventFrag}`],
    };
  }
  const scopeFrag = parsed.session ? 'this session' : 'recent';
  const lines = [`hooks audit: ${rows.length} run(s) (${scopeFrag})`];
  // Newest first — matches `listRecent…` ordering and the
  // operator's mental model ("what just happened?").
  for (const row of rows) {
    lines.push(formatAuditRow(row));
  }
  return { kind: 'ok', notes: lines };
};

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'inspect loaded hooks and recent runs',
  exec: async (args, ctx) => {
    const hooks = ctx.baseConfig.hooks ?? [];
    const sub = args[0];
    if (sub === undefined) return handleSummary(hooks);
    switch (sub) {
      case 'list':
        return handleList(hooks, args.slice(1));
      case 'audit':
        return handleAudit(ctx, args.slice(1));
      default:
        return {
          kind: 'error',
          message: `/hooks: unknown subcommand '${sub}' (try: list, audit)`,
        };
    }
  },
};
