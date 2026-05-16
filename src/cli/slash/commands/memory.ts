// /memory — manage cross-session memories (MEMORY.md §6.3).
//
// Subcommands (Tier 1 — read-only inspection):
//   /memory                     — summary line: count + scope breakdown
//   /memory list [scope]        — list entries (scope: user|project|local|shared)
//   /memory show <name> [scope] — print body content
//   /memory audit [--limit N | --name <name>]
//                               — recent memory_events rows
//
// Tier 2:
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

import { readFileSync } from 'node:fs';
import {
  type MemoryFile,
  type MemoryListing,
  type MemoryRegistry,
  type MemoryScope,
  type TombstoneEntry,
  findLatestTombstone,
  isExpired,
  moveMemory,
  parseMemoryFile,
  removeMemory,
  scanForInjection,
  scanForPromotion,
  transitionMemoryState,
} from '../../../memory/index.ts';
import type { DB } from '../../../storage/db.ts';
import {
  listMemoryEventsByName,
  listMemoryEventsBySession,
  listRecentMemoryEvents,
} from '../../../storage/index.ts';
import type { MemoryEvent } from '../../../storage/index.ts';
import type { EvictionMotivo } from '../../../storage/repos/eviction-events.ts';
import {
  DETECTOR_TRIGGERS,
  OPERATOR_DRIVEN_EVIDENCE_MARKER,
  OPERATOR_DRIVEN_TRIGGER,
} from '../../../storage/repos/eviction-events.ts';
import { evictionMetricsSnapshot } from '../../../storage/repos/eviction-metrics.ts';
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

// `expires` parsing + cutoff predicate lives in `src/memory/expires.ts`
// — single source of truth shared with the registry's `list()`
// filter. Earlier shape had a duplicate implementation here; drift
// risk was real (the recent two-step calendar fix had to be applied
// in two places). Import the canonical helper.

// Visual flag rendered as a prefix on the /memory list row.
// Priorities (only one prefix renders, in this order):
//   1. non-active state (`[QUARANTINED — motivo/trigger
//      YYYY-MM-DD]` / `[INVALIDATED — …]` / `[PROPOSED]`) —
//      operator sees lifecycle state, the reason it transitioned,
//      and when, all at a glance per spec MEMORY.md §6.5.2.
//      Motivo + trigger + date come from the most recent
//      `memory_events` row whose action matches the current
//      state (e.g., the last `quarantined` row for a memory
//      currently in `quarantined` state). When no such row
//      exists (legacy entries, hand-edited state without
//      audit pair), the flag falls back to the bare state
//      label so the operator still sees the non-active
//      signal.
//   2. expired (active state + `expires` in the past) —
//      operator notices entries that would be excluded by
//      `includeExpired: false`.
// Both signals together would mean a quarantined-AND-expired
// entry; we prefer the state flag because it's the operator
// action (manual or detector) rather than the calendar fact.

