// /sessions — list recent sessions from the DB.
//
// Reads via `listSessions()` (excludes subagent runs by default),
// scoped to the current cwd to match the `--resume last` behavior
// (operator running multiple repos doesn't want unrelated sessions
// cluttering the list). Defaults to 10 most recent; first arg
// overrides the limit (`/sessions 25`).

import { listSessions } from '../../../storage/index.ts';
import { formatCost } from '../format.ts';
import type { SlashCommand } from '../types.ts';

const formatTimestamp = (ms: number): string => {
  const d = new Date(ms);
  // ISO date+time, second precision, no TZ suffix (operator reads
  // session times relative to wall clock, not UTC).
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}`;
};

// Sessions can have incomplete usage telemetry — prefix with `~`
// to mark the cost as a lower bound.
const formatSessionCost = (usd: number, complete: boolean): string =>
  complete ? formatCost(usd) : `~${formatCost(usd)}`;

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
      const cost = formatSessionCost(s.totalCostUsd, s.usageComplete);
      lines.push(
        `  ${s.id.slice(0, 8)} · ${formatTimestamp(s.startedAt)} · ${status.padEnd(11)} · ${cost} · ${s.model}`,
      );
    }
    return { kind: 'ok', notes: lines };
  },
};
