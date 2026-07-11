// /subagents — list async subagent handles for the current session.
//
// Reads from `subagent_handles` keyed by the active session id.
// Renders one line per handle: id (8-char prefix), name, status,
// and — for settled rows — the cached envelope's reason. Defers
// to `task_async` / `task_await` / `task_cancel` for any
// mutation; this command is observability-only by design,
// matching `/sessions` and `/cost`.
//
// Cancellation is intentionally NOT exposed here: cancel needs
// to flip the in-memory `AbortController` inside the live
// `runAgent`'s handle store, which the slash dispatcher doesn't
// have a wire to. The model still drives cancel via
// `task_cancel`. A future slice could add a slash↔store bridge
// (similar to the modal-manager bridge for `confirmPermission`)
// but that's its own scope.
//
// Output is bounded — only handles owned by the current session.
// A run with zero handles renders "no async subagents".

import { listSubagentHandlesByParent } from '../../../storage/index.ts';
import type { SlashCommand } from '../types.ts';

// Compact id form: 8 hex chars is enough to disambiguate within
// a single run (UUIDs collide at ~1e19; per-run handles in the
// hundreds at most).
const shortId = (id: string): string => id.slice(0, 8);

// Small wall-clock format for the spawnedAt column. Same convention
// /sessions uses, abbreviated to time-of-day since handles are
// always same-day relative to the operator looking at the list.
const pad2 = (n: number): string => String(n).padStart(2, '0');
const formatTimeOfDay = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export const subagentsCommand: SlashCommand = {
  name: 'subagents',
  description: 'list async subagent handles in this session',
  exec: async (_args, ctx) => {
    const sid = ctx.currentSessionId();
    if (sid === null) {
      // Pre-first-turn — no session row yet, nothing to list.
      return { kind: 'ok', notes: ['no session yet (no turn has run)'] };
    }
    const rows = listSubagentHandlesByParent(ctx.db, sid);
    if (rows.length === 0) {
      return {
        kind: 'ok',
        notes: [
          'no async subagent handles in this session',
          '(sync `task` calls do not appear here — they block the parent during execution)',
        ],
      };
    }
    // Header clarifies async-only scope. The footer's `subagents N`
    // counter includes BOTH sync + async runs in flight (it reads
    // live state, not the DB), so an operator might see a count
    // mismatch — the header tells them why.
    const header = 'Async subagent handles in this session:';
    const lines = rows.map((row) => {
      const time = formatTimeOfDay(row.spawnedAt);
      const id = shortId(row.handleId);
      const reason =
        row.status === 'settled' &&
        row.settledPayload !== null &&
        typeof row.settledPayload.reason === 'string'
          ? ` (${row.settledPayload.reason})`
          : '';
      return `${time}  ${id}  ${row.name.padEnd(16)}  ${row.status}${reason}`;
    });
    // Note about stale `running` rows: a `task_cancel` issued in
    // memory flips the in-flight reservation immediately but the
    // DB row only settles when the IIFE wakes up. An operator
    // polling `/subagents` between cancel and IIFE settle sees
    // status='running' for a handle that the model has already
    // released. Eventually consistent — settles on next poll.
    return { kind: 'ok', notes: [header, ...lines] };
  },
};