// Format a `memory_events.createdAt` ms epoch as `YYYY-MM-DD` (UTC).
// Matches the spec format MEMORY.md §6.5.2 quotes (`[memory:
// quarantined — verify failed 2026-05-12]`).
const formatEventDateYyyyMmDd = (epochMs: number): string => {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Look up the most recent `memory_events` row whose action matches
// the candidate state and return its motivo + trigger + date for
// the visual flag. Returns null when no matching row exists —
// renderStateFlag falls back to the bare label. Cost: one DB read
// per non-active listing in /memory list. At dozens-of-memories
// scale this is single-digit reads per call.
interface StateFlagDetail {
  motivo: string | null;
  trigger: string | null;
  date: string;
}

const lookupStateDetail = (
  db: DB,
  scope: MemoryScope,
  name: string,
  state: string,
): StateFlagDetail | null => {
  // We don't have a `by-name-and-action` repo helper; the existing
  // `listMemoryEventsByName(db, name, limit)` returns DESC by
  // createdAt. A short scan from the top picks up the first row
  // whose action matches the target state. Cap at 20 — operator-
  // driven transitions are rare relative to read/created events,
  // so the most-recent state transition is almost always within
  // the top few rows.
  const events = listMemoryEventsByName(db, name, 20);
  for (const e of events) {
    if (e.scope !== scope) continue;
    if (e.action !== state) continue;
    const motivo =
      e.details !== null && typeof e.details.motivo === 'string' ? e.details.motivo : null;
    const trigger =
      e.details !== null && typeof e.details.trigger === 'string' ? e.details.trigger : null;
    return { motivo, trigger, date: formatEventDateYyyyMmDd(e.createdAt) };
  }
  return null;
};

const renderStateFlag = (
  state: string,
  expires: string | undefined,
  nowMs: number,
  detail: StateFlagDetail | null,
): string | null => {
  const flagLabel = (label: string): string => {
    if (detail === null) return `[${label}] `;
    // Format: [QUARANTINED — motivo/trigger 2026-05-12]
    // When motivo or trigger is missing (legacy rows / partial
    // details), drop that segment so the flag stays readable.
    const segments: string[] = [];
    if (detail.motivo !== null && detail.trigger !== null) {
      segments.push(`${detail.motivo}/${detail.trigger}`);
    } else if (detail.motivo !== null) {
      segments.push(detail.motivo);
    } else if (detail.trigger !== null) {
      segments.push(detail.trigger);
    }
    segments.push(detail.date);
    return `[${label} — ${segments.join(' ')}] `;
  };
  if (state === 'quarantined') return flagLabel('QUARANTINED');
  if (state === 'invalidated') return flagLabel('INVALIDATED');
  if (state === 'proposed') return flagLabel('PROPOSED');
  if (state === 'active' && isExpired(expires, nowMs)) {
    return `[EXPIRED ${expires}] `;
  }
  return null;
};

const handleList = (registry: MemoryRegistry, ctx: SlashContext, args: string[]): SlashResult => {
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

  // For each listing, peek the body so we can render `state` and
  // `expires`. `peek` is the canonical no-audit read — operator
  // running /memory list isn't reading individual memories, just
  // inspecting metadata, so no `read` event lands. File-missing /
  // malformed cases get a marker (`[ORPHAN]` / `[MALFORMED]`) by
  // intent: this is the operator-facing surface where hand-editing
  // errors should be visible so the operator can fix them. The
  // model-facing surfaces (retrieval memory view, eager-load,
  // `memory_read` tool) filter these out via the state-filter path
  // in `registry.list({ states: ['active'] })`. Operator surface
  // ⇒ show; model surface ⇒ hide — two audiences with opposite
  // needs for the same anomalous data.
  //
  // `nowMs = ctx.now()` flows into renderStateFlag's expiry check
  // below. If a future change routes the list call through
  // `registry.list({ includeExpired: false, nowMs })`, the
  // explicit `nowMs` param is what propagates — the registry's
  // default `Date.now()` would NOT observe `ctx.now` overrides
  // from test fixtures. Keep the explicit threading honest.
  const nowMs = ctx.now();
  for (const l of entries) {
    const peek = registry.peek(l.name, { scope: l.scope });
    if (peek.kind === 'unknown' || peek.kind === 'missing') {
      lines.push(`  [${l.scope}] [ORPHAN] ${l.name} — ${l.entry.hook}`);
      continue;
    }
    if (peek.kind === 'malformed') {
      lines.push(`  [${l.scope}] [MALFORMED] ${l.name} — ${l.entry.hook} (${peek.error})`);
      continue;
    }
    const fm = peek.file.frontmatter;
    const state = fm.state ?? 'active';
    // Non-active states get a DB lookup for motivo+trigger+date —
    // active entries skip the read because there's no flag to
    // enrich. The lookup gates the cost behind the rare path.
    const detail = state !== 'active' ? lookupStateDetail(ctx.db, l.scope, l.name, state) : null;
    const flag = renderStateFlag(state, fm.expires, nowMs, detail);
    const expiresSuffix =
      fm.expires !== undefined && !isExpired(fm.expires, nowMs) ? ` (expires ${fm.expires})` : '';
    const prefix = flag ?? '';
    lines.push(`  [${l.scope}] ${prefix}${l.name} — ${l.entry.hook}${expiresSuffix}`);
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
    // Render the most operator-relevant fields per action. Keep the
    // line scannable — pick a single most-useful detail per row, no
    // full JSON dump.
    //
    // `refused` rows: stage (eviction_protection / eviction_hook /
    // lifecycle_gc / promote_scanner / ...) + reason.
    // `evicted` / `quarantined` / `restored` / `purged` (post-1.3
    // state-machine path): motivo + trigger from the paired
    // eviction_events row.
    // `expired`: kept for backwards compat — pre-1.3 boot GC emitted
    // this action with `expires:`. Phase 2.2 routed boot GC through
    // the state machine so production no longer emits it, but
    // legacy rows in the DB still render.
    const stage = typeof e.details.stage === 'string' ? e.details.stage : null;
    const reason = typeof e.details.reason === 'string' ? e.details.reason : null;
    const expires = typeof e.details.expires === 'string' ? e.details.expires : null;
    const motivo = typeof e.details.motivo === 'string' ? e.details.motivo : null;
    const trigger = typeof e.details.trigger === 'string' ? e.details.trigger : null;
    if (e.action === 'refused' && stage !== null) {
      detail = ` [${stage}${reason !== null ? `: ${reason}` : ''}]`;
    } else if (e.action === 'expired' && expires !== null) {
      detail = ` [expires ${expires}]`;
    } else if (
      (e.action === 'evicted' ||
        e.action === 'quarantined' ||
        e.action === 'restored' ||
        e.action === 'purged' ||
        e.action === 'invalidated') &&
      motivo !== null
    ) {
      detail = trigger !== null ? ` [${motivo}/${trigger}]` : ` [${motivo}]`;
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
  // Optional trigger-source filter. Two forms accepted:
  //   - `--trigger <literal>` — exact match on `details.trigger`
  //     (e.g., `operator_driven`, `verify_failed`, `user_purge`).
  //   - `--trigger operator` / `--trigger detector` — semantic
  //     shortcuts: `operator` matches `operator_driven`;
  //     `detector` matches every auto-detector trigger
  //     (`verify_failed`, `user_override_repeated`,
  //     `conflict_detected`, `trust_revoked`).
  // Forensic operator separates manual transitions (their own
  // `/memory quarantine` / `/memory delete`) from automatic
  // detector firings — load-bearing once Slices 2-5 ship their
  // auto-detectors.
  triggerFilter: string | null;
}

// Set view over the canonical `DETECTOR_TRIGGERS` tuple for O(1)
// lookup in `triggerMatches`. The tuple itself is the single
// source of truth (`eviction-events.ts`); building the Set lazily
// once at module load keeps the tuple → set asymmetry purely
// internal to this consumer.
const DETECTOR_TRIGGER_SET: ReadonlySet<string> = new Set(DETECTOR_TRIGGERS);

const triggerMatches = (eventTrigger: string | null, filter: string): boolean => {
  if (eventTrigger === null) return false;
  if (filter === 'operator') return eventTrigger === OPERATOR_DRIVEN_TRIGGER;
  if (filter === 'detector') return DETECTOR_TRIGGER_SET.has(eventTrigger);
  return eventTrigger === filter;
};

const parseAuditFlags = (args: string[]): AuditFlags | { error: string } => {
  let limit = 50;
  let name: string | null = null;
  let allSessions = false;
  let triggerFilter: string | null = null;
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
    if (a === '--trigger') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return {
          error:
            '/memory audit: --trigger needs a value (literal e.g. operator_driven, or shortcut: operator | detector)',
        };
      }
      if (triggerFilter !== null) {
        return {
          error: `/memory audit: --trigger specified twice (got '${triggerFilter}' then '${next}'); use a single trigger value`,
        };
      }
      triggerFilter = next;
      i += 2;
      continue;
    }
    return {
      error: `/memory audit: unknown flag '${a}' (try --limit N, --name <name>, --all, --trigger <source>)`,
    };
  }
  return { limit, name, allSessions, triggerFilter };
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

  // Trigger filter is applied AFTER load because trigger lives
  // inside the JSONB `details` column — filtering at the repo
  // would need a json_extract index we don't have. In-memory
  // filter over the (already capped) batch is cheap.
  //
  // Note on limit interaction: SQL applies --limit FIRST (most-
  // recent N rows), then trigger filter narrows in memory. If
  // the operator wants "every verify_failed in the session" and
  // there are 100 events with 5 verify_failed scattered through,
  // a default --limit 50 may not reach all 5. The header text
  // shows "X/Y after filter" so the operator notices when the
  // limit was the binding constraint; widening --limit picks up
  // older matches.
  let triggerNote = '';
  if (flags.triggerFilter !== null) {
    const before = events.length;
    events = events.filter((e) => {
      const trig =
        e.details !== null && typeof e.details.trigger === 'string' ? e.details.trigger : null;
      return triggerMatches(trig, flags.triggerFilter as string);
    });
    triggerNote = ` (trigger: ${flags.triggerFilter}, ${events.length}/${before} after --limit, raise --limit to widen)`;
  }

  if (events.length === 0) {
    if (flags.triggerFilter !== null) {
      // Two failure modes share this message: (a) no events at
      // all in scope, (b) events exist but none match the trigger
      // filter. Hint the operator at the second case so they can
      // try the semantic shortcuts (`operator` / `detector`)
      // before assuming the session is empty.
      return {
        kind: 'ok',
        notes: [
          `no audit rows matching --trigger ${flags.triggerFilter}${scopeNote}`,
          '  (try --trigger operator for manual rows, --trigger detector for auto-detector rows)',
        ],
      };
    }
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
  const lines = [
    `recent memory events${scopeNote}${triggerNote} (${events.length}, most recent first):`,
  ];
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
      'subcommands: list · show · audit · delete · promote shared · demote local',
    ],
  };
};

// ─── /memory metrics ─────────────────────────────────────────────────
//
// Spec EVICTION §11 metrics surface. Read-only aggregator over the
// eviction_events table, scoped to substrate='memory'. Operators
// invoke `/memory metrics [--days N]` to see what the eviction
// pipeline did over the window — distribution by motivo, restore
// rate, purge-bypass count, quarantine dwell + escape, protection
// + hook blocks.

const DEFAULT_METRICS_WINDOW_DAYS = 30;

const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const formatMsAsDays = (ms: number): string => {
  const days = ms / (24 * 60 * 60 * 1000);
  return `${days.toFixed(1)}d`;
};

