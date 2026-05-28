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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EMPTY_CORPUS_HASH,
  type MemoryFile,
  type MemoryListing,
  type MemoryRegistry,
  type MemoryScope,
  type MemorySubdir,
  type TombstoneEntry,
  applyProposal,
  clearSharedTrust,
  computeSharedFingerprint,
  findLatestTombstone,
  getSharedTrust,
  installVendorSeeds,
  isExpired,
  isSeedDisabled,
  listSharedCorpusFiles,
  listingScopeOption,
  loadDisabledSeeds,
  loadSeedManifest,
  moveMemory,
  parseMemoryFile,
  removeMemory,
  resolveRepoRoot,
  scanForInjection,
  scanForPromotion,
  seedMemoryFilePath,
  setSharedTrust,
  transitionMemoryState,
  writeDisabledSeeds,
  writeSeedManifest,
} from '../../../memory/index.ts';
import {
  MEMORY_VERIFY_CONFLICT_MAX_COST_USD,
  MEMORY_VERIFY_CONFLICT_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_CONFLICT_MIN_CONFIDENCE,
} from '../../../memory/verify-conflict.ts';
import {
  MEMORY_VERIFY_OVERRIDE_MAX_COST_USD,
  MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_OVERRIDE_COOLDOWN_MS,
  SEMANTIC_OVERRIDE_MIN_CONFIDENCE,
} from '../../../memory/verify-override.ts';
import {
  MEMORY_VERIFY_SEMANTIC_MAX_COST_USD,
  MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_VERIFY_DEDUP_WINDOW_MS,
  SEMANTIC_VERIFY_MIN_CONFIDENCE,
} from '../../../memory/verify-semantic.ts';
import { sanitizeOneLineForDisplay } from '../../../sanitize/ansi.ts';
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
  listEvictionEventsByTrigger,
} from '../../../storage/repos/eviction-events.ts';
import { evictionMetricsSnapshot } from '../../../storage/repos/eviction-metrics.ts';
import {
  SEMANTIC_CONFLICT_DEDUP_WINDOW_MS,
  listRecentConflictAttempts,
} from '../../../storage/repos/memory-conflict-attempts.ts';
import type { MemoryEventSource } from '../../../storage/repos/memory-events.ts';
import {
  GOVERNANCE_PROPOSAL_STATUSES,
  MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS,
  MIN_GOVERNANCE_PROPOSAL_DEFER_DAYS,
  type MemoryGovernanceProposalRow,
  type MemoryGovernanceProposalStatus,
  decideProposal,
  deferProposal,
  getProposalById,
  listProposals,
} from '../../../storage/repos/memory-governance.ts';
import {
  type MemoryProvenanceRow,
  listExposuresInRetrieval,
  listGlobalProvenanceByName,
  listGlobalProvenanceForMemory,
  listProvenanceByName,
  listProvenanceForToolCall,
} from '../../../storage/repos/memory-provenance.ts';
import { listRecentAttempts } from '../../../storage/repos/memory-verify-attempts.ts';
import { listRecentOverrideAttempts } from '../../../storage/repos/memory-verify-override-attempts.ts';
import { CANONICAL_SEEDS } from '../../init-seeds/index.ts';
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
    // Spec §5.7.3 "UI mostrar `[seed]` discreto na lista" — the
    // eager-load already marks seeds via assembleMemorySection
    // (memory-prompt.ts:315), but the operator-facing /memory list
    // surface needs the same signal so an operator inspecting their
    // memories distinguishes vendor-curated meta-behavior from
    // their own user-scope entries. Without this, a user-scope
    // memory of the same scope letter looks identical to a seed in
    // the rendered list. Suffix order matches the eager-load
    // (after the name, before expires).
    const seedSuffix = l.subdir === 'seeds' ? ' [seed]' : '';
    // Pass the full listing identity so a seed listing whose name
    // collides with a user-top entry surfaces the seed body for
    // state/expires inspection, not the shadowing top-level body.
    const peek = registry.peek(l.name, listingScopeOption(l));
    if (peek.kind === 'unknown' || peek.kind === 'missing') {
      lines.push(`  [${l.scope}] [ORPHAN] ${l.name}${seedSuffix} — ${l.entry.hook}`);
      continue;
    }
    if (peek.kind === 'malformed') {
      lines.push(
        `  [${l.scope}] [MALFORMED] ${l.name}${seedSuffix} — ${l.entry.hook} (${peek.error})`,
      );
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
    lines.push(`  [${l.scope}] ${prefix}${l.name}${seedSuffix} — ${l.entry.hook}${expiresSuffix}`);
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

// ─── /memory provenance (S1/T1.6) ─────────────────────────────────────

// Operator surface for the exposure trail (MEMORY.md §11.2). Three
// query modes; mutual exclusion enforced at parse time:
//
//   /memory provenance <name>            session-scoped lookup
//   /memory provenance <name> --all      cross-session forensic
//   /memory provenance --tool <id>       what a tool_call exposed
//   /memory provenance --retrieval <qid> group view of one retrieve_context
//
// `--limit N` (default 50) caps the rendered batch. The header
// always says which mode was selected so the operator doesn't
// confuse "no rows in this session" with "no rows anywhere".

interface ProvenanceFlags {
  mode: 'name' | 'tool' | 'retrieval';
  name: string | null;
  toolCallId: string | null;
  retrievalQueryId: string | null;
  allSessions: boolean;
  limit: number;
}

const parseProvenanceFlags = (args: string[]): ProvenanceFlags | { error: string } => {
  let name: string | null = null;
  let toolCallId: string | null = null;
  let retrievalQueryId: string | null = null;
  let allSessions = false;
  let limit = 50;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--limit') {
      const next = args[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return {
          error: `/memory provenance: --limit needs a positive integer (got ${next ?? 'nothing'})`,
        };
      }
      limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        return { error: `/memory provenance: invalid limit '${next}'` };
      }
      i += 2;
      continue;
    }
    if (a === '--tool') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/memory provenance: --tool needs a tool_call id' };
      }
      toolCallId = next;
      i += 2;
      continue;
    }
    if (a === '--retrieval') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/memory provenance: --retrieval needs a retrieval_query id' };
      }
      retrievalQueryId = next;
      i += 2;
      continue;
    }
    if (a === '--all') {
      allSessions = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--')) {
      return {
        error: `/memory provenance: unknown flag '${a}' (try --tool, --retrieval, --all, --limit)`,
      };
    }
    // Positional: memory name (only one allowed).
    if (name !== null) {
      return {
        error: `/memory provenance: extra positional '${a}' — only one memory name allowed`,
      };
    }
    name = a;
    i += 1;
  }
  // Mutual exclusion between the three modes. `name` mode is the
  // default when a positional is supplied; --tool / --retrieval
  // explicitly select the other modes; mixing is a usage error
  // (the underlying queries answer different questions).
  const modes: ('name' | 'tool' | 'retrieval')[] = [];
  if (name !== null) modes.push('name');
  if (toolCallId !== null) modes.push('tool');
  if (retrievalQueryId !== null) modes.push('retrieval');
  if (modes.length === 0) {
    return {
      error: '/memory provenance: needs a memory name or --tool <id> or --retrieval <qid>',
    };
  }
  if (modes.length > 1) {
    return {
      error: `/memory provenance: modes are mutually exclusive (picked ${modes.join(' + ')}) — pick one of: name, --tool, --retrieval`,
    };
  }
  if (allSessions && modes[0] !== 'name') {
    return {
      error: '/memory provenance: --all only applies to the name lookup',
    };
  }
  const mode = modes[0] as 'name' | 'tool' | 'retrieval';
  return { mode, name, toolCallId, retrievalQueryId, allSessions, limit };
};

const formatProvenanceRow = (row: MemoryProvenanceRow): string => {
  const ts = formatAuditTimestamp(row.createdAt);
  const tc = row.toolCallId !== null ? row.toolCallId.slice(0, 8) : 'eager---';
  // Show hash prefix when present — full 64-char hex hides actual
  // identifying info we'd want at-a-glance; first 8 chars match
  // the existing prefix convention for session/tool ids.
  const hash = row.memoryContentHash !== null ? row.memoryContentHash.slice(0, 8) : '--------';
  const state = row.memoryStateAtExposure ?? 'active';
  // retrieval-only details: position + query id prefix when set.
  let groupDetail = '';
  if (row.surface === 'retrieve_context' && row.retrievalQueryId !== null) {
    const qid = row.retrievalQueryId.slice(0, 8);
    const pos = row.positionInCorpus !== null ? `#${row.positionInCorpus}` : '#?';
    groupDetail = ` · retrieval=${qid} ${pos}`;
  }
  return `  ${ts} · ${row.surface.padEnd(16)} · ${row.memoryScope}/${row.memoryName} · tc=${tc} · state=${state} · hash=${hash}${groupDetail}`;
};

