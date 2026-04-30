// `agent --list-sessions` handler. Independent of bootstrap because
// it has no need for the provider, the permission engine, or the
// tool registry — only the DB. Skipping bootstrap means no API key
// is required to inspect prior runs, and a missing/unparsable
// permissions.yaml doesn't block the listing.

import type { Session } from '../storage/index.ts';
import {
  type DB,
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
  // Cap on rows returned. Defaults to 20 (same default the repo
  // uses) — enough to find a session by date, not enough to flood
  // a terminal.
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
  // Best-effort first-message preview for orientation. Empty
  // string when we can't extract a string content. We deliberately
  // only look at messages.role='user' to skip system/tool noise.
  prompt_preview: string;
  // Null on top-level sessions, set when this row is a subagent
  // child. Surfaces in JSON output unconditionally; the table
  // renderer indents children under their parent.
  parent_session_id: string | null;
}

const buildItem = (s: Session, db: DB): SessionListItem => {
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
    prompt_preview: preview,
    parent_session_id: s.parentSessionId,
  };
};

// Walk parent → children one level deep. The default subagent
// design has a single layer (parent invokes subagent), so depth=1
// covers the dominant case and keeps the listing readable. Deeper
// trees still render correctly via the parent_session_id field in
// the JSON shape; --include-subagents in the table just shows the
// immediate children.
const fanOut = (parents: Session[], db: DB): Session[] => {
  const out: Session[] = [];
  for (const parent of parents) {
    out.push(parent);
    for (const child of listChildSessions(db, parent.id)) out.push(child);
  }
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
  // ID column is 40 chars wide so that an indented child row
  // ("  ↳ <36-char uuid>") still fits within the slot — UUIDs
  // are 36 chars and the indent prefix is 4 visual cells.
  const ID_WIDTH = 40;
  out(
    'STARTED               STATUS       COST        ID                                        PROMPT\n',
  );
  for (const it of items) {
    const isChild = it.parent_session_id !== null;
    // Subagent rows render with a `↳ ` indent so the tree shape is
    // legible at a glance. Both parent and child rows pad to the
    // same width so the PROMPT column aligns regardless of nesting.
    const id = (isChild ? `  ↳ ${it.id}` : it.id).padEnd(ID_WIDTH);
    const status = it.status.padEnd(12);
    const cost = `$${it.cost_usd.toFixed(4)}`.padEnd(11);
    out(`${it.started_at}  ${status} ${cost} ${id}  ${it.prompt_preview}\n`);
  }
};

export const runListSessions = (options: ListSessionsOptions): number => {
  const dbPath = options.dbPath ?? defaultDbPath();
  const db = options.dbOverride ?? openDb(dbPath);
  const ownsDb = options.dbOverride === undefined;
  try {
    if (ownsDb) migrate(db);
    const sessions = listSessions(db, { limit: options.limit ?? 20 });
    // listSessions filters out children by default. When the user
    // asks for them, fan each parent into its immediate children.
    // We do NOT pass {includeSubagents: true} to the repo here
    // because that would mix orphaned children (parent purged,
    // SET NULL fired) into the top-level pool — the repo flag is
    // for raw audit listings; --include-subagents is the
    // hierarchical view.
    const fanned = options.includeSubagents === true ? fanOut(sessions, db) : sessions;
    const items = fanned.map((s) => buildItem(s, db));
    if (options.json) writeJson(items, options.out);
    else writeTable(items, options.out);
    return 0;
  } finally {
    if (ownsDb) db.close();
  }
};