const parseMetricsArgs = (args: string[]): { windowMs: number } | { error: string } => {
  let days = DEFAULT_METRICS_WINDOW_DAYS;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--days') {
      const next = args[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return {
          error: `/memory metrics: --days needs a positive integer (got ${next ?? 'nothing'})`,
        };
      }
      days = Number.parseInt(next, 10);
      if (!Number.isFinite(days) || days <= 0) {
        return { error: `/memory metrics: invalid days '${next}'` };
      }
      i += 2;
      continue;
    }
    return {
      error: `/memory metrics: unknown flag '${a}' (try --days N)`,
    };
  }
  return { windowMs: days * 24 * 60 * 60 * 1000 };
};

const handleMetrics = (ctx: SlashContext, args: string[]): SlashResult => {
  const parsed = parseMetricsArgs(args);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };
  const nowMs = ctx.now();
  const snap = evictionMetricsSnapshot(ctx.db, nowMs, parsed.windowMs);
  const lines: string[] = [`eviction metrics (memory, last ${formatMsAsDays(snap.windowMs)}):`];

  // rate_by_motivo
  if (snap.rateByMotivo.length === 0) {
    lines.push('  rate_by_motivo: no applied evictions in window');
  } else {
    lines.push('  rate_by_motivo:');
    for (const r of snap.rateByMotivo) {
      lines.push(`    ${r.motivo.padEnd(11)} ${r.count}`);
    }
  }

  // restore_rate
  const rr = snap.restoreRate;
  lines.push(
    `  restore_rate: ${rr.restoredCount}/${rr.evictedCount} = ${formatPercent(rr.ratio)} (threshold > 20% ⇒ gate too aggressive)`,
  );

  // purge_irreversible_count
  if (snap.purgeIrreversible.totalCount === 0) {
    lines.push('  purge_irreversible_count: 0 (good)');
  } else {
    const lines2 = snap.purgeIrreversible.breakdown.map((b) => `${b.motivo}=${b.count}`).join(', ');
    lines.push(`  purge_irreversible_count: ${snap.purgeIrreversible.totalCount} (${lines2})`);
  }

  // quarantine.dwell_time + escape_rate
  const q = snap.quarantine;
  if (q.exitedCount === 0) {
    lines.push('  quarantine: no exits in window');
  } else {
    const dwell = q.avgDwellMs !== null ? formatMsAsDays(q.avgDwellMs) : 'n/a';
    lines.push(
      `  quarantine: avg_dwell=${dwell} · escape_rate=${formatPercent(q.escapeRate)} (n=${q.exitedCount})`,
    );
  }

  // protection.cooldown_blocks
  if (snap.protectionBlocks.totalCount === 0) {
    lines.push('  protection_blocks: 0');
  } else {
    const detail = snap.protectionBlocks.byProtection
      .map((p) => `${p.protection}=${p.count}`)
      .join(', ');
    lines.push(`  protection_blocks: ${snap.protectionBlocks.totalCount} (${detail})`);
  }

  // hook.eviction_blocks
  if (snap.hookBlocks.totalCount === 0) {
    lines.push('  hook_blocks: 0');
  } else {
    const detail = snap.hookBlocks.byHook.map((h) => `${h.blockedBy}=${h.count}`).join(', ');
    lines.push(`  hook_blocks: ${snap.hookBlocks.totalCount} (${detail})`);
  }

  return { kind: 'ok', notes: lines };
};

// ─── /memory delete ──────────────────────────────────────────────────
//
// Spec MEMORY.md §6.3 line 441: `/memory delete <name>   # com confirmação`.
// Reads the body for the modal preview (so the operator sees what's
// about to disappear), confirms via the generic memory-action modal,
// then calls `removeMemory` and emits a `deleted` audit event. Body
// is loaded via `peek` to avoid emitting a `read` row for what's
// effectively a system-internal pre-delete display.

const handleDelete = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory delete: missing name argument' };
  }
  if (args.length > 2) {
    return {
      kind: 'error',
      message: `/memory delete: too many args (got ${args.length}, expected name [scope])`,
    };
  }
  const name = args[0] as string;
  const scopeArg = args[1];
  let scope: MemoryScope | undefined;
  if (scopeArg !== undefined) {
    if (!VALID_SINGLE_SCOPES.has(scopeArg)) {
      return {
        kind: 'error',
        message: `/memory delete: invalid scope '${scopeArg}' (expected: user, local, shared)`,
      };
    }
    scope = memoryScopeFromSingleArg(scopeArg) ?? undefined;
  }

  // Locate the memory; with no scope, registry walks precedence so
  // the operator's `name` resolves to the most-specific scope. peek
  // (no audit) since this is a pre-delete probe, not an operator-
  // initiated read.
  const peek = scope !== undefined ? registry.peek(name, { scope }) : registry.peek(name);
  if (peek.kind === 'unknown') {
    const scopeQual = scope !== undefined ? ` in scope ${scopeArg}` : '';
    return {
      kind: 'error',
      message: `/memory delete: no memory named '${name}'${scopeQual}`,
    };
  }
  if (peek.kind === 'malformed') {
    // Body parse failure shouldn't block deletion — the operator
    // probably wants to remove a corrupted entry. Show an empty
    // preview and proceed; remove path doesn't care about content.
    // Source unknown when the body can't parse — fall back to
    // 'imported' for the audit row (most neutral provenance
    // marker). Force the legacy route — transitionMemoryState
    // can't read state from a body it can't parse.
    return await confirmAndDelete(
      ctx,
      registry,
      peek.scope,
      name,
      [`(body parse failed: ${peek.error})`],
      'imported',
      'legacy',
    );
  }
  if (peek.kind === 'missing') {
    // Index entry exists, body file is gone. Confirm anyway —
    // operator's intent is to clean up the dangling entry. Source
    // unrecoverable; same 'imported' fallback as malformed. Force
    // the legacy route — tombstone semantics need a body to move.
    return await confirmAndDelete(
      ctx,
      registry,
      peek.scope,
      name,
      ['(body file missing — only the index entry will be cleared)'],
      'imported',
      'legacy',
    );
  }

  // Happy path: real source from frontmatter so audit groups with
  // the memory's history (created/refused/etc rows carry the
  // same provenance). State machine routing only fires for the
  // `active` state; quarantined/invalidated/evicted use legacy
  // removeMemory because tombstone semantics don't add value when
  // the entry is already off the active path.
  const state = peek.file.frontmatter.state ?? 'active';
  return await confirmAndDelete(
    ctx,
    registry,
    peek.scope,
    name,
    peek.file.body.split('\n'),
    peek.file.frontmatter.source,
    state === 'active' ? 'state-machine' : 'legacy',
  );
};

// Routing choice for /memory delete. Drives whether the slash
// goes through transitionMemoryState (tombstone + audit pair +
// restorable via /memory restore) or falls through to the legacy
// removeMemory primitive (other states + corrupted / missing
// files where tombstone semantics don't apply). Explicit param so
// the caller declares intent — earlier shape used `currentState:
// MemoryState` as a routing flag with fake values, which a
// future refactor reading the field would mis-branch on.
type DeleteRoute = 'state-machine' | 'legacy';

