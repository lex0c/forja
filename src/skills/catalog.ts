import { redactSecrets } from '../sanitize/secrets.ts';
import { type DB, withTransaction } from '../storage/db.ts';
import {
  createSkillEvent,
  listSkillEventsBySession,
  type SkillEventAction,
} from '../storage/repos/skill-events.ts';
import { readSkillByName, scanScope } from './loader.ts';
import type { SkillScopeRoots } from './paths.ts';
import type { SkillFile, SkillFrontmatter, SkillScope } from './types.ts';

// In-process catalog for the skills subsystem (spec SKILLS.md §3.5,
// §4.1).
//
// `createSkillCatalog` scans every scope at construction via the
// loader's `scanScope`, resolves name conflicts by precedence
// (project_local > project_shared > user — §3.5), and holds the
// result as an in-memory snapshot. It mirrors the memory
// subsystem's registry, minus the index file: skills are
// discovered by directory glob, so the catalog IS the index.
//
// One scan, two outputs:
//   - `entries`  — the resolved skills (the surface, §4.1: name +
//                  description + scope; bodies load lazy via
//                  `read`).
//   - `filtered` — every scanned file that did NOT become an entry,
//                  with the reason. §3.5 mandates that name
//                  resolution is explicit and auditable, never
//                  silent — this list is that audit input.
//
// Audit (§0.7): `recordEvent` writes one skill_events row and
// `recordSurface` emits the boot-time surfaced/filtered set. The
// catalog caches frontmatter (read at scan time) but NOT bodies —
// `read` re-reads from disk so an operator hand-edit between scan
// and invocation is reflected, the same no-body-cache rule the
// loader and the memory registry follow.

// Precedence order (§3.5). Scanning in this order makes the FIRST
// candidate seen for a name the highest-precedence one.
const SCOPE_PRECEDENCE: readonly SkillScope[] = ['project_local', 'project_shared', 'user'];

// A skill that resolved cleanly into the catalog: present on disk,
// frontmatter valid, filename matching `frontmatter.name`, and —
// after precedence — the active entry for its name. Carries the
// parsed frontmatter (read at scan time); the body is not cached.
// Fields are `readonly`: callers of `list` / `lookup` get a view of
// the live snapshot, never a handle to mutate it.
export interface SkillCatalogEntry {
  readonly scope: SkillScope;
  readonly name: string;
  readonly frontmatter: Readonly<SkillFrontmatter>;
}

interface FilteredSkillCommon {
  readonly scope: SkillScope;
  readonly name: string;
}

// A scanned skill file that did NOT become a catalog entry,
// discriminated by `reason`:
//   - 'malformed'     — the file failed to parse (bad frontmatter,
//                       refused symlink, non-kebab-case filename);
//                       `error` is the message.
//   - 'name_mismatch' — `frontmatter.name` differs from the
//                       `<name>.md` filename; `declaredName` is the
//                       frontmatter value.
//   - 'shadowed'      — a valid same-name skill in a higher-
//                       precedence scope won; `shadowedBy` is that
//                       winning scope.
// Each cause carries its own typed payload rather than a flattened
// string, so the §3.5 audit consumer (a later slice) can render and
// filter on it without re-parsing.
export type FilteredSkill =
  | (FilteredSkillCommon & { readonly reason: 'malformed'; readonly error: string })
  | (FilteredSkillCommon & { readonly reason: 'name_mismatch'; readonly declaredName: string })
  | (FilteredSkillCommon & { readonly reason: 'shadowed'; readonly shadowedBy: SkillScope });

export type SkillFilterReason = FilteredSkill['reason'];

// Project a `FilteredSkill` onto the JSON `details` payload of a
// `filtered` skill_events row (§3.4.5): the reason plus its typed
// per-variant field, flattened for storage.
const filteredDetails = (filtered: FilteredSkill): Record<string, unknown> => {
  switch (filtered.reason) {
    case 'malformed':
      return { reason: filtered.reason, error: filtered.error };
    case 'name_mismatch':
      return { reason: filtered.reason, declaredName: filtered.declaredName };
    case 'shadowed':
      return { reason: filtered.reason, shadowedBy: filtered.shadowedBy };
  }
};

// Outcome of a lazy body load. `not_found` is only reachable on the
// no-scope path (the name is in no scope); a strict-scope `read`
// that misses surfaces as `missing` (no such file in that scope).
export type SkillReadResult =
  | { kind: 'present'; scope: SkillScope; file: SkillFile }
  | { kind: 'not_found' }
  | { kind: 'missing'; scope: SkillScope }
  | { kind: 'malformed'; scope: SkillScope; error: string };

// Input to `SkillCatalog.recordEvent`. `sessionId` / `cwd` override
// the catalog's constructor-captured attribution for this one row —
// the tool layer passes the live `ctx.sessionId`, which does not
// exist yet when bootstrap builds the catalog.
export interface RecordSkillEventInput {
  action: SkillEventAction;
  scope: SkillScope;
  skillName: string;
  sessionId?: string | null;
  cwd?: string | null;
  details?: Record<string, unknown>;
}