const handleProvenance = (ctx: SlashContext, args: string[]): SlashResult => {
  const flags = parseProvenanceFlags(args);
  if ('error' in flags) return { kind: 'error', message: flags.error };

  const sessionId = ctx.currentSessionId();
  let rows: MemoryProvenanceRow[];
  let header: string;

  if (flags.mode === 'name') {
    const name = flags.name as string;
    if (flags.allSessions) {
      rows = listGlobalProvenanceByName(ctx.db, name, flags.limit);
      header = `exposures for '${name}' (all sessions)`;
    } else if (sessionId === null) {
      // No current session yet — fall through to cross-session to
      // avoid the confusing "0 rows in current session" header.
      rows = listGlobalProvenanceByName(ctx.db, name, flags.limit);
      header = `exposures for '${name}' (no current session — showing all)`;
    } else {
      rows = listProvenanceByName(ctx.db, sessionId, name, flags.limit);
      header = `exposures for '${name}' (current session)`;
    }
  } else if (flags.mode === 'tool') {
    if (sessionId === null) {
      return {
        kind: 'error',
        message:
          '/memory provenance --tool: needs an active session (tool_call ids are session-scoped)',
      };
    }
    rows = listProvenanceForToolCall(ctx.db, sessionId, flags.toolCallId as string, flags.limit);
    header = `exposures during tool_call ${(flags.toolCallId as string).slice(0, 8)}`;
  } else {
    // retrieval mode
    if (sessionId === null) {
      return {
        kind: 'error',
        message:
          '/memory provenance --retrieval: needs an active session (retrieval_query ids are session-scoped)',
      };
    }
    rows = listExposuresInRetrieval(
      ctx.db,
      sessionId,
      flags.retrievalQueryId as string,
      flags.limit,
    );
    header = `exposures from retrieval ${(flags.retrievalQueryId as string).slice(0, 8)} (position order)`;
  }

  if (rows.length === 0) {
    if (flags.mode === 'name' && !flags.allSessions && sessionId !== null) {
      return {
        kind: 'ok',
        notes: [`${header}: 0 rows`, '  (try --all for cross-session forensic)'],
      };
    }
    return { kind: 'ok', notes: [`${header}: 0 rows`] };
  }

  const lines = [`${header} (${rows.length}):`];
  for (const r of rows) lines.push(formatProvenanceRow(r));
  return { kind: 'ok', notes: lines };
};

// ─── /memory conflicts (S4/T4.4) ─────────────────────────────────────

// Surface conflict_detected pairs forensically. Reads eviction_events
// filtered to `trigger = 'conflict_detected'` and outcome = 'applied'.
// Cross-session by design — operator wants to see the full history of
// detected conflicts, not just the current session. `--limit N`
// (default 50) caps the rendered batch.

interface ConflictsFlags {
  limit: number;
}

const parseConflictsFlags = (args: string[]): ConflictsFlags | { error: string } => {
  let limit = 50;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--limit') {
      const next = args[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return {
          error: `/memory conflicts: --limit needs a positive integer (got ${next ?? 'nothing'})`,
        };
      }
      limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        return { error: `/memory conflicts: invalid limit '${next}'` };
      }
      i += 2;
      continue;
    }
    if (a.startsWith('--')) {
      return { error: `/memory conflicts: unknown flag '${a}' (try --limit)` };
    }
    return { error: `/memory conflicts: unexpected positional '${a}'` };
  }
  return { limit };
};

const handleConflicts = (ctx: SlashContext, args: string[]): SlashResult => {
  const flags = parseConflictsFlags(args);
  if ('error' in flags) return { kind: 'error', message: flags.error };

  const events = listEvictionEventsByTrigger(ctx.db, 'conflict_detected', flags.limit);
  if (events.length === 0) {
    return {
      kind: 'ok',
      notes: [
        'no conflict_detected events recorded (heuristic returns silence by default — narrow bar)',
      ],
    };
  }

  const lines = [`conflict_detected events (${events.length}, most recent first):`];
  for (const e of events) {
    // Parse evidence to extract winner/loser/kind for inline display.
    // Evidence JSON shape (S13 LLM-judge plan, TODO Phase 2):
    //   { winner_id, loser_id, conflict_kind, shared_concept?,
    //     confidence?, resolver_reason?, ... }
    // `shared_concept` is the canonical name (was `shared_token` in
    // the rolled-back S4 heuristic — kept the field renamed forward
    // so when S13 lands, slash + producer agree). `confidence` is
    // LLM-judge specific; absent for non-LLM-emitted rows.
    let winner = '?';
    let loser = '?';
    let kind = '?';
    let sharedConcept: string | null = null;
    let confidence: number | null = null;
    try {
      const evidence = JSON.parse(e.evidenceJson) as Record<string, unknown>;
      if (typeof evidence.winner_id === 'string') winner = evidence.winner_id;
      if (typeof evidence.loser_id === 'string') loser = evidence.loser_id;
      if (typeof evidence.conflict_kind === 'string') kind = evidence.conflict_kind;
      if (typeof evidence.shared_concept === 'string') sharedConcept = evidence.shared_concept;
      if (typeof evidence.confidence === 'number') confidence = evidence.confidence;
    } catch {
      // Malformed evidence JSON — fall back to placeholders. Audit
      // row itself is intact; just couldn't decode the payload.
    }
    const ts = formatAuditTimestamp(e.recordedAt);
    const conceptDetail = sharedConcept !== null ? ` concept="${sharedConcept}"` : '';
    const confDetail = confidence !== null ? ` conf=${confidence.toFixed(2)}` : '';
    lines.push(`  ${ts} · ${kind} · winner=${winner} loser=${loser}${conceptDetail}${confDetail}`);
  }
  return { kind: 'ok', notes: lines };
};

