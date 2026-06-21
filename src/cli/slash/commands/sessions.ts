// /sessions — list recent sessions from the DB.
//
// Reads via `listSessions()` (excludes subagent runs by default),
// scoped to the current cwd to match the `--resume last` behavior
// (operator running multiple repos doesn't want unrelated sessions
// cluttering the list). Defaults to 10 most recent; first arg
// overrides the limit (`/sessions 25`).

import { formatCostCell, isUnmeteredModel } from '../../../providers/cost-format.ts';
import { listSessions } from '../../../storage/index.ts';
import { formatCost } from '../format.ts';
import type { SlashCommand } from '../types.ts';

// Pad a small integer to two digits for the timestamp format.
const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatTimestamp = (ms: number): string => {
  // Local wall-clock format, second precision, no TZ suffix. The
  // operator scans session times against their own clock — using
  // toISOString().slice() would render UTC while LOOKING like local
  // time, so a 14:00 session in UTC-3 would show as 17:00 and the
  // operator would pick the wrong row by recency. Manual local
  // getters (vs toLocaleString) avoid locale-dependent formatting:
  // YYYY-MM-DD HH:MM:SS regardless of the operator's locale.
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

export const sessionsCommand: SlashCommand = {
  name: 'sessions',
  description: 'list recent sessions in this directory',
  exec: async (args, ctx) => {
    let limit = 10;
    if (args.length > 0 && args[0] !== undefined) {
      // Strict integer match — Number.parseInt would silently accept
      // partially-numeric strings ('10foo' → 10) and decimals
      // ('1.5' → 1), making typos look like valid input and
      // returning an unexpected number of sessions. Same pattern
      // /budget steps uses for the same reason.
      const raw = args[0];
      if (!/^\d+$/.test(raw)) {
        return {
          kind: 'error',
          message: `/sessions: invalid limit '${raw}' (must be a positive integer)`,
        };
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `/sessions: invalid limit '${raw}' (must be a positive integer)`,
        };
      }
      limit = parsed;
    }
    const sessions = listSessions(ctx.db, { limit, cwd: ctx.baseConfig.cwd });
    if (sessions.length === 0) {
      return { kind: 'ok', notes: [`no sessions found for ${ctx.baseConfig.cwd}`] };
    }
    const lines = [`recent sessions (${sessions.length}):`];
    for (const s of sessions) {
      const status = s.endedAt !== null ? s.status : 'running';
      // An unmetered tier records $0 (reads as "free") — show "unmetered"; an
      // unknown model (dropped from the catalog) falls back to the recorded cost.
      const cost = formatCostCell(
        isUnmeteredModel(ctx.modelRegistry, s.model),
        s.usageComplete,
        formatCost,
        s.totalCostUsd,
      );
      lines.push(
        `  ${s.id.slice(0, 8)} · ${formatTimestamp(s.startedAt)} · ${status.padEnd(11)} · ${cost} · ${s.model}`,
      );
    }
    return { kind: 'ok', notes: lines };
  },
};