// Audit attribution for `recordSurface` — the slice of
// RecordSkillEventInput a caller overrides per call. The harness
// loop passes the live session id, which exists only after
// createSession has run.
export type SkillSurfaceAttribution = Pick<RecordSkillEventInput, 'sessionId' | 'cwd'>;

export interface SkillCatalog {
  // Scope roots the catalog was built from. Exposed so lifecycle
  // callers (the `/skill` slash command in a later slice) act
  // against the SAME roots the snapshot was scanned from.
  readonly roots: SkillScopeRoots;

  // The resolved catalog — winners only, sorted by name. Pass a
  // scope to keep only entries whose winning scope is that one.
  list(scope?: SkillScope): readonly SkillCatalogEntry[];

  // The resolved entry for `name`, or null when no scope holds it.
  lookup(name: string): SkillCatalogEntry | null;

  // Lazy-load a skill body. Without `scope`, resolves the name to
  // its winning scope (precedence) and reads that. With `scope`,
  // reads `<scope>/<name>.md` strictly — bypassing precedence, so a
  // shadowed skill is still reachable. The body is read fresh from
  // disk on every call.
  read(name: string, scope?: SkillScope): SkillReadResult;

  // Files dropped during resolution — malformed, name-mismatched,
  // or shadowed. The §3.5 "resolution is explicit" audit input.
  filtered(): readonly FilteredSkill[];

  // Emit a `skill_events` audit row (surfaced / invoked / filtered,
  // §0.7). Best-effort: a no-op when no DB was wired, and a DB
  // failure is logged to stderr, never thrown — an audit miss must
  // not break the model's turn or the boot path.
  recordEvent(input: RecordSkillEventInput): void;

  // Emit the boot-time audit: one `surfaced` row per resolved entry
  // and one `filtered` row per dropped file (§0.7 / RETRIEVAL
  // §3.4.5). Called once per session, right after the session row
  // exists, with that session's id. Best-effort, like recordEvent.
  recordSurface(attribution: SkillSurfaceAttribution): void;

  // Count of resolved entries (winners). Does not walk disk.
  count(): number;

  // Re-scan every scope from disk and rebuild the snapshot.
  reload(): void;
}

export interface CreateSkillCatalogInput {
  roots: SkillScopeRoots;
  // When provided, `recordEvent` writes a `skill_events` audit row;
  // omitted, `recordEvent` is a no-op (unit tests, headless callers
  // with no DB). `sessionId` / `cwd` are audit-attribution defaults
  // — per-call overrides on `recordEvent` win, since the live
  // session id does not exist when bootstrap builds the catalog.
  db?: DB;
  sessionId?: string;
  cwd?: string;
}

