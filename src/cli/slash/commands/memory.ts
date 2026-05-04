// /memory — manage cross-session memories (MEMORY.md §6.3).
//
// Subcommands shipped in this slice (Tier 1 — read-only inspection):
//   /memory                     — summary line: count + scope breakdown
//   /memory list [scope]        — list entries (scope: user|project|local|shared)
//   /memory show <name> [scope] — print body content
//   /memory audit [--limit N | --name <name>]
//                               — recent memory_events rows
//
// Tier 2 (commit 2 of this slice):
//   /memory delete <name> [scope]  — confirm modal + removeMemory
//   /memory promote shared <name>  — local → shared with scanner
//   /memory demote local <name>    — shared → local
//
// Deferred (future slice):
//   /memory edit, diff, save, expire, promote user
//
// All branches read from the live registry snapshot (`baseConfig.
// memoryRegistry`) and the memory_events audit table directly.
// Read-only subcommands (list / show / audit) emit `info` lines via
// the dispatcher's `notes` channel; mutation subcommands (Tier 2)
// add modal-confirm + audit-row emission paths.

import type {
  MemoryFile,
  MemoryListing,
  MemoryRegistry,
  MemoryScope,
} from '../../../memory/index.ts';
import {
  listMemoryEventsByName,
  listMemoryEventsBySession,
  listRecentMemoryEvents,
} from '../../../storage/index.ts';
import type { MemoryEvent } from '../../../storage/index.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

// ─── scope arg helpers ───────────────────────────────────────────────

// Operator-facing scope names (per spec §6.3 `user|project|local|
// shared`). 'project' is a virtual alias covering both project_*
// scopes; the helper keeps it flat so commands handle one set.
const VALID_LIST_SCOPES = new Set(['user', 'project', 'local', 'shared']);

// 'project' is multi-scope so the show / delete commands (which need
// a single scope) reject it. List accepts the whole set.
const VALID_SINGLE_SCOPES = new Set(['user', 'local', 'shared']);

const memoryScopeFromSingleArg = (arg: string): MemoryScope | null => {
  switch (arg) {
    case 'user':
      return 'user';
    case 'shared':
      return 'project_shared';
    case 'local':
      return 'project_local';
    default:
      return null;
  }
};

// English plural for short messages. Tiny helper, but inlining
// `n === 1 ? 'memory' : 'memories'` mid-template-string reads as
// `memor y`/`memor ies` which is awkward at a glance. Same trick
// /sessions uses for similar copy.
const pluralize = (singular: string, plural: string, n: number): string =>
  n === 1 ? singular : plural;

// ─── /memory list ────────────────────────────────────────────────────

// Mirrors `registry.list({deduplicateByName:true})` (see
// `src/memory/registry.ts`). Re-implemented here because we dedupe
// a pre-filtered subset (e.g. `project` alias = shared+local
// before dedupe). If the registry helper grows additional logic
// (filtering by trust, by triggers, etc.), keep this function in
// sync.
const dedupeByName = (entries: MemoryListing[]): MemoryListing[] => {
  const seen = new Set<string>();
  const out: MemoryListing[] = [];
  for (const l of entries) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    out.push(l);
  }
  return out;
};

const filterByListScope = (
  all: MemoryListing[],
  scope: string | undefined,
): { entries: MemoryListing[] } | { error: string } => {
  if (scope === undefined) {
    // Default: all scopes, dedup so the operator sees the active
    // (eager-section-equivalent) view.
    return { entries: dedupeByName(all) };
  }
  if (!VALID_LIST_SCOPES.has(scope)) {
    return {
      error: `/memory list: invalid scope '${scope}' (expected: user, project, local, shared)`,
    };
  }
  switch (scope) {
    case 'user':
      return { entries: all.filter((l) => l.scope === 'user') };
    case 'shared':
      return { entries: all.filter((l) => l.scope === 'project_shared') };
    case 'local':
      return { entries: all.filter((l) => l.scope === 'project_local') };
    case 'project': {
      const filtered = all.filter(
        (l) => l.scope === 'project_local' || l.scope === 'project_shared',
      );
      return { entries: dedupeByName(filtered) };
    }
    default: {
      // Unreachable: VALID_LIST_SCOPES guards every value above.
      // `as never` enforces exhaustiveness — adding a new scope
      // string to VALID_LIST_SCOPES without a switch case will
      // fail typecheck here, not silently fall through.
      const _exhaust: never = scope as never;
      return { error: `/memory list: invalid scope '${_exhaust}'` };
    }
  }
};