const confirmAndDelete = async (
  ctx: SlashContext,
  registry: MemoryRegistry,
  scope: MemoryScope,
  name: string,
  preview: string[],
  source: string,
  route: DeleteRoute,
): Promise<SlashResult> => {
  const answer = await ctx.modalManager.askMemoryAction({
    action: 'delete',
    title: 'Delete memory',
    subject: `${scope}/${name}`,
    preview,
    question: 'Permanently delete this memory? (file + index entry)',
  });
  if (answer !== 'yes') {
    return {
      kind: 'ok',
      notes: [`/memory delete cancelled (operator answered ${answer})`],
    };
  }

  // Resolve roots from cwd so we can call the lifecycle primitive.
  // The registry was constructed from the same roots at bootstrap;
  // we re-derive here rather than threading roots through
  // SlashContext (every other slash command would gain a field for
  // one caller).
  const roots = registry.roots;

  // State-machine route: through transitionMemoryState so the
  // body moves to .tombstones/ (operator can /memory restore it
  // within the retention window) and the eviction_events +
  // memory_events audit pair lands. State machine forbids
  // active→evicted direct (EVICTION §4.1 lists active→quarantined
  // and quarantined→evicted as the only paths into evicted from
  // an active source). We do a 2-step transition with motivo
  // `low_roi` and trigger `user_purge` — the trigger correctly
  // attributes the source while the motivo is the closest state-
  // machine-legal label. Follow-up: spec EVICTION §4.1 may grow
  // an explicit `user_purge` motivo on active→evicted to clean
  // this attribution.
  if (route === 'state-machine') {
    return await deleteViaTransition(ctx, registry, roots, scope, name);
  }

  // Other states / dangling entries: keep the legacy removeMemory
  // primitive. tombstone path doesn't apply (the file is already
  // absent / malformed; index-only cleanup is what the operator
  // wants). Future slice can route quarantined/invalidated/evicted
  // through transitionMemoryState too — out of scope here because
  // the volume is tiny and the legacy path is well-tested.
  const result = removeMemory({ roots, scope, name });
  if (result.kind === 'sandbox_violation') {
    registry.recordEvent({
      action: 'refused',
      scope,
      memoryName: name,
      source: source as 'user_explicit' | 'inferred' | 'imported',
      details: { stage: 'slash_delete', reason: result.reason },
      auditCwd: ctx.baseConfig.cwd,
      ...attribution(ctx),
    });
    return { kind: 'error', message: `/memory delete: sandbox violation: ${result.reason}` };
  }
  if (result.kind === 'io_error') {
    registry.recordEvent({
      action: 'refused',
      scope,
      memoryName: name,
      source: source as 'user_explicit' | 'inferred' | 'imported',
      details: { stage: 'slash_delete', reason: result.reason },
      auditCwd: ctx.baseConfig.cwd,
      ...attribution(ctx),
    });
    return { kind: 'error', message: `/memory delete: ${result.reason}` };
  }
  if (result.kind === 'unknown') {
    return { kind: 'error', message: `/memory delete: no traces of '${name}' on disk` };
  }

  // Successful removal. Audit `deleted` with the real frontmatter
  // source so the row groups with the memory's history. Refresh
  // the registry so subsequent /memory list calls reflect the
  // delete without explicit reload.
  registry.recordEvent({
    action: 'deleted',
    scope,
    memoryName: name,
    source: source as 'user_explicit' | 'inferred' | 'imported',
    details: { bodyPath: result.bodyPath },
    auditCwd: ctx.baseConfig.cwd,
    ...attribution(ctx),
  });
  registry.reload();
  return { kind: 'ok', notes: [`deleted ${scope}/${name}`] };
};

// Memory tombstone retention per EVICTION §7.1 — operator can
// /memory restore a deleted entry within this window before the
// GC sweep materializes evicted→purged. Set in ms so we can pass
// it directly as `purgeAt = now + MEMORY_TOMBSTONE_RETENTION_MS`.
const MEMORY_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Two-step transition for the active-state delete path. Returns
// a SlashResult mirroring the legacy code's shape — error on the
// first sub-transition failure (we never partially evict).
const deleteViaTransition = async (
  ctx: SlashContext,
  registry: MemoryRegistry,
  roots: MemoryRegistry['roots'],
  scope: MemoryScope,
  name: string,
): Promise<SlashResult> => {
  const sessionId = ctx.currentSessionId();
  // Wall-clock source: thread ctx.now through to transitionMemoryState
  // so the two back-to-back evictions get monotonically increasing
  // recorded_at values (deterministic test fixtures; production
  // path is still Date.now-shaped). Without this, two transitions
  // in the same ms tiebreak by rowid (M3) — deterministic but
  // less semantically meaningful than `quarantined < evicted`.
  //
  // fireHook is threaded when the REPL wired a dispatcher. Eviction
  // hook can refuse the transition (security policy, compliance);
  // the resulting `blocked_by_hook` audit lands without disk
  // change. Slash commands run outside a session (no session id
  // until first turn) → the helper itself skips hook fire when
  // sessionId is null; we pass dispatchHooks regardless and let
  // transitionMemoryState gate it.
  const transitionInput = {
    db: ctx.db,
    registry,
    roots,
    scope,
    name,
    motivo: 'low_roi' as const,
    trigger: 'user_purge',
    actor: 'user' as const,
    // Closest-fit motivo `low_roi` doesn't represent the real
    // semantics (operator command, not ROI). The
    // `_operator_driven: true` marker tells the evidence
    // validator to bypass the canonical low_roi shape check —
    // forensic consumers filtering for "real" ROI evidence
    // exclude these rows by predicate. Spec amendment to admit
    // `user_purge` on active→quarantined / quarantined→evicted
    // would obviate the marker.
    evidence: { [OPERATOR_DRIVEN_EVIDENCE_MARKER]: true, source: 'slash_delete' },
    ...(sessionId !== null ? { sessionId } : {}),
    cwd: ctx.baseConfig.cwd,
    now: ctx.now,
    ...(ctx.dispatchHooks !== undefined ? { fireHook: ctx.dispatchHooks } : {}),
  };

  // 1) active → quarantined.
  const r1 = await transitionMemoryState({ ...transitionInput, toState: 'quarantined' });
  if (r1.kind !== 'applied') {
    return mapTransitionFailure('/memory delete (active→quarantined)', r1);
  }

  // 2) quarantined → evicted. purge_at materializes the retention
  // window: GC sweep (future slice) will move evicted→purged
  // when recorded_at + retention <= now. Without this, the
  // eviction lands with purge_at=NULL and `listEvictedDueForPurge`
  // never sees it — tombstones would accumulate without bound.
  const r2 = await transitionMemoryState({
    ...transitionInput,
    toState: 'evicted',
    purgeAt: ctx.now() + MEMORY_TOMBSTONE_RETENTION_MS,
  });
  if (r2.kind !== 'applied') {
    // Compensate step 1. Step 1 already moved the memory to
    // `quarantined`; without rollback, a step-2 failure (e.g., the
    // Eviction hook blocking only the to_state='evicted' step)
    // leaves the operator with a "delete failed" message AND a
    // quarantined memory — a partial state change that doesn't
    // match the command's surface. Roll back to `active` so the
    // command's reported failure matches the on-disk state.
    //
    // The rollback skips fireHook deliberately: the same Eviction
    // chain just refused step 2; firing it again on the inverse
    // transition would either block (leaving the memory stuck in
    // quarantined) or run policy that wasn't authored to gate
    // resurrections. A distinct trigger (`delete_rollback`)
    // distinguishes the row in forensic queries.
    //
    // When the rollback itself fails (rare — `quarantined → active`
    // is permissive in the state machine), we surface BOTH the
    // original error and the orphaned state so the operator can
    // recover via `/memory restore`.
    const { fireHook: _omit, ...rollbackInput } = transitionInput;
    const rollback = await transitionMemoryState({
      ...rollbackInput,
      toState: 'active',
      trigger: 'delete_rollback',
    });
    registry.reload();
    const base = mapTransitionFailure('/memory delete (quarantined→evicted)', r2);
    if (rollback.kind !== 'applied' && base.kind === 'error') {
      return {
        kind: 'error',
        message: `${base.message}; rollback to 'active' also failed (memory remains in 'quarantined' — recover via /memory restore)`,
      };
    }
    return base;
  }

  registry.reload();
  // Lead with "deleted" so the operator-facing copy stays
  // recognizable across the lifecycle refactor; the parenthetical
  // explains the actual mechanism (tombstone instead of unlink)
  // so the operator knows /memory restore is now available.
  return {
    kind: 'ok',
    notes: [
      `deleted ${scope}/${name} (moved to .tombstones/; restorable via /memory restore until retention window expires)`,
    ],
  };
};