export const createSkillCatalog = (input: CreateSkillCatalogInput): SkillCatalog => {
  const { roots, db, sessionId, cwd } = input;
  let entries: SkillCatalogEntry[] = [];
  // Winners keyed by name — `lookup` / `read` index O(1) instead of
  // scanning `entries`. Built once per `refresh`; `entries` is the
  // same set sorted for `list`.
  let byName = new Map<string, SkillCatalogEntry>();
  let filteredEntries: FilteredSkill[] = [];

  const refresh = (): void => {
    // Pass 1 — scan every scope, splitting each file into a
    // candidate (a valid present skill) or a filtered entry.
    const candidates: SkillCatalogEntry[] = [];
    const filtered: FilteredSkill[] = [];
    for (const scope of SCOPE_PRECEDENCE) {
      for (const scanned of scanScope(roots, scope)) {
        if (scanned.kind === 'malformed') {
          filtered.push({ scope, name: scanned.name, reason: 'malformed', error: scanned.error });
          continue;
        }
        // The filename is the canonical id (it is what `read`
        // resolves against). A file whose frontmatter declares a
        // different `name` is an inconsistency — drop it loudly
        // instead of letting `skill_invoke(<filename>)` and
        // `<frontmatter.name>` disagree about what exists.
        const declaredName = scanned.file.frontmatter.name;
        if (declaredName !== scanned.name) {
          filtered.push({ scope, name: scanned.name, reason: 'name_mismatch', declaredName });
          continue;
        }
        candidates.push({ scope, name: scanned.name, frontmatter: scanned.file.frontmatter });
      }
    }

    // Pass 2 — resolve precedence. The candidates arrive in
    // SCOPE_PRECEDENCE order, so the first one seen for a name is
    // the winner and every later same-name candidate is shadowed.
    const winners = new Map<string, SkillCatalogEntry>();
    for (const candidate of candidates) {
      const winner = winners.get(candidate.name);
      if (winner === undefined) {
        winners.set(candidate.name, candidate);
      } else {
        filtered.push({
          scope: candidate.scope,
          name: candidate.name,
          reason: 'shadowed',
          shadowedBy: winner.scope,
        });
      }
    }

    byName = winners;
    entries = [...winners.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    filteredEntries = filtered;
  };

  refresh();

  // Emit one skill_events row — best-effort: a no-op without a DB,
  // and a DB failure goes to redacted stderr, never thrown (an audit
  // miss must not break the model's turn or the boot path).
  const emitSkillEvent = (event: RecordSkillEventInput): void => {
    if (db === undefined) return;
    try {
      createSkillEvent(db, {
        action: event.action,
        scope: event.scope,
        skillName: event.skillName,
        sessionId: event.sessionId ?? sessionId ?? null,
        cwd: event.cwd ?? cwd ?? null,
        ...(event.details !== undefined ? { details: event.details } : {}),
      });
    } catch (err) {
      // A SQLite error can echo a bound parameter, and `details` is
      // caller-supplied — redact the stderr line.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `skills: AUDIT DRIFT: failed to record ${event.action} event for ${event.skillName} (${event.scope}): ${redactSecrets(message)}\n`,
      );
    }
  };

  return {
    roots,

    list(scope?: SkillScope): readonly SkillCatalogEntry[] {
      return scope === undefined ? [...entries] : entries.filter((entry) => entry.scope === scope);
    },

    lookup(name: string): SkillCatalogEntry | null {
      return byName.get(name) ?? null;
    },

    read(name: string, scope?: SkillScope): SkillReadResult {
      let target: SkillScope;
      if (scope !== undefined) {
        target = scope;
      } else {
        const winner = byName.get(name);
        if (winner === undefined) return { kind: 'not_found' };
        target = winner.scope;
      }
      const result = readSkillByName(roots, target, name);
      switch (result.kind) {
        case 'present':
          // The filename is the canonical id; a file whose
          // frontmatter declares a different `name` is the
          // `name_mismatch` case `refresh()` filters out of the
          // snapshot. A strict-scope read — or a no-scope read after
          // an operator hand-edit — can still reach such a file;
          // reject it so `read` honors the same identity invariant
          // the catalog enforces everywhere else.
          if (result.file.frontmatter.name !== name) {
            return {
              kind: 'malformed',
              scope: target,
              error: `frontmatter declares name ${JSON.stringify(result.file.frontmatter.name)}, not ${JSON.stringify(name)}`,
            };
          }
          return { kind: 'present', scope: target, file: result.file };
        case 'missing':
          return { kind: 'missing', scope: target };
        case 'malformed':
          return { kind: 'malformed', scope: target, error: result.error };
      }
    },

    filtered(): readonly FilteredSkill[] {
      return [...filteredEntries];
    },

    recordEvent: emitSkillEvent,

    recordSurface(attribution: SkillSurfaceAttribution): void {
      if (db === undefined) return;
      // Idempotency gate (mirrors the eager-provenance emit in the
      // harness loop): a resumed session already carries surfaced /
      // filtered rows from its prior boot, and skill_events has no
      // UNIQUE — re-emitting would inflate the surfaced-vs-invoked
      // ratio §3.4.5 reads. Skip every (action, scope, name) already
      // recorded for this session; a subagent's first boot has an
      // empty set and emits normally. A read failure falls through
      // to "emit everything" — a duplicate row beats a thrown boot.
      const auditSessionId = attribution.sessionId ?? sessionId ?? null;
      let recorded: Set<string>;
      try {
        recorded =
          auditSessionId === null
            ? new Set()
            : new Set(
                listSkillEventsBySession(db, auditSessionId)
                  .filter((e) => e.action === 'surfaced' || e.action === 'filtered')
                  .map((e) => `${e.action}/${e.scope}/${e.skillName}`),
              );
      } catch {
        recorded = new Set();
      }
      // One transaction for the whole burst — dozens of best-effort
      // INSERTs collapse to a single commit. emitSkillEvent still
      // swallows a per-row failure, so one bad row does not abort
      // the rest; only a BEGIN/COMMIT failure reaches the catch.
      try {
        withTransaction(db, () => {
          for (const entry of entries) {
            if (recorded.has(`surfaced/${entry.scope}/${entry.name}`)) continue;
            emitSkillEvent({
              action: 'surfaced',
              scope: entry.scope,
              skillName: entry.name,
              ...attribution,
              ...(entry.frontmatter.version !== undefined
                ? { details: { version: entry.frontmatter.version } }
                : {}),
            });
          }
          for (const dropped of filteredEntries) {
            if (recorded.has(`filtered/${dropped.scope}/${dropped.name}`)) continue;
            emitSkillEvent({
              action: 'filtered',
              scope: dropped.scope,
              skillName: dropped.name,
              details: filteredDetails(dropped),
              ...attribution,
            });
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `skills: AUDIT DRIFT: recordSurface transaction failed: ${redactSecrets(message)}\n`,
        );
      }
    },

    count(): number {
      return entries.length;
    },

    reload(): void {
      refresh();
    },
  };
};