// ─── /memory trust status (S5/T5.4) ──────────────────────────────────
//
// Operator-facing inspector for the shared-corpus trust state. Read-
// only: no transitions, no modal, no DB writes. Surfaces enough
// information for the operator to answer "do I need to re-confirm
// trust, and if so, against what?" without restarting the agent.
//
// Output sections:
//   - `path` — absolute scope root (typically `<repo>/.agent/memory/
//     shared`). Surfaced so the operator can `cat` files outside
//     the slash interaction if they want deeper inspection.
//   - `status` — one of: `in sync`, `DIVERGED`, `never confirmed`,
//     `VERIFY FAILED`. Diverged is upper-case so the operator's eye
//     catches the security-relevant state on a scroll-by; the other
//     states aren't load-bearing enough to warrant the same visual
//     weight.
//   - hashes — last confirmed + current side-by-side on divergence,
//     just the current hash otherwise. Truncated to first 12 hex
//     chars in the line; the operator who needs the full hash can
//     query the DB directly (intentionally not exposed via the
//     slash to keep the output scannable).
//   - inventory — file count + total bytes (NOT per-file enumeration;
//     `/memory list --scope shared` is the right tool for that).
//
// Args: only `status` is supported as of T5.4. Future extensions
// (`/memory trust clear`, `/memory trust forget <scope>`) land in
// follow-up slices when operators ask for them.
const handleTrust = (registry: MemoryRegistry, ctx: SlashContext, args: string[]): SlashResult => {
  const sub = args[0];
  if (sub === undefined) {
    return {
      kind: 'error',
      message: '/memory trust: missing subcommand (try: status, accept, forget)',
    };
  }
  if (sub !== 'status' && sub !== 'accept' && sub !== 'forget') {
    return {
      kind: 'error',
      message: `/memory trust: unknown subcommand '${sub}' (try: status, accept, forget)`,
    };
  }
  // Extra args beyond `status`/`accept`/`forget` are user error —
  // refuse rather than silently ignoring, matching the spec's
  // "explicit is better than implicit" stance for operator-facing
  // surfaces.
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory trust ${sub}: unexpected extra args (${args.slice(1).join(' ')})`,
    };
  }

  const sharedRootForAction = registry.roots.projectShared;

  // `/memory trust accept` (S5 IMP/F6). Operator-explicit consent
  // recorded as a slash command — equivalent to answering 'yes' in
  // the modal but without re-prompting (operator already typed the
  // command; THAT is the explicit consent moment). Use case: the
  // operator cancelled the boot modal (Esc/timeout) → 'deferred'
  // outcome → eager-load excluded the scope this session. They
  // want to enable it without restarting; `/memory trust accept`
  // stamps the current hash and tells them the scope will load
  // from the NEXT session.
  if (sub === 'accept') {
    const currentHash = computeSharedFingerprint(sharedRootForAction);
    if (currentHash === null) {
      return {
        kind: 'error',
        message: `/memory trust accept: corpus unreadable at ${sharedRootForAction} — cannot record trust`,
      };
    }
    setSharedTrust(ctx.db, sharedRootForAction, currentHash, ctx.now());
    return {
      kind: 'ok',
      notes: [
        `shared corpus trust recorded for ${sharedRootForAction}`,
        `  hash: ${currentHash}`,
        "  (scope will load from the NEXT session boot — this session's eager-load",
        '   inventory was frozen at bootstrap and is not retroactively patched)',
      ],
    };
  }

  // `/memory trust forget` (S5 IMP/F6). Operator-explicit clear —
  // removes the stored trust row WITHOUT touching memory state on
  // disk. Use case: operator wants the next boot to re-prompt as
  // first-visit (e.g., after they manually edited shared/ and
  // want a fresh confirmation flow), but does NOT want to
  // invalidate the existing memories (that's `/memory delete`).
  if (sub === 'forget') {
    clearSharedTrust(ctx.db, sharedRootForAction);
    return {
      kind: 'ok',
      notes: [
        `shared corpus trust cleared for ${sharedRootForAction}`,
        '  (next boot will fire the first-visit modal; memory states on disk are unchanged)',
      ],
    };
  }
  // Falls through to status.

  const sharedRoot = registry.roots.projectShared;
  const stored = getSharedTrust(ctx.db, sharedRoot);
  const currentHash = computeSharedFingerprint(sharedRoot);

  const lines: string[] = ['shared corpus trust:', `  path: ${sharedRoot}`];

  if (currentHash === null) {
    // Substrate couldn't fingerprint — fs unreadable. Operator gets
    // a clear signal that the agent doesn't know the corpus state;
    // distinct from "no row yet" (recoverable on next confirm) or
    // "diverged" (operator decision pending).
    lines.push('  status: VERIFY FAILED — could not read corpus root');
    return { kind: 'ok', notes: lines };
  }

  // Inventory line (file count + total bytes). Delegates to the
  // single corpus-enumeration helper that the fingerprint and the
  // modal preview also use — symlink rejection and `.tombstones/`
  // exclusion stay aligned across surfaces by construction.
  const listing = listSharedCorpusFiles(sharedRoot);
  const inventory = listing.kind === 'present' ? listing.files : [];
  const fileCount = inventory.length;
  let totalBytes = 0;
  for (const f of inventory) totalBytes += f.bytes;

  // Hash display: full 64-char SHA-256, NOT truncated. A truncated
  // 12-char prefix is only 48 bits — an attacker who can choose
  // corpus content can brute-force a hash with the same prefix
  // (birthday collision ≈ 2^24, seconds on a workstation) and trick
  // an operator scanning the slash output into believing "barely
  // diverged" when the substrate already determined DIVERGED on the
  // full hash. The operator's terminal width handles the line; we
  // don't optimize for scrollback compactness at the cost of
  // forgeability.
  if (stored === null) {
    // Two distinct flavors of "no trust row" (S5 P0/F2 + CRIT/F1+V2
    // post-hardening): an EMPTY corpus is safe to silent-seed next
    // boot (nothing to consent to); a non-empty corpus will instead
    // trigger a first-visit modal — that's typically the case after
    // a recent revoke OR a fresh clone of a repo whose shared/ was
    // never trusted on this machine.
    if (currentHash === EMPTY_CORPUS_HASH) {
      lines.push('  status: never confirmed · corpus is empty (next boot will silently seed)');
    } else {
      lines.push(
        '  status: NOT TRUSTED · corpus has content but no trust row (next boot will fire the first-visit modal)',
      );
    }
    lines.push(`  current hash: ${currentHash}`);
  } else if (stored.lastConfirmedHash === currentHash) {
    lines.push(
      `  status: in sync · last confirmed ${formatAuditTimestamp(stored.lastConfirmedAtMs)}`,
    );
    lines.push(`  current hash: ${currentHash}`);
  } else {
    lines.push(
      `  status: DIVERGED · last confirmed ${formatAuditTimestamp(stored.lastConfirmedAtMs)}`,
    );
    lines.push(`  last hash:    ${stored.lastConfirmedHash}`);
    lines.push(`  current hash: ${currentHash}`);
    lines.push('  (a re-confirm modal will fire on next boot if the divergence persists)');
  }
  lines.push(`  inventory: ${fileCount} file${fileCount === 1 ? '' : 's'}, ${totalBytes} bytes`);

  return { kind: 'ok', notes: lines };
};

// ─── /memory seeds disable | enable | list (S5b/§5.7.6) ──────────────
//
// Per-seed operator opt-out. Sentinel lives at
// `<user>/seeds/.disabled.json` and is consulted by both
// `installVendorSeeds` (which routes disabled seeds through the new
// `disabled` action — body untouched, manifest preserved, index
// excluded) and `createMemoryRegistry.refresh` (which filters
// disabled seeds out of the user/seeds snapshot so the model never
// sees them in the assembled prompt).
//
// Subcommands:
//   /memory seeds list                     — enumerate every canonical
//                                            seed with its current
//                                            [active|disabled] state
//   /memory seeds disable <name>           — add the opt-out sentinel,
//                                            re-run the installer (which
//                                            drops the body from the
//                                            index), and refresh the
//                                            registry so the current
//                                            session reflects the
//                                            change without a restart
//   /memory seeds enable <name>            — reverse: remove the
//                                            sentinel, re-run the
//                                            installer (which re-adds
//                                            the body to the index if
//                                            present), refresh the
//                                            registry
//
// Both mutation subcommands validate the name against `CANONICAL_SEEDS`
// — a typo lands on a clear error naming the known set instead of
// silently writing a sentinel for a seed that doesn't exist (which
// would later look like the disable "did nothing" when the installer
// ignores the stale entry).
const handleSeeds = (registry: MemoryRegistry, ctx: SlashContext, args: string[]): SlashResult => {
  const sub = args[0];
  if (sub === undefined) {
    return {
      kind: 'error',
      message: '/memory seeds: missing subcommand (try: disable, enable, list)',
    };
  }
  if (sub !== 'disable' && sub !== 'enable' && sub !== 'list') {
    return {
      kind: 'error',
      message: `/memory seeds: unknown subcommand '${sub}' (try: disable, enable, list)`,
    };
  }

  // `/memory seeds list` — enumerate canonical catalog with state.
  // We list from CANONICAL_SEEDS (not from registry.list filtered to
  // user/seeds) on purpose: a disabled seed is filtered OUT of the
  // registry's user/seeds snapshot, so iterating registry listings
  // would hide exactly the entries this subcommand is supposed to
  // surface. The canonical catalog is the source of truth for "what
  // could be installed"; the sentinel + on-disk presence decide
  // "what currently is".
  //
  // Three-state classification (active / disabled / absent), in
  // priority order:
  //
  //   - disabled — sentinel names the seed; opt-out wins regardless
  //                of body presence (operator could have deleted the
  //                body while disabled; disable's contract is the
  //                strongest signal).
  //   - absent   — no sentinel AND no body on disk. Three sub-cases
  //                land here: (a) operator ran `agent init
  //                --no-seeds`, (b) operator never ran `agent init`
  //                at all, (c) operator deleted the body manually
  //                post-install (installer routes through user_kept
  //                with the manifest preserved; the body never
  //                returns until the operator re-runs `enable` or
  //                hand-edits the manifest). In all three cases the
  //                seed is NOT in the registry's user/seeds snapshot
  //                and NOT in the model's prompt assembly — listing
  //                them as `active` would mislead.
  //   - active   — no sentinel AND body on disk. The seed is in the
  //                loaded set and the model sees it on every prompt
  //                assembly.
  if (sub === 'list') {
    if (args.length > 1) {
      return {
        kind: 'error',
        message: `/memory seeds list: unexpected extra args (${args.slice(1).join(' ')})`,
      };
    }
    const disabledMap = loadDisabledSeeds(registry.roots);
    const notes: string[] = [];
    let activeCount = 0;
    let disabledCount = 0;
    let absentCount = 0;
    for (const seed of CANONICAL_SEEDS) {
      let stateMarker: string;
      if (isSeedDisabled(disabledMap, seed.name)) {
        disabledCount += 1;
        stateMarker = 'disabled';
      } else if (!existsSync(seedMemoryFilePath(registry.roots, seed.name))) {
        absentCount += 1;
        stateMarker = 'absent  ';
      } else {
        activeCount += 1;
        stateMarker = 'active  ';
      }
      notes.push(`  [${stateMarker}] ${seed.name} — ${seed.description}`);
    }
    // The `absent` total appends only when non-zero — matches the
    // `, K archived` suffix convention in the init summary so the
    // post-install steady-state output keeps the two-counter shape
    // operators already memorized.
    const totals = [`${activeCount} active`, `${disabledCount} disabled`];
    if (absentCount > 0) totals.push(`${absentCount} absent`);
    notes.unshift(`vendor seeds: ${totals.join(', ')} (of ${CANONICAL_SEEDS.length} canonical)`);
    if (absentCount > 0) {
      // Recovery hint only fires when there's something to recover.
      // Naming `agent init` rather than `agent init --only=seeds`
      // because the operator's first install is the common path;
      // the `--only=seeds` form is for post-init catalog refreshes
      // already documented in the disable+delete recovery line.
      notes.push(
        '  absent = not installed yet; run `agent init` (or `agent init --only=seeds`) to land them',
      );
    }
    return { kind: 'ok', notes };
  }

  // disable / enable — both take a seed name.
  const name = args[1];
  if (name === undefined) {
    return {
      kind: 'error',
      message: `/memory seeds ${sub}: missing seed name (try: /memory seeds list to see known names)`,
    };
  }
  if (args.length > 2) {
    return {
      kind: 'error',
      message: `/memory seeds ${sub}: unexpected extra args (${args.slice(2).join(' ')})`,
    };
  }
  const knownSeed = CANONICAL_SEEDS.find((s) => s.name === name);
  if (knownSeed === undefined) {
    const known = CANONICAL_SEEDS.map((s) => s.name).join(', ');
    return {
      kind: 'error',
      message: `/memory seeds ${sub}: unknown seed '${name}' (known: ${known})`,
    };
  }

  const disabledMap = loadDisabledSeeds(registry.roots);
  const alreadyDisabled = isSeedDisabled(disabledMap, name);

  if (sub === 'disable') {
    if (alreadyDisabled) {
      // Idempotent — no sentinel write, no installer re-run. The
      // operator's repeat invocation isn't an error, but signaling
      // "no-op" lets them notice if they meant a different name.
      return {
        kind: 'ok',
        notes: [`seed '${name}' already disabled (no-op)`],
      };
    }
    disabledMap[name] = { disabled_at: new Date(ctx.now()).toISOString() };
    writeDisabledSeeds(registry.roots, disabledMap);
    // Re-run the installer so `seeds/MEMORY.md` drops the entry
    // immediately — without this, the index would still advertise
    // the seed until the next `agent init` pass, and `/memory list`
    // would show it (the registry filter below catches that, but
    // the on-disk index would still be stale and confusing for an
    // operator who inspects the directory). The installer call is
    // cheap (10 hashes + an atomic write); operator-triggered so
    // latency is tolerable.
    installVendorSeeds({ roots: registry.roots });
    registry.reload();
    // The "body preserved" line must reflect what actually happened
    // on disk. After `--no-seeds` (or any path that disabled the
    // seed before its body was ever written), the body does not
    // exist — claiming preservation in that case sends operators
    // chasing a file that isn't there. Branch on existsSync at the
    // canonical path so the operator-facing copy matches reality.
    const bodyPath = seedMemoryFilePath(registry.roots, name);
    const bodyOnDisk = existsSync(bodyPath);
    const persistenceLine = bodyOnDisk
      ? `seed '${name}' disabled — body preserved at ${bodyPath}, excluded from the loaded set`
      : `seed '${name}' disabled — no body on disk yet (sentinel persisted so a future install honors the opt-out)`;
    return {
      kind: 'ok',
      notes: [
        persistenceLine,
        '  the opt-out survives `agent init` and a future vendor catalog bump',
        `  re-enable with: /memory seeds enable ${name}`,
      ],
    };
  }

  // sub === 'enable'
  if (!alreadyDisabled) {
    return {
      kind: 'ok',
      notes: [`seed '${name}' already enabled (no-op)`],
    };
  }
  delete disabledMap[name];
  writeDisabledSeeds(registry.roots, disabledMap);
  // `enable` semantic is "I want this seed back to vendor baseline".
  // Three cases at this point (sentinel just cleared, installer not
  // re-run yet):
  //
  //   1. Body present, hash matches the manifest → installer routes
  //      through `unchanged` → index re-adds the entry → seed is
  //      visible. No additional action needed.
  //   2. Body present, hash diverges from the manifest (operator
  //      hand-edited at some point) → installer routes through
  //      `user_kept` → body preserved verbatim → index re-adds the
  //      entry (existsSync skip passes) → seed IS visible. The
  //      operator's edit is honored, not silently overridden.
  //   3. Body absent, prior manifest entry exists (operator deleted
  //      the body manually at some point) → installer routes through
  //      `user_kept` → no write → index excludes (existsSync skip
  //      fails) → seed NOT visible.
  //
  // Case 3 was the bug in the original handler: the installer's
  // operator-delete-intent path is fundamentally the WRONG response
  // to an explicit `enable`. The operator just typed the command
  // that says "give me this seed back"; the historical delete intent
  // is overridden by the newer enable intent. To make case 3 land
  // on a fresh re-install, drop the manifest entry before running
  // the installer — the installer then sees no body + no prior
  // manifest, routes through `fresh`, and writes the canonical body.
  const bodyPath = seedMemoryFilePath(registry.roots, name);
  if (!existsSync(bodyPath)) {
    const manifest = loadSeedManifest(registry.roots);
    if (manifest[name] !== undefined) {
      delete manifest[name];
      writeSeedManifest(registry.roots, manifest);
    }
  }
  installVendorSeeds({ roots: registry.roots });
  registry.reload();
  // Post-install body presence is the source of truth for "is the
  // seed in the loaded set?" — the index regen excludes entries with
  // no body on disk (a guarantee from the installer, pinned by the
  // seeds-installer tests). `installVendorSeeds` is deterministic on
  // the post-state, so if existsSync still fails here, something
  // pathological happened (e.g., a write race outside our control)
  // and the honest answer is "we tried, check the path".
  const bodyRestored = existsSync(bodyPath);
  return {
    kind: 'ok',
    notes: bodyRestored
      ? [`seed '${name}' enabled — back in the loaded set on the next prompt assembly`]
      : [
          `seed '${name}' enabled — sentinel removed, but the body did not land at ${bodyPath}`,
          '  check the path for permissions / disk-full errors and re-run',
        ],
  };
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
      peek.subdir,
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
      peek.subdir,
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
    peek.subdir,
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
  subdir?: MemorySubdir,
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
  // Seeds (subdir='seeds') always take the legacy route. The state-
  // machine path's tombstone semantics resolve under the scope's
  // .tombstones/ — for a seed, that would move the body OUT of
  // <user>/seeds/.tombstones/ where slice-2's seedTombstonePath
  // expects it, into <user>/.tombstones/. Until slice 5+ extends
  // the transition lifecycle to handle seed-specific tombstone
  // routing, removeMemory + the subdir-aware path resolver is the
  // safe path. Operator restore for seeds: slice 4 archives the
  // body when the catalog drops it, so `/memory delete <seed>`
  // followed by an undo would route through the archive surface,
  // not the tombstone surface.
  if (route === 'state-machine' && subdir !== 'seeds') {
    return await deleteViaTransition(ctx, registry, roots, scope, name);
  }

  // Other states / dangling entries: keep the legacy removeMemory
  // primitive. tombstone path doesn't apply (the file is already
  // absent / malformed; index-only cleanup is what the operator
  // wants). Future slice can route quarantined/invalidated/evicted
  // through transitionMemoryState too — out of scope here because
  // the volume is tiny and the legacy path is well-tested.
  const result = removeMemory({ roots, scope, name, ...(subdir !== undefined && { subdir }) });
  if (result.kind === 'sandbox_violation') {
    registry.recordEvent({
      action: 'refused',
      scope,
      memoryName: name,
      source: source as MemoryEventSource,
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
      source: source as MemoryEventSource,
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
    source: source as MemoryEventSource,
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
      source: result.source as MemoryEventSource,
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
    source: sourceFallback as MemoryEventSource,
    details: { stage: `slash_${pastTense}`, kind: result.kind, reason },
    auditCwd,
    ...audit,
  });
  return { kind: 'error', message: `/memory ${infinitive}: ${reason}` };
};

// ─── /memory governance ──────────────────────────────────────────────
//
// Operator surface for the Phase 2 governance proposal substrate
// (MEMORY.md §11.3, S8). Detectors emit proposals; this slash is
// where operators inspect / decide them.
//
// Five subcommands:
//   - `list   [--status <s>] [--limit N]`  inventory of proposals
//   - `show   <id>`                         single proposal detail
//   - `approve <id>`                        run apply path
//   - `reject  <id> [--reason "..."]`       mark rejected
//   - `audit   <id>`                        lineage (proposal → memory events / provenance)

const GOVERNANCE_DECIDED_BY_OPERATOR = 'operator:slash';

// Operator-facing display helper. Every string that originated outside
// the slash (proposal ids from operator stdin, names/scopes from DB
// rows that may have been authored by detectors, --reason input)
// passes through this before being echoed to the scrollback bus.
// sanitizeOneLineForDisplay strips ANSI escapes + collapses CR/LF/TAB,
// so a malicious detector that embedded \x1b[2J\x1b[H in
// `proposed_by` (or an operator passing `--reason $'\x1b[2J'`) cannot
// repaint the operator's terminal via /memory governance output.
const displayGov = (s: string): string => sanitizeOneLineForDisplay(s);

const formatGovernanceTimestamp = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatProposalLine = (p: MemoryGovernanceProposalRow): string => {
  const ts = formatGovernanceTimestamp(p.createdAt);
  const idShort = displayGov(p.id.slice(0, 8));
  const conf = p.confidence === null ? '   --' : p.confidence.toFixed(2).padStart(5, ' ');
  const keysCount = p.sourceMemoryKeys.length;
  const keysPreview =
    keysCount === 1 && p.sourceMemoryKeys[0] !== undefined
      ? `${displayGov(p.sourceMemoryKeys[0].scope)}/${displayGov(p.sourceMemoryKeys[0].name)}`
      : `${keysCount} memories`;
  return `  ${ts} · ${idShort} · ${displayGov(p.status).padEnd(8)} · ${displayGov(p.kind).padEnd(11)} · conf=${conf} · ${keysPreview} · ${displayGov(p.proposedBy)}`;
};

interface GovernanceListFlags {
  status: MemoryGovernanceProposalStatus | null;
  limit: number;
}

const parseGovernanceListFlags = (args: string[]): GovernanceListFlags | { error: string } => {
  let status: MemoryGovernanceProposalStatus | null = null;
  let limit = 50;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--status') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { error: '/memory governance list: --status requires a value' };
      }
      if (!GOVERNANCE_PROPOSAL_STATUSES.includes(raw as MemoryGovernanceProposalStatus)) {
        return {
          error: `/memory governance list: invalid --status '${raw}' (expected: ${GOVERNANCE_PROPOSAL_STATUSES.join(', ')})`,
        };
      }
      status = raw as MemoryGovernanceProposalStatus;
      i += 2;
      continue;
    }
    if (a === '--limit') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { error: '/memory governance list: --limit requires a value' };
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return {
          error: `/memory governance list: --limit must be an integer 1..500 (got '${raw}')`,
        };
      }
      limit = n;
      i += 2;
      continue;
    }
    return { error: `/memory governance list: unknown flag '${a}' (try --status, --limit)` };
  }
  return { status, limit };
};

