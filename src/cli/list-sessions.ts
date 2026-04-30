// `agent --list-sessions` handler. Independent of bootstrap because
// it has no need for the provider, the permission engine, or the
// tool registry — only the DB. Skipping bootstrap means no API key
// is required to inspect prior runs, and a missing/unparsable
// permissions.yaml doesn't block the listing.

import type { Session } from '../storage/index.ts';
import {
  type DB,
  cumulativeCostUsd,
  defaultDbPath,
  listChildSessions,
  listSessions,
  migrate,
  openDb,
} from '../storage/index.ts';

export interface ListSessionsOptions {
  json: boolean;
  // Test seams: a custom DB path / preopened handle (used by unit
  // tests that don't want to touch ~/.config/agent/).
  dbPath?: string;
  dbOverride?: DB;
  out: (s: string) => void;
  // Optional stderr sink. Used only to emit a one-line truncation
  // hint when --include-subagents would have produced more rows
  // than `limit` allows. Defaults to a no-op; the production CLI
  // wires process.stderr. Surfaces in BOTH human and --json modes
  // because it's a diagnostic on stderr — NDJSON consumers parse
  // stdout, and Unix convention keeps stderr available for
  // advisory messages without breaking the data stream.
  err?: (s: string) => void;
  // Cap on rows returned. Defaults to 20 (same default the repo
  // uses) — enough to find a session by date, not enough to flood
  // a terminal. The cap applies to the FINAL output count, not just
  // the top-level pool: with --include-subagents, fanning a parent
  // into its subtree can multiply row count, and the listing
  // truncates whole subtrees (not mid-tree) until the cap fits.
  limit?: number;
  // When true, fan each top-level session out into its subagent
  // children (sessions.parent_session_id-keyed). Default false: the
  // dominant case is "show me my own runs"; subagent rows are a
  // forensic detail that adds row count without giving the user
  // anything they were asking for.
  includeSubagents?: boolean;
}

const PROMPT_PREVIEW_BYTES = 80;

const truncate = (s: string, n: number): string => {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
};