const mapTransitionFailure = (
  prefix: string,
  result: {
    kind: string;
    reason?: string | null;
    tombstonePath?: string;
    protection?: string;
  },
): SlashResult => {
  if (result.kind === 'unknown') {
    return { kind: 'error', message: `${prefix}: memory not found` };
  }
  if (result.kind === 'illegal_transition') {
    return { kind: 'error', message: `${prefix}: ${result.reason ?? 'illegal state transition'}` };
  }
  if (result.kind === 'invalid_evidence') {
    return {
      kind: 'error',
      message: `${prefix}: ${result.reason ?? 'evidence shape invalid for motivo'}`,
    };
  }
  if (result.kind === 'blocked_by_protection') {
    // Operator-initiated paths (`/memory delete`, `/memory
    // restore`) set actor='user' which already bypasses
    // protection gates in transitionMemoryState. Reaching this
    // branch means the slash flow forgot the bypass OR a future
    // caller produced a protection-blocked outcome that needs
    // operator-facing copy. Surface the protection name + reason
    // so the operator understands what's blocking.
    return {
      kind: 'error',
      message: `${prefix}: blocked by protection '${result.protection ?? 'unknown'}': ${result.reason ?? 'unknown'}`,
    };
  }
  if (result.kind === 'blocked_by_hook') {
    return { kind: 'error', message: `${prefix}: blocked by Eviction hook` };
  }
  if (result.kind === 'audit_drift') {
    // The disk transition completed but the audit trail is
    // missing. Surface both facts so the operator understands the
    // file did move (and may be restorable from .tombstones/)
    // even though the eviction trail is incomplete. Avoid the
    // misleading "delete failed" copy that io_error would render.
    const tombstoneHint =
      result.tombstonePath !== undefined ? ` (body at ${result.tombstonePath})` : '';
    return {
      kind: 'error',
      message: `${prefix}: audit drift — disk transition completed but eviction_events insert failed${tombstoneHint}: ${result.reason ?? 'unknown'}`,
    };
  }
  if (result.kind === 'io_error') {
    return { kind: 'error', message: `${prefix}: ${result.reason ?? 'i/o error'}` };
  }
  return { kind: 'error', message: `${prefix}: unexpected outcome '${result.kind}'` };
};

// Audit-attribution spread helper. SlashContext exposes
// currentSessionId() — null between boot and first turn — so the
// caller-side spread keeps the recordEvent input narrow.
const attribution = (ctx: SlashContext): { auditSessionId?: string } => {
  const sid = ctx.currentSessionId();
  return sid !== null ? { auditSessionId: sid } : {};
};

// ─── /memory restore ─────────────────────────────────────────────────
//
// Spec MEMORY.md §6.5.5: bring an evicted memory back into active
// rotation by reading the latest tombstone and transitioning
// `evicted → active`. Operator confirms via the same memory-action
// modal /memory delete uses (action='restore').
//
// Spec literally calls for `state: proposed` (re-admission gate)
// rather than `active`. We take the state-machine canonical path
// (EVICTION §4.1: `evicted → active` is the only restore
// transition listed) because: (a) the operator typed `/memory
// restore` — a re-admission modal would be redundant; (b)
// LEGAL_TRANSITIONS doesn't admit `evicted → proposed`; and
// (c) `proposed` would force a parallel admission gate
// subsystem that doesn't exist today. Spec MEMORY §6.5.5 vs
// EVICTION §4.1 is a documented spec inconsistency; reconciling
// would need a spec PR. Trade-off accepted in this slice.

// Search every scope for the latest tombstone matching `name`.
// Returns the result discriminated three ways: `found` when
// exactly one scope holds a tombstone, `none` when no scope does,
// and `ambiguous` when two or more scopes hold tombstones for the
// same name — operator MUST specify `--scope` in that case. Earlier
// shape silently picked the first scope in precedence order; for
// an evicted name that exists in multiple scopes with distinct
// content, that meant `/memory restore <name>` resurrected the
// wrong scope's body without any operator notice.
type FindTombstoneResult =
  | { kind: 'found'; scope: MemoryScope; tombstone: TombstoneEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; scopes: MemoryScope[] };

const findTombstoneInAnyScope = (registry: MemoryRegistry, name: string): FindTombstoneResult => {
  const roots = registry.roots;
  const scopes: MemoryScope[] = ['project_local', 'project_shared', 'user'];
  const hits: { scope: MemoryScope; tombstone: TombstoneEntry }[] = [];
  for (const scope of scopes) {
    const t = findLatestTombstone(roots, scope, name);
    if (t !== null) hits.push({ scope, tombstone: t });
  }
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) {
    const only = hits[0] as { scope: MemoryScope; tombstone: TombstoneEntry };
    return { kind: 'found', scope: only.scope, tombstone: only.tombstone };
  }
  return { kind: 'ambiguous', scopes: hits.map((h) => h.scope) };
};

// ─── /memory quarantine ───────────────────────────────────────────────
//
// Operator-driven `active → quarantined` transition. The 4 automatic
// detectors spec'd in MEMORY.md §6.5.2 (`verify_failed`,
// `user_override_repeated`, `conflict_detected`, `trust_revoked`)
// are tracked in `docs/TODO.md` (Slice 0+). This slash command is
// the manual escape hatch — operator can drive a quarantine when
// they've spotted a problem the detectors don't yet catch. Same
// `transitionMemoryState` substrate the detectors will use once
// shipped; the trigger marker (`operator_driven`) distinguishes
// manual from automatic in forensic queries.
//
// Args: `<name> --motivo <kind> [--evidence "..."] [--scope <s>]`.
// Motivo MUST be one spec admits for active→quarantined per
// EVICTION.md §4.1 + §5.1: conflict / shift / security / low_roi
// / irrelevant. (`quota` / `expired` / `user_purge` are real
// motivos but not applicable to active→quarantined as a manual
// verb; they're terminal-side or cross-substrate.)