const handleGovernanceList = (ctx: SlashContext, args: string[]): SlashResult => {
  const parsed = parseGovernanceListFlags(args);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };
  const rows = listProposals(ctx.db, {
    ...(parsed.status !== null ? { status: parsed.status } : {}),
    limit: parsed.limit,
  });
  if (rows.length === 0) {
    const filter = parsed.status !== null ? ` (status=${parsed.status})` : '';
    return {
      kind: 'ok',
      notes: [`no governance proposals${filter} — detectors haven't emitted any in this window`],
    };
  }
  const header = `governance proposals${parsed.status !== null ? ` · status=${parsed.status}` : ''} (showing ${rows.length}):`;
  return {
    kind: 'ok',
    notes: [header, ...rows.map(formatProposalLine)],
  };
};

const truncateJson = (value: unknown, max = 240): string => {
  const json = JSON.stringify(value);
  if (json.length <= max) return json;
  return `${json.slice(0, max)}… (+${json.length - max} chars)`;
};

const renderProposalDetail = (p: MemoryGovernanceProposalRow): string[] => {
  const lines: string[] = [];
  lines.push(`proposal ${displayGov(p.id)}`);
  lines.push(`  kind:                ${displayGov(p.kind)}`);
  lines.push(`  status:              ${displayGov(p.status)}`);
  lines.push(`  proposed_by:         ${displayGov(p.proposedBy)}`);
  lines.push(
    `  confidence:          ${p.confidence === null ? '(null)' : p.confidence.toString()}`,
  );
  lines.push(`  fingerprint:         ${displayGov(p.proposalFingerprint)}`);
  lines.push(`  created_at:          ${formatGovernanceTimestamp(p.createdAt)}`);
  if (p.decidedAt !== null) {
    lines.push(`  decided_at:          ${formatGovernanceTimestamp(p.decidedAt)}`);
  }
  if (p.decidedBy !== null) {
    lines.push(`  decided_by:          ${displayGov(p.decidedBy)}`);
  }
  if (p.decidedReason !== null) {
    lines.push(`  decided_reason:      ${displayGov(p.decidedReason)}`);
  }
  if (p.sessionId !== null) {
    lines.push(`  session_id:          ${displayGov(p.sessionId)}`);
  }
  if (p.deferredUntil !== null) {
    lines.push(
      `  deferred_until:      ${formatGovernanceTimestamp(p.deferredUntil)} (count=${p.deferCount})`,
    );
  }
  lines.push('  source memories:');
  for (let i = 0; i < p.sourceMemoryKeys.length; i++) {
    const k = p.sourceMemoryKeys[i];
    const s = p.sourceMemorySnapshots[i];
    if (k === undefined) continue;
    // contentHash is SHA-256 hex from our own hashMemoryContent — no
    // sanitization needed, but pass through for symmetry.
    const hashPrefix =
      s !== undefined ? ` (snapshot ${displayGov(s.contentHash).slice(0, 12)}…)` : '';
    lines.push(`    - ${displayGov(k.scope)}/${displayGov(k.name)}${hashPrefix}`);
  }
  // truncateJson uses JSON.stringify which escapes control characters
  // (e.g. \x1b → ) so ANSI injection through targetPayload /
  // evidence values is already neutralized at the JSON layer.
  if (p.targetPayload !== null) {
    lines.push(`  target_payload:      ${truncateJson(p.targetPayload)}`);
  }
  lines.push(`  evidence:            ${truncateJson(p.evidence)}`);
  return lines;
};