const handleList = (registry: MemoryRegistry, args: string[]): SlashResult => {
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory list: too many args (got ${args.length}, expected 0 or 1 scope)`,
    };
  }
  const scope = args[0];
  const all = registry.list();
  const result = filterByListScope(all, scope);
  if ('error' in result) return { kind: 'error', message: result.error };

  const { entries } = result;
  if (entries.length === 0) {
    if (scope === undefined) return { kind: 'ok', notes: ['no memories registered'] };
    return { kind: 'ok', notes: [`no memories in scope '${scope}'`] };
  }
  const header =
    scope === undefined
      ? `memories (${entries.length}, deduplicated by name):`
      : `memories in scope '${scope}' (${entries.length}):`;
  const lines = [header];
  for (const l of entries) {
    lines.push(`  [${l.scope}] ${l.name} — ${l.entry.hook}`);
  }
  return { kind: 'ok', notes: lines };
};

// ─── /memory show ────────────────────────────────────────────────────

const formatFrontmatter = (file: MemoryFile, scope: MemoryScope): string[] => {
  const fm = file.frontmatter;
  const lines = [
    `${scope}/${fm.name}`,
    `  description: ${fm.description}`,
    `  type:        ${fm.type}`,
    `  source:      ${fm.source}`,
  ];
  if (fm.expires !== undefined) lines.push(`  expires:     ${fm.expires}`);
  if (fm.trust !== undefined) lines.push(`  trust:       ${fm.trust}`);
  if (fm.triggers !== undefined && fm.triggers.length > 0) {
    lines.push(`  triggers:    ${fm.triggers.join(', ')}`);
  }
  return lines;
};

const handleShow = (registry: MemoryRegistry, ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory show: missing name argument' };
  }
  if (args.length > 2) {
    return {
      kind: 'error',
      message: `/memory show: too many args (got ${args.length}, expected name [scope])`,
    };
  }
  const name = args[0] as string;
  const scopeArg = args[1];
  let scope: MemoryScope | undefined;
  if (scopeArg !== undefined) {
    if (!VALID_SINGLE_SCOPES.has(scopeArg)) {
      return {
        kind: 'error',
        message: `/memory show: invalid scope '${scopeArg}' (expected: user, local, shared)`,
      };
    }
    const resolved = memoryScopeFromSingleArg(scopeArg);
    if (resolved === null) {
      return { kind: 'error', message: `/memory show: invalid scope '${scopeArg}'` };
    }
    scope = resolved;
  }

  // /memory show emits a `read` audit row (operator initiated this
  // explicitly — distinct from the system-internal peek pass). Forward
  // the active session id so the row groups with the operator's
  // current session in `/memory audit` queries — without this, every
  // /memory show row landed with session_id NULL because the registry
  // was constructed at bootstrap (before the session existed). cwd
  // from baseConfig matches what the registry was constructed with.
  // currentSessionId returns null between REPL boot and the first
  // turn's session_finished — skip the attribution override in that
  // window rather than overwriting registry's captured value.
  const sessionId = ctx.currentSessionId();
  const result = registry.read(name, {
    ...(scope !== undefined ? { scope } : {}),
    ...(sessionId !== null ? { auditSessionId: sessionId } : {}),
    auditCwd: ctx.baseConfig.cwd,
  });

  if (result.kind === 'unknown') {
    const scopeQual = scope !== undefined ? ` in scope ${scopeArg}` : '';
    return {
      kind: 'error',
      message: `/memory show: no memory named '${name}'${scopeQual}`,
    };
  }
  if (result.kind === 'missing') {
    return {
      kind: 'error',
      message: `/memory show: '${name}' is indexed in scope ${result.scope} but the body file is missing`,
    };
  }
  if (result.kind === 'malformed') {
    return {
      kind: 'error',
      message: `/memory show: '${name}' (scope ${result.scope}) failed to parse: ${result.error}`,
    };
  }

  const lines = formatFrontmatter(result.file, result.scope);
  // Body block separated by an empty line so the operator can
  // visually split frontmatter from content.
  lines.push('');
  if (result.file.body.length === 0) {
    lines.push('  (empty body)');
  } else {
    for (const bodyLine of result.file.body.split('\n')) {
      lines.push(`  ${bodyLine}`);
    }
  }
  return { kind: 'ok', notes: lines };
};

// ─── /memory audit ───────────────────────────────────────────────────

const formatAuditTimestamp = (ms: number): string => {
  // Local clock, second precision (matches /sessions formatter).
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatAuditRow = (e: MemoryEvent): string => {
  const ts = formatAuditTimestamp(e.createdAt);
  // Compact one-liner: timestamp · action · scope/name · source ·
  // session-prefix. session_id may be NULL (lifecycle GC, /memory
  // CLI) — surfaced as `--` so the column stays aligned.
  const session = e.sessionId !== null ? e.sessionId.slice(0, 8) : '--------';
  let detail = '';
  if (e.details !== null) {
    // Render the most operator-relevant fields per action. `stage`
    // and `reason` show up on `refused` rows; `expires` on `created`
    // / `expired`; `path` on `created`. Keep the line scannable —
    // pick a single most-useful detail per row, no full JSON dump.
    const stage = typeof e.details.stage === 'string' ? e.details.stage : null;
    const reason = typeof e.details.reason === 'string' ? e.details.reason : null;
    const expires = typeof e.details.expires === 'string' ? e.details.expires : null;
    if (e.action === 'refused' && stage !== null) {
      detail = ` [${stage}${reason !== null ? `: ${reason}` : ''}]`;
    } else if (e.action === 'expired' && expires !== null) {
      detail = ` [expires ${expires}]`;
    }
  }
  return `  ${ts} · ${e.action.padEnd(8)} · ${e.scope}/${e.memoryName} · ${e.source} · ${session}${detail}`;
};

interface AuditFlags {
  limit: number;
  name: string | null;
  // Spec §6.3 line 449 reads `tabela memory_events da sessão` — the
  // primary surface is session-scoped. Cross-session forensic
  // queries are still useful (operator wants "did this memory ever
  // get refused?"), so we default to session-scoped and offer
  // `--all` as an opt-out. When the operator has no current
  // session (REPL booted, no turn ran), we fall through to
  // cross-session because session-scoped on a NULL session
  // would return zero rows confusingly.
  allSessions: boolean;
}

const parseAuditFlags = (args: string[]): AuditFlags | { error: string } => {
  let limit = 50;
  let name: string | null = null;
  let allSessions = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--limit') {
      const next = args[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return {
          error: `/memory audit: --limit needs a positive integer (got ${next ?? 'nothing'})`,
        };
      }
      limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        return { error: `/memory audit: invalid limit '${next}'` };
      }
      i += 2;
      continue;
    }
    if (a === '--name') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/memory audit: --name needs a memory name' };
      }
      name = next;
      i += 2;
      continue;
    }
    if (a === '--all') {
      // Boolean flag — no value. Opts out of the session filter so
      // the operator gets cross-session rows (forensic queries,
      // bootstrap-time GC events with session_id NULL).
      allSessions = true;
      i += 1;
      continue;
    }
    return {
      error: `/memory audit: unknown flag '${a}' (try --limit N, --name <name>, --all)`,
    };
  }
  return { limit, name, allSessions };
};

const handleAudit = (ctx: SlashContext, args: string[]): SlashResult => {
  const flags = parseAuditFlags(args);
  if ('error' in flags) return { kind: 'error', message: flags.error };

  // Three query paths, ordered by precedence:
  //   1. --name  → listMemoryEventsByName (memory's full history,
  //      cross-session — the most useful slice for "what
  //      happened to X?")
  //   2. --all OR no current session → listRecentMemoryEvents
  //      (cross-session, capped). Falling through here when
  //      sessionId is null avoids surfacing zero rows under a
  //      confusing "current session" header.
  //   3. default → listMemoryEventsBySession scoped to the
  //      operator's current session, matching spec §6.3.
  const sessionId = ctx.currentSessionId();
  let events: MemoryEvent[];
  let scopeNote: string;
  if (flags.name !== null) {
    events = listMemoryEventsByName(ctx.db, flags.name, flags.limit);
    scopeNote = ` for '${flags.name}'`;
  } else if (flags.allSessions || sessionId === null) {
    events = listRecentMemoryEvents(ctx.db, flags.limit);
    scopeNote = flags.allSessions ? ' (all sessions)' : ' (no current session)';
  } else {
    // listMemoryEventsBySession returns ASC; reverse + cap so the
    // operator sees most-recent-first like the other audit
    // surfaces. An ad-hoc reverse here is cheaper than adding a
    // DESC variant to the storage repo for one caller.
    const all = listMemoryEventsBySession(ctx.db, sessionId);
    events = all.slice(-flags.limit).reverse();
    scopeNote = ' (current session)';
  }

  if (events.length === 0) {
    if (flags.name !== null) {
      return { kind: 'ok', notes: [`no audit rows for '${flags.name}'`] };
    }
    if (!flags.allSessions && sessionId !== null) {
      return {
        kind: 'ok',
        notes: ['no memory events in the current session yet (try --all for older rows)'],
      };
    }
    return { kind: 'ok', notes: ['no memory audit rows yet'] };
  }
  const lines = [`recent memory events${scopeNote} (${events.length}, most recent first):`];
  for (const e of events) lines.push(formatAuditRow(e));
  return { kind: 'ok', notes: lines };
};

// ─── /memory summary (no subcommand) ─────────────────────────────────

const handleSummary = (registry: MemoryRegistry): SlashResult => {
  const all = registry.list();
  if (all.length === 0) {
    return {
      kind: 'ok',
      notes: ['no memories registered (use memory_write or operator-edit to add)'],
    };
  }
  let user = 0;
  let shared = 0;
  let local = 0;
  for (const l of all) {
    if (l.scope === 'user') user++;
    else if (l.scope === 'project_shared') shared++;
    else local++;
  }
  const total = registry.count({ deduplicateByName: true });
  return {
    kind: 'ok',
    notes: [
      `${total} active ${pluralize('memory', 'memories', total)} (post-dedup) · raw: ${user} user · ${shared} shared · ${local} local`,
      'subcommands: list [scope] · show <name> [scope] · audit [--limit N | --name <name> | --all]',
    ],
  };
};

// ─── command export ──────────────────────────────────────────────────

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'inspect cross-session memories (list/show/audit)',
  exec: async (args, ctx) => {
    const registry = ctx.baseConfig.memoryRegistry;
    if (registry === undefined) {
      return {
        kind: 'error',
        message: '/memory: memory subsystem not wired in this session',
      };
    }
    const sub = args[0];
    if (sub === undefined) return handleSummary(registry);
    switch (sub) {
      case 'list':
        return handleList(registry, args.slice(1));
      case 'show':
        return handleShow(registry, ctx, args.slice(1));
      case 'audit':
        return handleAudit(ctx, args.slice(1));
      default:
        return {
          kind: 'error',
          message: `/memory: unknown subcommand '${sub}' (try: list, show, audit)`,
        };
    }
  },
};