// One-line ISO without sub-second noise, with explicit Z suffix so
// users in non-UTC timezones don't misread the listing as local
// time. ISO 8601 strings in the listing should always carry a
// timezone marker — silently dropping it would cause forensic
// confusion ("did this session run yesterday or today?").
const formatTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.toISOString().replace('T', ' ').slice(0, 19)}Z`;
};

interface SessionListItem {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  status: Session['status'];
  cost_usd: number;
  // Sum of cost_usd for THIS row plus every descendant reachable
  // via parent_session_id (orphans are excluded — see
  // cumulativeCostUsd in repos/sessions.ts). Equal to cost_usd for
  // leaf rows. Forensic field that frees the user from mentally
  // summing children: a parent at $0.001 with two $0.10 subagents
  // shows cumulative_cost_usd: 0.201.
  cumulative_cost_usd: number;
  // Best-effort first-message preview for orientation. Empty
  // string when we can't extract a string content. We deliberately
  // only look at messages.role='user' to skip system/tool noise.
  prompt_preview: string;
  // Live FK to parent. Goes null when the parent is purged via
  // ON DELETE SET NULL. Use `is_subagent` for the row's identity.
  parent_session_id: string | null;
  // Identity flag — true iff this row was created as a subagent.
  // Stays true even after a parent purge; the orphan detection
  // case is the (is_subagent: true, parent_session_id: null) shape.
  is_subagent: boolean;
  // Tree depth relative to the top-level row in the listing. 0 =
  // top-level user session; 1 = direct subagent child; 2 =
  // grandchild; etc. Bounded by MAX_SUBAGENT_DEPTH (4). Lets
  // renderers indent without re-walking parent_session_id, and
  // gives JSON consumers a flat-but-shaped tree.
  depth: number;
}

const buildItem = (s: Session, db: DB, depth: number): SessionListItem => {
  // First user message content. Sessions almost always have at
  // least one user message (the original prompt); the rare race
  // where listSessions runs before appendMessage just yields an
  // empty preview. SQL pulled inline because there's only one
  // call site and the shape is purpose-built for the listing.
  const row = db
    .query(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
    )
    .get(s.id) as { content: string } | null;
  let preview = '';
  if (row !== null) {
    try {
      const parsed = JSON.parse(row.content) as unknown;
      if (typeof parsed === 'string') preview = truncate(parsed, PROMPT_PREVIEW_BYTES);
    } catch {
      // ignore malformed row; preview stays empty
    }
  }
  return {
    id: s.id,
    started_at: formatTime(s.startedAt),
    ended_at: s.endedAt === null ? null : formatTime(s.endedAt),
    model: s.model,
    status: s.status,
    cost_usd: s.totalCostUsd,
    // Cumulative is meaningful for top-level rows where the
    // subtree is collapsed; for child rows the listing already
    // shows every descendant separately when --include-subagents
    // is on, so reporting cumulative there is redundant AND
    // expensive (each row would trigger its own DFS walk, a real
    // N+1 explosion at scale). For depth>0 we just echo cost_usd.
    cumulative_cost_usd: depth === 0 ? cumulativeCostUsd(db, s.id) : s.totalCostUsd,
    prompt_preview: preview,
    parent_session_id: s.parentSessionId,
    is_subagent: s.isSubagent,
    depth,
  };
};

// Walk a single root → descendants depth-first. Recursion is
// bounded by MAX_SUBAGENT_DEPTH (4 levels) at spawn time. The
// `seen` set is shared across multiple subtree calls within a
// single listing (passed in by the caller) so a sibling parent
// that somehow pointed at the same descendant doesn't re-emit it.
// Defense in depth — a corrupt self-referential row would
// otherwise deadlock the listing in an infinite loop. Order:
// each parent immediately followed by its full subtree in DFS,
// oldest sibling first (mirrors listChildSessions).
const fanSubtree = (
  root: Session,
  db: DB,
  seen: Set<string>,
): { session: Session; depth: number }[] => {
  const out: { session: Session; depth: number }[] = [];
  const visit = (s: Session, depth: number): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const child of listChildSessions(db, s.id)) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
};

const writeJson = (items: SessionListItem[], out: (s: string) => void): void => {
  // NDJSON: one row per line. Same convention as --json mode in
  // the run path so headless consumers can stream-parse.
  for (const item of items) out(`${JSON.stringify(item)}\n`);
};

const writeTable = (items: SessionListItem[], out: (s: string) => void): void => {
  if (items.length === 0) {
    out('no sessions found.\n');
    return;
  }
  // Plain table — a real renderer (boxes, color) is M4 territory.
  // Width is fixed enough to align in any terminal >= 80 cols.
  // ID column accommodates the deepest nested row: each level adds
  // 2 indent chars + the `↳ ` prefix on the leaf, so a depth-4 row
  // reads "        ↳ <36-char uuid>" = 46 chars. Padding to the
  // worst case keeps the PROMPT column aligned regardless of which
  // depth shows up in any given row.
  const ID_WIDTH = 46;
  // COST column padding accommodates the worst case "$X.XXXX +$Y.YYYY"
  // (17 chars) plus a 2-char gap before the ID column so rows like
  // "$9.9999 +$9.9999" don't visually butt against the id.
  const COST_WIDTH = 19;
  out(
    `STARTED               STATUS       ${'COST'.padEnd(COST_WIDTH)}${'ID'.padEnd(ID_WIDTH)}  PROMPT\n`,
  );
  for (const it of items) {
    // Subagent rows render with N×"  " indent + "↳ " prefix where
    // N is the row's tree depth. Top-level rows render the bare id.
    const indent = it.depth > 0 ? `${'  '.repeat(it.depth)}↳ ` : '';
    const id = `${indent}${it.id}`.padEnd(ID_WIDTH);
    const status = it.status.padEnd(12);
    // Show the descendant cost as a delta when a row has children
    // that themselves billed. Threshold is `5e-5` (half of the
    // last-shown digit at .toFixed(4)) so the annotation only
    // surfaces when it would render as nonzero — pairs the cost
    // gate with the format precision and avoids `+$0.0000` noise.
    const descendants = it.cumulative_cost_usd - it.cost_usd;
    const costStr =
      descendants > 5e-5
        ? `$${it.cost_usd.toFixed(4)} +$${descendants.toFixed(4)}`
        : `$${it.cost_usd.toFixed(4)}`;
    const cost = costStr.padEnd(COST_WIDTH);
    out(`${it.started_at}  ${status} ${cost}${id}  ${it.prompt_preview}\n`);
  }
};

export const runListSessions = (options: ListSessionsOptions): number => {
  const dbPath = options.dbPath ?? defaultDbPath();
  const db = options.dbOverride ?? openDb(dbPath);
  const ownsDb = options.dbOverride === undefined;
  const limit = options.limit ?? 20;
  try {
    if (ownsDb) migrate(db);
    // listSessions filters out children by default. When the user
    // asks for them, fan each parent into its full descendant tree
    // (DFS, depth-tracked). We do NOT pass {includeSubagents: true}
    // to the repo here because that would mix orphaned children
    // (purged parent → SET NULL → is_subagent=1 stays, but the
    // identity flag plus this filter excludes them) into the
    // top-level pool — the repo flag is for raw audit listings;
    // --include-subagents is the hierarchical view.
    const parents = listSessions(db, { limit });

    let items: SessionListItem[];
    let truncatedTopLevels = 0;
    if (options.includeSubagents !== true) {
      items = parents.map((s) => buildItem(s, db, 0));
    } else {
      // Subtree-atomic truncation: include each parent's full
      // tree or none at all. Mid-tree cuts would hide a parent's
      // children behind the parent itself, which is more confusing
      // than dropping the whole subtree. The cap is on the FINAL
      // row count, not just the top-level pool — a parent with
      // many children can fill the cap on its own.
      items = [];
      const seen = new Set<string>();
      for (const parent of parents) {
        const subtree = fanSubtree(parent, db, seen);
        if (items.length + subtree.length > limit) {
          truncatedTopLevels = parents.length - parents.indexOf(parent);
          break;
        }
        for (const { session, depth } of subtree) {
          items.push(buildItem(session, db, depth));
        }
      }
    }

    if (options.json) writeJson(items, options.out);
    else writeTable(items, options.out);

    // Truncation hint goes to stderr regardless of --json: NDJSON
    // consumers parse stdout and stderr stays available for
    // advisory messages. The hint is purely informational; the
    // listing itself is already correct within the cap.
    if (truncatedTopLevels > 0 && options.err !== undefined) {
      const word = truncatedTopLevels === 1 ? 'session' : 'sessions';
      options.err(
        `forja: --include-subagents truncated to fit limit=${limit}; ${truncatedTopLevels} more top-level ${word} omitted (re-run with --limit N to see them)\n`,
      );
    }
    return 0;
  } finally {
    if (ownsDb) db.close();
  }
};