const handleGovernanceShow = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory governance show: missing proposal id' };
  }
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory governance show: too many args (got '${displayGov(args[1] as string)}' after id)`,
    };
  }
  const id = args[0] as string;
  const proposal = getProposalById(ctx.db, id);
  if (proposal === null) {
    return {
      kind: 'error',
      message: `/memory governance show: proposal '${displayGov(id)}' not found`,
    };
  }
  return { kind: 'ok', notes: renderProposalDetail(proposal) };
};

const handleGovernanceApprove = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory governance approve: missing proposal id' };
  }
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory governance approve: too many args (got '${displayGov(args[1] as string)}' after id)`,
    };
  }
  const id = args[0] as string;
  const proposal = getProposalById(ctx.db, id);
  if (proposal === null) {
    return {
      kind: 'error',
      message: `/memory governance approve: proposal '${displayGov(id)}' not found`,
    };
  }
  if (proposal.status !== 'pending') {
    return {
      kind: 'error',
      message: `/memory governance approve: proposal '${displayGov(id)}' already ${displayGov(proposal.status)} (decided by ${displayGov(proposal.decidedBy ?? 'unknown')})`,
    };
  }
  // Bulk-effect confirmation modal (T8.5 "≥3 memories prompts extra")
  // is intentionally NOT wired in V1: the apply path's single-memory
  // gate (`src/memory/governance.ts:applyProposal`) auto-rejects every
  // multi-memory proposal with `multi_memory_unsupported` before the
  // modal would have a chance to fire. Wiring it now would be dead
  // code. Re-introduce here when `merge` / `consolidate` apply
  // primitives land and multi-memory transitions become reachable.
  const sessionId = ctx.currentSessionId();
  const result = await applyProposal({
    db: ctx.db,
    registry,
    proposalId: id,
    decidedBy: GOVERNANCE_DECIDED_BY_OPERATOR,
    sessionId: sessionId ?? null,
    cwd: ctx.baseConfig.cwd ?? null,
    ...(ctx.dispatchHooks !== undefined ? { fireHook: ctx.dispatchHooks } : {}),
    now: ctx.now,
  });
  if (result.outcome === 'applied') {
    registry.reload();
    const lines = [`approved proposal ${displayGov(id)} (${displayGov(proposal.kind)})`];
    for (const t of result.transitions) {
      lines.push(
        `  ${displayGov(t.scope)}/${displayGov(t.name)}: ${t.fromState} → ${t.toState} (eviction_event ${displayGov(t.evictionEventId).slice(0, 8)})`,
      );
    }
    // governanceDrift surfaces when the post-transition decideProposal
    // UPDATE raced with another actor (TTL sweep, parallel decision).
    // Memory transition still landed; the proposal row attribution
    // does NOT credit this approve. Operator needs to see this so
    // they don't wonder why /memory governance audit shows their
    // approve under someone else's decided_by.
    if (result.governanceDrift !== undefined) {
      lines.push(
        `  ⚠ governance row race: proposal now status=${displayGov(result.governanceDrift.currentStatus)} decided_by=${displayGov(result.governanceDrift.decidedBy ?? 'unknown')} — memory transitioned, audit row not stamped by this approve (see stderr AUDIT DRIFT)`,
      );
    }
    return { kind: 'ok', notes: lines };
  }
  if (result.outcome === 'not_found') {
    return {
      kind: 'error',
      message: `/memory governance approve: proposal '${displayGov(id)}' not found`,
    };
  }
  if (result.outcome === 'already_decided') {
    return {
      kind: 'error',
      message: `/memory governance approve: proposal '${displayGov(id)}' is ${displayGov(result.currentStatus)} (decided by ${displayGov(result.decidedBy ?? 'unknown')})`,
    };
  }
  // outcome === 'rejected' — the apply path persisted the decision
  // already. Echo the reason so the operator sees what gated.
  // result.message is system-built from user/detector input (drifted
  // memories names, transition reasons) — sanitize for display.
  return {
    kind: 'error',
    message: `/memory governance approve: rejected (${result.reason}): ${displayGov(result.message)}`,
  };
};

interface GovernanceRejectFlags {
  reason: string | null;
}

const parseGovernanceRejectFlags = (args: string[]): GovernanceRejectFlags | { error: string } => {
  let reason: string | null = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--reason') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { error: '/memory governance reject: --reason requires a value' };
      }
      reason = raw;
      i += 2;
      continue;
    }
    return { error: `/memory governance reject: unknown flag '${a}' (try --reason)` };
  }
  return { reason };
};

const handleGovernanceReject = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory governance reject: missing proposal id' };
  }
  const id = args[0] as string;
  const parsed = parseGovernanceRejectFlags(args.slice(1));
  if ('error' in parsed) return { kind: 'error', message: parsed.error };
  const proposal = getProposalById(ctx.db, id);
  if (proposal === null) {
    return {
      kind: 'error',
      message: `/memory governance reject: proposal '${displayGov(id)}' not found`,
    };
  }
  if (proposal.status !== 'pending') {
    return {
      kind: 'error',
      message: `/memory governance reject: proposal '${displayGov(id)}' already ${displayGov(proposal.status)} (decided by ${displayGov(proposal.decidedBy ?? 'unknown')})`,
    };
  }
  // Persist the operator's reason verbatim (audit trail value) but
  // sanitize it when echoing back to scrollback so ANSI / control
  // chars in --reason don't corrupt the operator's terminal.
  const changed = decideProposal(ctx.db, id, {
    status: 'rejected',
    decidedBy: GOVERNANCE_DECIDED_BY_OPERATOR,
    decidedReason: parsed.reason,
    decidedAt: ctx.now(),
  });
  if (!changed) {
    // Race: another writer landed a terminal status between getProposalById
    // and the UPDATE. Re-load to render the actual end state.
    const latest = getProposalById(ctx.db, id);
    return {
      kind: 'error',
      message: `/memory governance reject: proposal '${displayGov(id)}' is no longer pending (current status: ${displayGov(latest?.status ?? 'unknown')})`,
    };
  }
  return {
    kind: 'ok',
    notes: [
      `rejected proposal ${displayGov(id)} (${displayGov(proposal.kind)})`,
      parsed.reason !== null ? `  reason: ${displayGov(parsed.reason)}` : '  (no reason supplied)',
    ],
  };
};

interface GovernanceDeferFlags {
  reason: string | null;
}

const parseGovernanceDeferFlags = (args: string[]): GovernanceDeferFlags | { error: string } => {
  let reason: string | null = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--reason') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { error: '/memory governance defer: --reason requires a value' };
      }
      reason = raw;
      i += 2;
      continue;
    }
    return { error: `/memory governance defer: unknown flag '${a}' (try --reason)` };
  }
  return { reason };
};

