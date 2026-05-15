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
  moveMemory,
  parseMemoryFile,
  removeMemory,
  scanForInjection,
  scanForPromotion,
  transitionMemoryState,
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
      'subcommands: list · show · audit · delete · promote shared · demote local',
    ],
  };
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
    evidence: { _operator_driven: true, source: 'slash_delete' as const },
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
    return mapTransitionFailure('/memory delete (quarantined→evicted)', r2);
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
  result: { kind: string; reason?: string | null; tombstonePath?: string },
): SlashResult => {
  if (result.kind === 'unknown') {
    return { kind: 'error', message: `${prefix}: memory not found` };
  }
  if (result.kind === 'illegal_transition') {
    return { kind: 'error', message: `${prefix}: ${result.reason ?? 'illegal state transition'}` };
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
    evidence: { _operator_driven: true, source: 'slash_restore' as const },
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
  description: 'manage cross-session memories (list/show/audit/delete/promote/demote)',
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
      case 'delete':
        return handleDelete(registry, ctx, args.slice(1));
      case 'restore':
        return handleRestore(registry, ctx, args.slice(1));
      case 'promote':
        return handlePromote(registry, ctx, args.slice(1));
      case 'demote':
        return handleDemote(registry, ctx, args.slice(1));
      default:
        return {
          kind: 'error',
          message: `/memory: unknown subcommand '${sub}' (try: list, show, audit, delete, restore, promote, demote)`,
        };
    }
  },
};