// Spec-admissible motivos for `active → quarantined` per
// EVICTION.md §4.1 table. The state machine (LEGAL_TRANSITIONS in
// eviction-events.ts:155) refuses any other motivo with
// `illegal_transition`; refusing them at the slash boundary
// surfaces a clearer operator error than leaking the state-machine
// vocabulary.
//
// Note on spec conflict: MEMORY.md §6.5.2 lists `verify_failed →
// motivo: shift` as a quarantine trigger, but EVICTION.md §4.1 only
// admits `conflict` + `low_roi` for active→quarantined. The two
// specs are inconsistent; the state machine is authoritative.
// Slice 2 (`verify_failed` detector) will need a spec amendment OR
// will emit `motivo: conflict` with a trigger that disambiguates
// (the same trigger marker pattern this slash uses for operator
// commands).
const VALID_QUARANTINE_MOTIVOS: ReadonlySet<EvictionMotivo> = new Set(['conflict', 'low_roi']);

const isQuarantineMotivo = (s: string): s is EvictionMotivo =>
  VALID_QUARANTINE_MOTIVOS.has(s as EvictionMotivo);

const handleQuarantine = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  // Two-pass arg parse: positional `name` + flag pairs.
  // `--motivo <kind>` is required; `--evidence "..."` and
  // `--scope <s>` are optional. Unknown flags are refused so a
  // typo doesn't silently take the default code path.
  let name: string | undefined;
  let motivoArg: string | undefined;
  let evidenceText: string | undefined;
  let scopeArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--motivo') {
      motivoArg = args[i + 1];
      i += 1;
      continue;
    }
    if (a === '--evidence') {
      // No hard length cap today. The note is JSON-encoded and
      // scrub-redacted before landing in eviction_events.evidence_json
      // (medium-sensitivity per AUDIT.md §1). Operator-friendly soft
      // cap: keep notes under ~500 chars so /memory audit + audit
      // dump remain scannable. Spec EVICTION §6.1 doesn't mandate a
      // max; a future tightening can land here when a real abuse
      // pattern shows up.
      evidenceText = args[i + 1];
      i += 1;
      continue;
    }
    if (a === '--scope') {
      scopeArg = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith('--')) {
      return {
        kind: 'error',
        message: `/memory quarantine: unknown flag '${a}' (try --motivo, --evidence, --scope)`,
      };
    }
    if (name === undefined) {
      name = a;
      continue;
    }
    return {
      kind: 'error',
      message: `/memory quarantine: too many positional args (got '${a}' after name '${name}')`,
    };
  }

  if (name === undefined) {
    return {
      kind: 'error',
      message:
        '/memory quarantine: missing name (usage: /memory quarantine <name> --motivo <kind> [--evidence "..."] [--scope <s>])',
    };
  }
  if (motivoArg === undefined) {
    return {
      kind: 'error',
      message: `/memory quarantine: --motivo is required (one of: ${[...VALID_QUARANTINE_MOTIVOS].join(', ')})`,
    };
  }
  if (!isQuarantineMotivo(motivoArg)) {
    return {
      kind: 'error',
      message: `/memory quarantine: invalid motivo '${motivoArg}' (expected: ${[...VALID_QUARANTINE_MOTIVOS].join(', ')})`,
    };
  }
  const motivo: EvictionMotivo = motivoArg;

  let scope: MemoryScope | undefined;
  if (scopeArg !== undefined) {
    if (!VALID_SINGLE_SCOPES.has(scopeArg)) {
      return {
        kind: 'error',
        message: `/memory quarantine: invalid scope '${scopeArg}' (expected: user, local, shared)`,
      };
    }
    scope = memoryScopeFromSingleArg(scopeArg) ?? undefined;
  }

  // Locate the memory. peek (no audit) — this is a pre-action
  // probe, not an operator-initiated read.
  const peek = scope !== undefined ? registry.peek(name, { scope }) : registry.peek(name);
  if (peek.kind === 'unknown') {
    const scopeQual = scope !== undefined ? ` in scope ${scopeArg}` : '';
    return {
      kind: 'error',
      message: `/memory quarantine: no memory named '${name}'${scopeQual}`,
    };
  }
  if (peek.kind === 'missing') {
    return {
      kind: 'error',
      message: `/memory quarantine: '${name}' body file is missing — use /memory delete instead`,
    };
  }
  if (peek.kind === 'malformed') {
    return {
      kind: 'error',
      message: `/memory quarantine: '${name}' frontmatter is malformed (${peek.error}) — fix the file or use /memory delete`,
    };
  }

  const currentState = peek.file.frontmatter.state ?? 'active';
  if (currentState !== 'active') {
    return {
      kind: 'error',
      message: `/memory quarantine: '${name}' is already in state '${currentState}' (only active memories can be quarantined via this command)`,
    };
  }

  // Modal preview + confirm. Shows motivo, current state, and the
  // operator's evidence note so they double-check before committing
  // the transition.
  const preview = [
    `motivo:  ${motivo}`,
    `state:   ${currentState} → quarantined`,
    evidenceText !== undefined ? `evidence: ${evidenceText}` : '(no evidence note supplied)',
    `scope:   ${peek.scope}`,
  ];
  const answer = await ctx.modalManager.askMemoryAction({
    action: 'quarantine',
    title: 'Quarantine memory',
    subject: `${peek.scope}/${name}`,
    preview,
    question:
      'Quarantine this memory? It stays on disk with a ranking penalty until restored or evicted.',
  });
  if (answer !== 'yes') {
    return {
      kind: 'ok',
      notes: [`/memory quarantine cancelled (operator answered ${answer})`],
    };
  }

  // Transition via the substrate. `trigger: 'operator_driven'` is
  // the canonical attribution for slash-driven transitions —
  // forensic queries filter on it to distinguish manual from
  // detector-driven. The OPERATOR_DRIVEN_EVIDENCE_MARKER on the
  // payload also bypasses the per-motivo evidence schema (the
  // operator's note is unstructured by nature).
  const sessionId = ctx.currentSessionId();
  const evidencePayload: Record<string, unknown> = {
    [OPERATOR_DRIVEN_EVIDENCE_MARKER]: true,
    source: 'slash_quarantine',
  };
  if (evidenceText !== undefined) {
    evidencePayload.note = evidenceText;
  }

  const result = await transitionMemoryState({
    db: ctx.db,
    registry,
    roots: registry.roots,
    scope: peek.scope,
    name,
    toState: 'quarantined',
    motivo,
    trigger: OPERATOR_DRIVEN_TRIGGER,
    actor: 'user',
    evidence: evidencePayload,
    ...(sessionId !== null ? { sessionId } : {}),
    cwd: ctx.baseConfig.cwd,
    now: ctx.now,
    ...(ctx.dispatchHooks !== undefined ? { fireHook: ctx.dispatchHooks } : {}),
  });

  if (result.kind !== 'applied') {
    return mapTransitionFailure('/memory quarantine', result);
  }

  registry.reload();
  return {
    kind: 'ok',
    notes: [
      `quarantined ${peek.scope}/${name}`,
      `  motivo: ${motivo}`,
      `  trigger: ${OPERATOR_DRIVEN_TRIGGER}`,
      evidenceText !== undefined ? `  evidence: ${evidenceText}` : '',
      'use /memory restore to bring it back; /memory delete to fully evict',
    ].filter((l) => l.length > 0),
  };
};