// Resolve the memory the proposal would transition on approve.
// Mirrors `applyProposal`'s target resolution: target_key when set
// (multi-memory quarantine carve-out), else sourceMemoryKeys[0]
// (single-memory path). Returns null if the row carries no keys
// (caller refuses with not_pending earlier — this is belt-and-
// suspenders against a future schema regression).
const resolveProposalTargetMemory = (
  p: MemoryGovernanceProposalRow,
): { scope: MemoryScope; name: string } | null => {
  const payload = p.targetPayload;
  if (payload !== null) {
    const tk = (payload as Record<string, unknown>).target_key;
    if (tk !== null && typeof tk === 'object' && !Array.isArray(tk)) {
      const tkObj = tk as Record<string, unknown>;
      if (typeof tkObj.scope === 'string' && typeof tkObj.name === 'string') {
        return { scope: tkObj.scope as MemoryScope, name: tkObj.name };
      }
    }
  }
  const first = p.sourceMemoryKeys[0];
  return first === undefined ? null : { scope: first.scope, name: first.name };
};

const handleGovernanceDefer = (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): SlashResult => {
  if (args.length < 2) {
    return {
      kind: 'error',
      message: `/memory governance defer: missing arguments (usage: /memory governance defer <id> <days> [--reason "..."]; days in [${MIN_GOVERNANCE_PROPOSAL_DEFER_DAYS}, ${MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS}])`,
    };
  }
  const id = args[0] as string;
  const daysRaw = args[1] as string;
  const days = Number(daysRaw);
  if (!Number.isInteger(days)) {
    return {
      kind: 'error',
      message: `/memory governance defer: <days> must be an integer (got '${displayGov(daysRaw)}')`,
    };
  }
  const parsedFlags = parseGovernanceDeferFlags(args.slice(2));
  if ('error' in parsedFlags) return { kind: 'error', message: parsedFlags.error };
  const proposal = getProposalById(ctx.db, id);
  if (proposal === null) {
    return {
      kind: 'error',
      message: `/memory governance defer: proposal '${displayGov(id)}' not found`,
    };
  }
  if (proposal.status !== 'pending') {
    return {
      kind: 'error',
      message: `/memory governance defer: proposal '${displayGov(id)}' already ${displayGov(proposal.status)} (decided by ${displayGov(proposal.decidedBy ?? 'unknown')})`,
    };
  }
  const result = deferProposal(ctx.db, id, { additionalDays: days, nowMs: ctx.now() });
  if (!result.ok) {
    if (result.reason === 'invalid_days') {
      return {
        kind: 'error',
        message: `/memory governance defer: <days> must be in [${MIN_GOVERNANCE_PROPOSAL_DEFER_DAYS}, ${MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS}] (got ${days})`,
      };
    }
    if (result.reason === 'horizon_exceeded') {
      return {
        kind: 'error',
        message:
          '/memory governance defer: would push expiry past the 90d horizon from created_at; approve or reject the proposal instead',
      };
    }
    // not_pending — raced with a terminal transition between the
    // read above and the UPDATE. Surface the actual end state.
    const latest = getProposalById(ctx.db, id);
    return {
      kind: 'error',
      message: `/memory governance defer: proposal '${displayGov(id)}' is no longer pending (current status: ${displayGov(latest?.status ?? 'unknown')})`,
    };
  }

  // Audit emit: best-effort, mirrors the registry's other
  // recordEvent paths (auditRead, governance approve). A disk
  // error here stderr-logs `AUDIT DRIFT` but does NOT roll back the
  // defer — the proposal row already committed inside its own
  // immediate transaction, so the defer happened from the
  // operator's perspective even when the audit row didn't land.
  const target = resolveProposalTargetMemory(proposal);
  if (target !== null) {
    const peek = registry.peek(target.name, { scope: target.scope });
    const source = peek.kind === 'present' ? peek.file.frontmatter.source : 'inferred';
    registry.recordEvent({
      scope: target.scope,
      action: 'deferred',
      memoryName: target.name,
      source,
      details: {
        proposal_id: id,
        kind: proposal.kind,
        additional_days: days,
        new_deferred_until: result.deferredUntil,
        defer_count: result.deferCount,
        ...(parsedFlags.reason !== null ? { reason: parsedFlags.reason } : {}),
      },
    });
  }

  return {
    kind: 'ok',
    notes: [
      `deferred proposal ${displayGov(id)} (${displayGov(proposal.kind)}) by ${days}d`,
      `  new effective expiry: ${formatGovernanceTimestamp(result.deferredUntil)} (defer_count=${result.deferCount})`,
      ...(parsedFlags.reason !== null ? [`  reason: ${displayGov(parsedFlags.reason)}`] : []),
    ],
  };
};

const handleGovernanceAudit = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/memory governance audit: missing proposal id' };
  }
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory governance audit: too many args (got '${displayGov(args[1] as string)}' after id)`,
    };
  }
  const id = args[0] as string;
  const proposal = getProposalById(ctx.db, id);
  if (proposal === null) {
    return {
      kind: 'error',
      message: `/memory governance audit: proposal '${displayGov(id)}' not found`,
    };
  }
  const lines = renderProposalDetail(proposal);
  // Lineage: for each source memory, surface (a) memory_events that
  // landed on or after the proposal's created_at — approval
  // transitions, subsequent restores, unrelated edits — and (b) any
  // memory_provenance exposures recorded since the proposal, so the
  // operator sees both what changed AND what the model saw of the
  // memory after the detector emitted. Cross-session by design: the
  // proposal may have been approved (or the memory exposed) in a
  // different REPL session than the one running this slash.
  //
  // eviction_events JOIN by proposal_id (which the apply path threads
  // into evidence_json) is deferred: a SQL LIKE on JSON is fragile,
  // and adding a dedicated index requires a schema change. Use
  // `/memory audit --name <name>` for the eviction trail today.
  const sinceMs = proposal.createdAt - 1; // inclusive of proposal createdAt
  lines.push('');
  lines.push('lineage:');
  let anyLineage = false;
  for (const key of proposal.sourceMemoryKeys) {
    const events = listMemoryEventsByName(ctx.db, key.name, 20).filter(
      (e) => e.scope === key.scope && e.createdAt >= sinceMs,
    );
    const exposures = listGlobalProvenanceForMemory(ctx.db, key.scope, key.name, 20).filter(
      (e) => e.createdAt >= sinceMs,
    );
    if (events.length === 0 && exposures.length === 0) {
      lines.push(
        `  ${displayGov(key.scope)}/${displayGov(key.name)}: (no events or exposures since proposal)`,
      );
      continue;
    }
    anyLineage = true;
    lines.push(`  ${displayGov(key.scope)}/${displayGov(key.name)}:`);
    if (events.length > 0) {
      lines.push(`    events (${events.length}):`);
      for (const e of events) {
        lines.push(`      ${formatAuditRow(e).trimStart()}`);
      }
    }
    if (exposures.length > 0) {
      lines.push(`    exposures (${exposures.length}):`);
      for (const ex of exposures) {
        const ts = formatGovernanceTimestamp(ex.createdAt);
        const tc = ex.toolCallId === null ? 'eager---' : displayGov(ex.toolCallId).slice(0, 8);
        const session = displayGov(ex.sessionId).slice(0, 8);
        lines.push(`      ${ts} · ${ex.surface.padEnd(16)} · session=${session} · tc=${tc}`);
      }
    }
  }
  if (!anyLineage) {
    lines.push(
      '  (no downstream memory_events or memory_provenance entries recorded since this proposal was created)',
    );
  }
  return { kind: 'ok', notes: lines };
};

const handleGovernanceStatus = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length > 0) {
    return {
      kind: 'error',
      message: `/memory governance status: unexpected arg '${displayGov(args[0] as string)}' (no flags or positionals supported)`,
    };
  }
  // The scheduler instance (and thus its live counters) lives inside
  // the harness loop scope; the slash can't reach it. We surface what
  // we CAN see substrate-side: opt-in state, configured caps, and a
  // recent-attempts summary read from memory_verify_attempts (cross-
  // session — the table has no session_id column by design).
  // Slice Q: enabled flag + source provenance label. Source resolved
  // at boot (CLI > project config > user config > default ON). The
  // label tells operator HOW the value was decided.
  const enabled = ctx.baseConfig.memorySemanticVerify === true;
  const verifySource = ctx.baseConfig.memorySemanticVerifySource ?? 'default';
  const verifyLabel = (() => {
    if (enabled && verifySource === 'cli') return 'yes (--memory-verify-llm)';
    if (enabled && verifySource === 'project-config') return 'yes (.agent/config.toml)';
    if (enabled && verifySource === 'user-config') return 'yes (~/.config/agent/config.toml)';
    if (enabled) return 'yes (default; disable: /memory governance disable verify)';
    if (verifySource === 'cli') return 'no (--no-memory-verify-llm)';
    if (verifySource === 'project-config') return 'no (.agent/config.toml)';
    if (verifySource === 'user-config') return 'no (~/.config/agent/config.toml)';
    return 'no (default)';
  })();
  const lines: string[] = [];
  lines.push('semantic-verify (S11 / LLM-judge):');
  lines.push(`  enabled:             ${verifyLabel}`);
  lines.push(
    `  confidence floor:    ${SEMANTIC_VERIFY_MIN_CONFIDENCE.toFixed(2)} (proposals below floor auto-archived)`,
  );
  lines.push(`  max dispatches/sess: ${MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION}`);
  lines.push(`  max cost/sess:       $${MEMORY_VERIFY_SEMANTIC_MAX_COST_USD.toFixed(2)}`);
  const dedupDays = Math.round(SEMANTIC_VERIFY_DEDUP_WINDOW_MS / (24 * 60 * 60 * 1000));
  lines.push(
    `  dedup window:        ${dedupDays}d (passed/inconclusive; contradicted always re-dispatches)`,
  );
  // Render verify-attempts AND the S13 block unconditionally — a
  // read failure or empty table on the verify side must not hide
  // the conflict detector status (pre-fix bug: early returns
  // suppressed the S13 block whenever memory_verify_attempts was
  // empty or unreadable).
  let recent: ReturnType<typeof listRecentAttempts> = [];
  try {
    recent = listRecentAttempts(ctx.db, 10);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`  recent attempts:     (read failed: ${displayGov(msg)})`);
  }
  if (recent.length === 0) {
    lines.push('  recent attempts:     (none recorded yet)');
  } else {
    lines.push(`  recent attempts (most-recent first, showing ${recent.length}):`);
    for (const a of recent) {
      const ts = formatGovernanceTimestamp(a.attemptedAt);
      const conf = a.confidence.toFixed(2);
      lines.push(
        `    ${ts} · ${displayGov(a.verdict).padEnd(12)} · conf=${conf} · ${displayGov(a.memoryScope)}/${displayGov(a.memoryName)} · ${displayGov(a.modelId)}`,
      );
    }
  }

  // S13 — conflict detector summary. Same shape: enabled state +
  // caps + recent attempts. Independent counters from S11.
  lines.push('');
  lines.push('verify-conflict (S13 / LLM-judge):');
  const conflictEnabled = ctx.baseConfig.memoryConflictDetect === true;
  const conflictSource = ctx.baseConfig.memoryConflictDetectSource ?? 'default';
  const conflictLabel = (() => {
    if (conflictEnabled && conflictSource === 'cli') return 'yes (--memory-conflict-llm)';
    if (conflictEnabled && conflictSource === 'project-config') return 'yes (.agent/config.toml)';
    if (conflictEnabled && conflictSource === 'user-config')
      return 'yes (~/.config/agent/config.toml)';
    if (conflictEnabled) return 'yes (default; disable: /memory governance disable conflict)';
    if (conflictSource === 'cli') return 'no (--no-memory-conflict-llm)';
    if (conflictSource === 'project-config') return 'no (.agent/config.toml)';
    if (conflictSource === 'user-config') return 'no (~/.config/agent/config.toml)';
    return 'no (default)';
  })();
  lines.push(`  enabled:             ${conflictLabel}`);
  lines.push(
    `  confidence floor:    ${SEMANTIC_CONFLICT_MIN_CONFIDENCE.toFixed(2)} (proposals below floor auto-archived)`,
  );
  lines.push(`  max dispatches/sess: ${MEMORY_VERIFY_CONFLICT_MAX_DISPATCHES_PER_SESSION}`);
  lines.push(`  max cost/sess:       $${MEMORY_VERIFY_CONFLICT_MAX_COST_USD.toFixed(2)}`);
  const conflictDedupDays = Math.round(SEMANTIC_CONFLICT_DEDUP_WINDOW_MS / (24 * 60 * 60 * 1000));
  lines.push(
    `  dedup window:        ${conflictDedupDays}d (compatible verdicts; conflicting always re-dispatches)`,
  );
  let recentConflicts: ReturnType<typeof listRecentConflictAttempts> = [];
  try {
    recentConflicts = listRecentConflictAttempts(ctx.db, 10);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`  recent attempts:     (read failed: ${displayGov(msg)})`);
  }
  if (recentConflicts.length === 0) {
    lines.push('  recent attempts:     (none recorded yet)');
  } else {
    lines.push(`  recent attempts (most-recent first, showing ${recentConflicts.length}):`);
    for (const a of recentConflicts) {
      const ts = formatGovernanceTimestamp(a.attemptedAt);
      const conf = a.confidence.toFixed(2);
      const kind = a.conflictKind !== null ? ` (${displayGov(a.conflictKind)})` : '';
      lines.push(
        `    ${ts} · ${displayGov(a.verdict).padEnd(12)} · conf=${conf} · ${displayGov(a.scopeA)}/${displayGov(a.nameA)} vs ${displayGov(a.scopeB)}/${displayGov(a.nameB)}${kind} · ${displayGov(a.modelId)}`,
      );
    }
  }

  // S3 — override detector summary. Same shape as S11 + S13: enabled
  // state + caps + recent attempts. Independent counters.
  lines.push('');
  lines.push('verify-override (S3 / LLM-judge):');
  const overrideEnabled = ctx.baseConfig.memoryOverrideDetect === true;
  const overrideSource = ctx.baseConfig.memoryOverrideDetectSource ?? 'default';
  const overrideLabel = (() => {
    if (overrideEnabled && overrideSource === 'cli') return 'yes (--memory-override-llm)';
    if (overrideEnabled && overrideSource === 'project-config') return 'yes (.agent/config.toml)';
    if (overrideEnabled && overrideSource === 'user-config')
      return 'yes (~/.config/agent/config.toml)';
    if (overrideEnabled) return 'yes (default; disable: /memory governance disable override)';
    if (overrideSource === 'cli') return 'no (--no-memory-override-llm)';
    if (overrideSource === 'project-config') return 'no (.agent/config.toml)';
    if (overrideSource === 'user-config') return 'no (~/.config/agent/config.toml)';
    return 'no (default)';
  })();
  lines.push(`  enabled:             ${overrideLabel}`);
  lines.push(
    `  confidence floor:    ${SEMANTIC_OVERRIDE_MIN_CONFIDENCE.toFixed(2)} (proposals below floor auto-archived)`,
  );
  lines.push(`  max dispatches/sess: ${MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION}`);
  lines.push(`  max cost/sess:       $${MEMORY_VERIFY_OVERRIDE_MAX_COST_USD.toFixed(2)}`);
  const overrideCooldownDays = Math.round(SEMANTIC_OVERRIDE_COOLDOWN_MS / (24 * 60 * 60 * 1000));
  lines.push(
    `  cooldown window:     ${overrideCooldownDays}d (per-memory; both verdicts dedup until body or window changes)`,
  );
  let recentOverrides: ReturnType<typeof listRecentOverrideAttempts> = [];
  try {
    recentOverrides = listRecentOverrideAttempts(ctx.db, 10);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`  recent attempts:     (read failed: ${displayGov(msg)})`);
  }
  if (recentOverrides.length === 0) {
    lines.push('  recent attempts:     (none recorded yet)');
  } else {
    lines.push(`  recent attempts (most-recent first, showing ${recentOverrides.length}):`);
    for (const a of recentOverrides) {
      const ts = formatGovernanceTimestamp(a.attemptedAt);
      const conf = a.confidence.toFixed(2);
      const verdict = a.misguiding ? 'misguiding' : 'noise';
      lines.push(
        `    ${ts} · ${verdict.padEnd(12)} · conf=${conf} · motivo=${displayGov(a.suggestedMotivo)} · ${displayGov(a.memoryScope)}/${displayGov(a.memoryName)} · ${displayGov(a.modelId)}`,
      );
    }
  }
  return { kind: 'ok', notes: lines };
};

// ─── Slice Q: /memory governance enable | disable ─────────────────
//
// Slash surface for the operator to opt OUT of the (default-ON since
// Slice Q) LLM-judge detectors per-project. Writes `.agent/config.toml
// [memory]` keys; effect applies at next turn boundary (same snapshot
// semantic as /model and /critique mode). Creates `.agent/` + the
// file if absent; preserves other sections (`[critique]`, etc.)
// verbatim via a text-level edit of the `[memory]` block.

const parseDetectorTarget = (
  arg: string | undefined,
): { verify: boolean; conflict: boolean; override: boolean } | null => {
  switch (arg) {
    case 'verify':
      return { verify: true, conflict: false, override: false };
    case 'conflict':
      return { verify: false, conflict: true, override: false };
    case 'override':
      return { verify: false, conflict: false, override: true };
    case 'all':
      return { verify: true, conflict: true, override: true };
    default:
      return null;
  }
};

// Canonical TOML emitter for `.agent/config.toml`. Bun ships only
// TOML.parse — no stringify — so we round-trip the file as
// parse → mutate → emit-canonical instead of text-level splicing
// the `[memory]` block. Round-trip is robust against the shapes
// that defeat a regex-driven splice: multi-line basic strings,
// quoted-key tables, whitespace inside `[ memory ]`, BOM, `\r\n`,
// and section-header lookalikes nested inside string literals.
//
// Trade-off: round-trip loses comments and original whitespace —
// `[critique]` and `[memory]` are re-emitted in a normalized
// shape (snake_case keys, alphabetical-ish by insertion order,
// blank line between tables). Operators editing the file by hand
// should expect rewrites to normalize formatting on the next
// `/memory governance enable|disable`. Forja's `.agent/config.
// toml` schema is flat (no array-of-tables, no nested sub-tables),
// so the 40-line emitter below covers it exhaustively; if a
// future subsystem adds nested tables, extend `emitTomlDoc`.
const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

const emitTomlScalar = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
  if (typeof v === 'string') {
    return `"${v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')}"`;
  }
  if (Array.isArray(v)) return `[${v.map(emitTomlScalar).join(', ')}]`;
  return '""';
};