const handleRestore = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory restore: missing name argument' };
  }
  if (args.length > 2) {
    return {
      kind: 'error',
      message: `/memory restore: too many args (got ${args.length}, expected name [scope])`,
    };
  }
  const name = args[0] as string;
  const scopeArg = args[1];

  // Resolve target scope. With scope arg, lookup is pinned. Without
  // a scope arg, walk every scope and require an unambiguous hit
  // — two scopes with tombstones for the same name MUST be
  // disambiguated by the operator (silently picking precedence
  // order would restore the wrong body when scopes diverge).
  let target: { scope: MemoryScope; tombstone: TombstoneEntry };
  if (scopeArg !== undefined) {
    if (!VALID_SINGLE_SCOPES.has(scopeArg)) {
      return {
        kind: 'error',
        message: `/memory restore: invalid scope '${scopeArg}' (expected: user, local, shared)`,
      };
    }
    const scope = memoryScopeFromSingleArg(scopeArg);
    if (scope === null) {
      return { kind: 'error', message: `/memory restore: invalid scope '${scopeArg}'` };
    }
    const tomb = findLatestTombstone(registry.roots, scope, name);
    if (tomb === null) {
      return {
        kind: 'error',
        message: `/memory restore: no tombstone found for '${name}' in scope ${scopeArg}`,
      };
    }
    target = { scope, tombstone: tomb };
  } else {
    const lookup = findTombstoneInAnyScope(registry, name);
    if (lookup.kind === 'none') {
      return {
        kind: 'error',
        message: `/memory restore: no tombstone found for '${name}'`,
      };
    }
    if (lookup.kind === 'ambiguous') {
      // Translate internal scope names back to operator vocabulary
      // for the error message (project_local → local, etc.).
      const opScopes = lookup.scopes
        .map((s) => (s === 'user' ? 'user' : s === 'project_local' ? 'local' : 'shared'))
        .join(', ');
      return {
        kind: 'error',
        message: `/memory restore: '${name}' has tombstones in multiple scopes (${opScopes}); specify scope explicitly (e.g. /memory restore ${name} ${(lookup.scopes[0] as MemoryScope) === 'user' ? 'user' : (lookup.scopes[0] as MemoryScope) === 'project_local' ? 'local' : 'shared'})`,
      };
    }
    target = { scope: lookup.scope, tombstone: lookup.tombstone };
  }

  // Build preview from the tombstone body. Reading the tombstone
  // here is a probe — no audit row emitted; transitionMemoryState
  // re-reads on the apply path and emits the canonical 'restored'
  // memory_events row.
  let preview: string[];
  try {
    const raw = readFileSync(target.tombstone.path, 'utf-8');
    const file = parseMemoryFile(raw);
    preview = file.body.split('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      message: `/memory restore: failed to read tombstone (${msg})`,
    };
  }

  const answer = await ctx.modalManager.askMemoryAction({
    action: 'restore',
    title: 'Restore memory',
    subject: `${target.scope}/${name}`,
    preview,
    question: 'Restore this memory from .tombstones/ back to active?',
  });
  if (answer !== 'yes') {
    return {
      kind: 'ok',
      notes: [`/memory restore cancelled (operator answered ${answer})`],
    };
  }

  const sessionId = ctx.currentSessionId();
  const result = await transitionMemoryState({
    db: ctx.db,
    registry,
    roots: registry.roots,
    scope: target.scope,
    name,
    toState: 'active',
    // `evicted → active` admits any motivo per EVICTION §4.1.
    // 'irrelevant' is the most neutral label — the original
    // eviction reason no longer applies (the operator decided).
    motivo: 'irrelevant',
    trigger: 'manual',
    actor: 'user',
    // `evicted → active` admits any motivo; closest-fit
    // `irrelevant` carries operator-driven marker so forensic
    // queries filtering for real "usage_rate=0 over N=20"
    // irrelevant evidence exclude restore rows. The
    // `_operator_driven: true` marker bypasses the schema's
    // required-fields check at the repo level.
    evidence: { [OPERATOR_DRIVEN_EVIDENCE_MARKER]: true, source: 'slash_restore' },
    ...(sessionId !== null ? { sessionId } : {}),
    cwd: ctx.baseConfig.cwd,
    now: ctx.now,
    // Eviction hook chain gates restore the same way it gates
    // delete — a security policy that allows eviction but
    // refuses restore (e.g. quarantine-mandatory) needs the hook
    // to see the `evicted → active` payload.
    ...(ctx.dispatchHooks !== undefined ? { fireHook: ctx.dispatchHooks } : {}),
  });

  if (result.kind !== 'applied') {
    return mapTransitionFailure('/memory restore', result);
  }

  registry.reload();
  return {
    kind: 'ok',
    notes: [`restored ${target.scope}/${name} (from tombstone ts=${target.tombstone.ts})`],
  };
};

// ─── /memory promote shared ──────────────────────────────────────────
//
// Spec MEMORY.md §5.4: project_local → project_shared with an
// additional scanner (path traversal, secret patterns, injection
// heuristic, 200-line cap). Modal-confirm precedes the move; on
// accept, `moveMemory` writes target + removes source. Audit
// `promoted` event with from/to scopes in details.

const handlePromote = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  // Spec §6.3 line 445 spells the syntax `promote shared <name>`.
  // Strict — reject `promote <name>` (missing target) and other
  // targets to keep parsing unambiguous.
  if (args.length !== 2 || args[0] !== 'shared') {
    return {
      kind: 'error',
      message: '/memory promote: syntax is `promote shared <name>` (only shared target supported)',
    };
  }
  const name = args[1] as string;

  // Locate the memory in project_local. peek so the audit table
  // doesn't grow a `read` row for what's effectively a pre-promote
  // probe.
  const peek = registry.peek(name, { scope: 'project_local' });
  if (peek.kind !== 'present') {
    return {
      kind: 'error',
      message: `/memory promote: '${name}' not found in project_local (only local memories can be promoted)`,
    };
  }

  // Spec §5.4 additional scanner. Two passes:
  //   1. Body via `scanForPromotion` — full superset (injection +
  //      secrets + path-traversal + 200-line cap).
  //   2. Description via `scanForInjection` — same pass
  //      memory_write runs on description (line 311-ish in the
  //      tool). The description is single-line and capped by
  //      `validateDescription` so the line-count + path-traversal
  //      branches of `scanForPromotion` don't add value here, but
  //      the injection + secret checks DO: the description is
  //      copied verbatim into `project_shared/MEMORY.md` as the
  //      hook text that future sessions load eagerly. An operator
  //      who hand-edits a local memory's description after
  //      creation could inject prompt-control phrases through
  //      that path; without this scan, promotion would silently
  //      ship them to the team's shared context.
  for (const [field, text, scanner] of [
    ['body', peek.file.body, scanForPromotion] as const,
    ['description', peek.file.frontmatter.description, scanForInjection] as const,
  ]) {
    const scan = scanner(text);
    if (scan.ok) continue;
    registry.recordEvent({
      action: 'refused',
      scope: 'project_local',
      memoryName: name,
      source: peek.file.frontmatter.source,
      details: { stage: 'promote_scanner', field, reason: scan.reason ?? 'unknown' },
      auditCwd: ctx.baseConfig.cwd,
      ...attribution(ctx),
    });
    return {
      kind: 'error',
      message: `/memory promote: scanner blocked promotion on ${field} (${scan.reason ?? 'unknown'})`,
    };
  }

  const answer = await ctx.modalManager.askMemoryAction({
    action: 'promote',
    title: 'Promote memory to shared',
    subject: `project_local/${name} → project_shared/${name}`,
    preview: [
      'Promoting to shared makes this memory visible to the whole team',
      'on next pull. The body lands in `.agent/memory/shared/` as a',
      'tracked git change — no auto-commit; you commit manually.',
      '',
      ...peek.file.body.split('\n'),
    ],
    question: 'Promote to project_shared?',
  });
  if (answer !== 'yes') {
    return {
      kind: 'ok',
      notes: [`/memory promote cancelled (operator answered ${answer})`],
    };
  }

  const roots = registry.roots;
  const result = moveMemory({
    roots,
    fromScope: 'project_local',
    toScope: 'project_shared',
    name,
  });
  return finalizeMove({
    ctx,
    registry,
    result,
    name,
    fromScope: 'project_local',
    toScope: 'project_shared',
    pastTense: 'promoted',
    infinitive: 'promote',
    sourceFallback: peek.file.frontmatter.source,
  });
};