const emitTomlKey = (k: string): string => {
  if (TOML_BARE_KEY_RE.test(k)) return k;
  return `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const isScalarValue = (v: unknown): boolean =>
  v === null || typeof v !== 'object' || Array.isArray(v);

const emitTomlDoc = (doc: Record<string, unknown>): string => {
  const sections: string[] = [];
  const topLevel: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (isScalarValue(v)) {
      topLevel.push(`${emitTomlKey(k)} = ${emitTomlScalar(v)}`);
    }
  }
  if (topLevel.length > 0) sections.push(topLevel.join('\n'));
  for (const [k, v] of Object.entries(doc)) {
    if (!isScalarValue(v)) {
      const lines: string[] = [`[${emitTomlKey(k)}]`];
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        if (isScalarValue(vv)) {
          lines.push(`${emitTomlKey(kk)} = ${emitTomlScalar(vv)}`);
        }
      }
      sections.push(lines.join('\n'));
    }
  }
  return sections.length > 0 ? `${sections.join('\n\n')}\n` : '';
};

const mutateMemoryConfig = (params: {
  filePath: string;
  patches: {
    verifySemanticLlm?: boolean;
    conflictDetectLlm?: boolean;
    overrideDetectLlm?: boolean;
  };
}): { ok: true } | { ok: false; reason: string } => {
  const { filePath, patches } = params;
  const dir = dirname(filePath);
  let raw = '';
  if (existsSync(filePath)) {
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  let doc: Record<string, unknown> = {};
  if (raw.length > 0) {
    try {
      const parsed = Bun.TOML.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        ok: false,
        reason: `existing ${filePath} has malformed TOML; edit manually or remove the file`,
      };
    }
  }

  // Build the new [memory] block: preserve existing values for keys
  // NOT in the patch, apply the patch on top. Crucially, untouched
  // keys that were ABSENT from the project file STAY ABSENT —
  // materializing them as `true` would write project-level overrides
  // that silently shadow user-config opt-outs. E.g., if the operator
  // disabled conflict_detect_llm globally in ~/.config/agent/config
  // .toml and now runs `/memory governance disable verify`, the
  // pre-fix code wrote `conflict_detect_llm = true` to the project
  // config, which then beats the user-level disable per precedence.
  // The detector silently re-enabled despite the operator never
  // touching it through this command.
  const memBlock: Record<string, boolean> = {};
  const existing = doc.memory;
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    const m = existing as Record<string, unknown>;
    // Accept camelCase aliases the loader honors; re-emit canonical
    // snake_case below (camelCase aliases dropped on rewrite per
    // §11.4 doc).
    const v = m.verify_semantic_llm ?? m.verifySemanticLlm;
    const c = m.conflict_detect_llm ?? m.conflictDetectLlm;
    const o = m.override_detect_llm ?? m.overrideDetectLlm;
    if (typeof v === 'boolean') memBlock.verify_semantic_llm = v;
    if (typeof c === 'boolean') memBlock.conflict_detect_llm = c;
    if (typeof o === 'boolean') memBlock.override_detect_llm = o;
  }
  if (patches.verifySemanticLlm !== undefined) {
    memBlock.verify_semantic_llm = patches.verifySemanticLlm;
  }
  if (patches.conflictDetectLlm !== undefined) {
    memBlock.conflict_detect_llm = patches.conflictDetectLlm;
  }
  if (patches.overrideDetectLlm !== undefined) {
    memBlock.override_detect_llm = patches.overrideDetectLlm;
  }

  if (Object.keys(memBlock).length === 0) {
    // Patch was a no-op (programmer error) AND there was no prior
    // [memory] block; drop the doc-level key so we don't emit an
    // empty section.
    delete doc.memory;
  } else {
    doc.memory = memBlock;
  }

  const outRaw = emitTomlDoc(doc);

  // Atomic temp+rename (mirror of src/memory/writer.ts pattern).
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, outRaw);
    renameSync(tmp, filePath);
  } catch (err) {
    return {
      ok: false,
      reason: `could not write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
};

const handleGovernanceToggle = (
  ctx: SlashContext,
  args: string[],
  value: boolean,
  verb: 'enable' | 'disable',
): SlashResult => {
  const target = parseDetectorTarget(args[0]);
  if (target === null) {
    return {
      kind: 'error',
      message: `/memory governance ${verb}: expected 'verify' | 'conflict' | 'override' | 'all' (got ${args[0] !== undefined ? `'${displayGov(args[0])}'` : 'nothing'})`,
    };
  }
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/memory governance ${verb}: unexpected arg '${displayGov(args[1] as string)}' (single positional only)`,
    };
  }
  const path = require('node:path') as typeof import('node:path');
  // Resolve repo root so the toggle writes to `<repo>/.agent/config
  // .toml` — the SAME file bootstrap reads via
  // `loadMemoryConfig({ cwd: resolveRepoRoot(cwd) })` (fixed in
  // commit 734a262). Pre-fix the toggle wrote to
  // `<invocation-cwd>/.agent/config.toml`; when the REPL was
  // launched from a subdir, the persisted file landed in the
  // subdir and the next process start would not see it — the
  // detector silently re-enabled from repo-root config + defaults
  // despite a successful slash-command return. Falls back to cwd
  // when not in a git repo (matches bootstrap's symmetric
  // fallback).
  const filePath = path.join(resolveRepoRoot(ctx.baseConfig.cwd), '.agent', 'config.toml');
  const patches: Parameters<typeof mutateMemoryConfig>[0]['patches'] = {};
  if (target.verify) patches.verifySemanticLlm = value;
  if (target.conflict) patches.conflictDetectLlm = value;
  if (target.override) patches.overrideDetectLlm = value;
  const result = mutateMemoryConfig({ filePath, patches });
  if (!result.ok) {
    return { kind: 'error', message: `/memory governance ${verb}: ${result.reason}` };
  }
  // Mirror the patch onto ctx.baseConfig so the NEXT startTurn
  // snapshot reflects the new state. Without this, startTurn keeps
  // building HarnessConfig from the pre-bootstrap value — the
  // scheduler still fires for at least one more turn after a
  // disable, despite the note below saying "next turn boundary".
  // Source flips to 'project-config' because the project config is
  // where we just wrote; status surface renders accordingly.
  if (target.verify) {
    ctx.baseConfig.memorySemanticVerify = value;
    ctx.baseConfig.memorySemanticVerifySource = 'project-config';
  }
  if (target.conflict) {
    ctx.baseConfig.memoryConflictDetect = value;
    ctx.baseConfig.memoryConflictDetectSource = 'project-config';
  }
  if (target.override) {
    ctx.baseConfig.memoryOverrideDetect = value;
    ctx.baseConfig.memoryOverrideDetectSource = 'project-config';
  }
  const fields: string[] = [];
  if (target.verify) fields.push(`memory.verify_semantic_llm = ${value}`);
  if (target.conflict) fields.push(`memory.conflict_detect_llm = ${value}`);
  if (target.override) fields.push(`memory.override_detect_llm = ${value}`);
  // Render the affected scope label.
  const affected =
    target.verify && target.conflict && target.override
      ? 'all three detectors'
      : target.verify
        ? 'verify'
        : target.conflict
          ? 'conflict'
          : 'override';
  return {
    kind: 'ok',
    notes: [
      `${verb}d ${affected} in ${filePath}`,
      ...fields,
      'effect applies at the next turn boundary',
    ],
  };
};

const handleGovernanceEnable = (ctx: SlashContext, args: string[]): SlashResult =>
  handleGovernanceToggle(ctx, args, true, 'enable');

const handleGovernanceDisable = (ctx: SlashContext, args: string[]): SlashResult =>
  handleGovernanceToggle(ctx, args, false, 'disable');

const handleGovernance = async (
  registry: MemoryRegistry,
  ctx: SlashContext,
  args: string[],
): Promise<SlashResult> => {
  const sub = args[0];
  if (sub === undefined) {
    return {
      kind: 'error',
      message:
        '/memory governance: subcommand required (try: list, show, approve, reject, defer, audit, status, enable, disable)',
    };
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return handleGovernanceList(ctx, rest);
    case 'show':
      return handleGovernanceShow(ctx, rest);
    case 'approve':
      return handleGovernanceApprove(registry, ctx, rest);
    case 'reject':
      return handleGovernanceReject(ctx, rest);
    case 'defer':
      return handleGovernanceDefer(registry, ctx, rest);
    case 'audit':
      return handleGovernanceAudit(ctx, rest);
    case 'status':
      return handleGovernanceStatus(ctx, rest);
    case 'enable':
      return handleGovernanceEnable(ctx, rest);
    case 'disable':
      return handleGovernanceDisable(ctx, rest);
    default:
      return {
        kind: 'error',
        message: `/memory governance: unknown subcommand '${sub}' (try: list, show, approve, reject, defer, audit, status, enable, disable)`,
      };
  }
};

// ─── command export ──────────────────────────────────────────────────

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description:
    'manage cross-session memories (list/show/audit/provenance/governance/delete/quarantine/restore/promote/demote/trust/seeds)',
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
      case 'provenance':
        return handleProvenance(ctx, args.slice(1));
      case 'conflicts':
        return handleConflicts(ctx, args.slice(1));
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
      case 'trust':
        return handleTrust(registry, ctx, args.slice(1));
      case 'governance':
        return handleGovernance(registry, ctx, args.slice(1));
      case 'seeds':
        return handleSeeds(registry, ctx, args.slice(1));
      default:
        return {
          kind: 'error',
          message: `/memory: unknown subcommand '${sub}' (try: list, show, audit, provenance, conflicts, metrics, delete, quarantine, restore, promote, demote, trust, governance, seeds)`,
        };
    }
  },
};