// ─── /memory demote local ────────────────────────────────────────────
//
// Spec MEMORY.md §5.5: project_shared → project_local. Inverse of
// promote, NO additional scanner (going to less-trusted scope is
// less restrictive). Modal confirms; moveMemory persists; audit
// `demoted` event.

const handleDemote = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  if (args.length !== 2 || args[0] !== 'local') {
    return {
      kind: 'error',
      message: '/memory demote: syntax is `demote local <name>` (only local target supported)',
    };
  }
  const name = args[1] as string;

  const peek = registry.peek(name, { scope: 'project_shared' });
  if (peek.kind !== 'present') {
    return {
      kind: 'error',
      message: `/memory demote: '${name}' not found in project_shared`,
    };
  }

  const answer = await ctx.modalManager.askMemoryAction({
    action: 'demote',
    title: 'Demote memory to local',
    subject: `project_shared/${name} → project_local/${name}`,
    preview: [
      'Demoting to local removes this memory from the team-shared set.',
      'The shared/ entry will be deleted (visible as a git change);',
      'a copy lands in local/ for your future sessions.',
      '',
      ...peek.file.body.split('\n'),
    ],
    question: 'Demote to project_local?',
  });
  if (answer !== 'yes') {
    return {
      kind: 'ok',
      notes: [`/memory demote cancelled (operator answered ${answer})`],
    };
  }

  const roots = registry.roots;
  const result = moveMemory({
    roots,
    fromScope: 'project_shared',
    toScope: 'project_local',
    name,
  });
  return finalizeMove({
    ctx,
    registry,
    result,
    name,
    fromScope: 'project_shared',
    toScope: 'project_local',
    pastTense: 'demoted',
    infinitive: 'demote',
    sourceFallback: peek.file.frontmatter.source,
  });
};

// Shared finalizer for promote / demote. Maps moveMemory's
// discriminated result onto the audit row + slash result.
interface FinalizeMoveInput {
  ctx: SlashContext;
  registry: MemoryRegistry;
  result: ReturnType<typeof moveMemory>;
  name: string;
  fromScope: MemoryScope;
  toScope: MemoryScope;
  // Verb pair: past tense for the audit `action` enum (memory_events
  // accepts `promoted` / `demoted`); infinitive for operator-facing
  // error messages (`/memory promote: ...` reads better than
  // `/memory promoted: ...`). Earlier cut tried to derive infinitive
  // via `action.replace(/d$/, 'e')` — which produced "promotee" /
  // "demotee" because the trailing 'd' got swapped for 'e' (the
  // last 'd' isn't part of the past-tense suffix). Explicit pair
  // here removes the regex hack.
  pastTense: 'promoted' | 'demoted';
  infinitive: 'promote' | 'demote';
  // Source field from the pre-move peek — used as the audit row's
  // `source` for both success and failure paths so the row
  // groups correctly with the memory's other history.
  sourceFallback: string;
}

const finalizeMove = (input: FinalizeMoveInput): SlashResult => {
  const { ctx, registry, result, name, fromScope, toScope, pastTense, infinitive, sourceFallback } =
    input;
  const auditCwd = ctx.baseConfig.cwd;
  const audit = attribution(ctx);

  if (result.kind === 'moved') {
    registry.recordEvent({
      action: pastTense,
      scope: toScope,
      memoryName: name,
      source: result.source as 'user_explicit' | 'inferred' | 'imported',
      details: {
        from_scope: fromScope,
        to_scope: toScope,
        from_path: result.fromPath,
        to_path: result.toPath,
      },
      auditCwd,
      ...audit,
    });
    registry.reload();
    return {
      kind: 'ok',
      notes: [`${pastTense} ${fromScope}/${name} → ${toScope}/${name}`],
    };
  }

  // Failure paths — audit refused with stage tag and reason. Use
  // the sourceFallback we captured pre-move since `result` doesn't
  // carry it on failure variants.
  let reason: string;
  switch (result.kind) {
    case 'source_unknown':
      reason = `source body missing in ${fromScope}`;
      break;
    case 'source_malformed':
      reason = `source body malformed: ${result.reason}`;
      break;
    case 'target_exists':
      reason = `target already exists at ${result.path}`;
      break;
    case 'sandbox_violation':
      reason = result.reason;
      break;
    case 'io_error':
      reason = result.reason;
      break;
  }
  registry.recordEvent({
    action: 'refused',
    scope: fromScope,
    memoryName: name,
    source: sourceFallback as 'user_explicit' | 'inferred' | 'imported',
    details: { stage: `slash_${pastTense}`, kind: result.kind, reason },
    auditCwd,
    ...audit,
  });
  return { kind: 'error', message: `/memory ${infinitive}: ${reason}` };
};

// ─── command export ──────────────────────────────────────────────────

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description:
    'manage cross-session memories (list/show/audit/delete/quarantine/restore/promote/demote)',
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
        return handleList(registry, ctx, args.slice(1));
      case 'show':
        return handleShow(registry, ctx, args.slice(1));
      case 'audit':
        return handleAudit(ctx, args.slice(1));
      case 'metrics':
        return handleMetrics(ctx, args.slice(1));
      case 'delete':
        return handleDelete(registry, ctx, args.slice(1));
      case 'quarantine':
        return handleQuarantine(registry, ctx, args.slice(1));
      case 'restore':
        return handleRestore(registry, ctx, args.slice(1));
      case 'promote':
        return handlePromote(registry, ctx, args.slice(1));
      case 'demote':
        return handleDemote(registry, ctx, args.slice(1));
      default:
        return {
          kind: 'error',
          message: `/memory: unknown subcommand '${sub}' (try: list, show, audit, metrics, delete, quarantine, restore, promote, demote)`,
        };
    }
  },
};
