// /recap — projected view over the audit log. Spec: RECAP.md.
//
// Slice (c) of M4.1 wires the projection (slice a) + renderers
// (slice b) into the REPL slash surface. Subcommands shipped:
//
//   /recap                 → current session, human render, last 10 steps
//   /recap last <N>        → current session, human render, last N steps
//   /recap session <id>    → specific session, human render, full
//   /recap json            → current session, raw intermediate
//   /recap json session <id> → specific session, raw intermediate
//
// Every successful invocation writes a `recap_runs` audit row
// (RECAP.md §6.3) so anomalous use (a runaway script, an unexpected
// scope) is detectable. Parse errors and projection failures
// (unknown session id) deliberately do NOT write a row — those
// never consumed audit-worthy resources, and recording them would
// inflate the anomaly-detection signal with operator typos.
//
// Other forms from RECAP.md §1 (`/recap day`, `/recap range`,
// `/recap pre-compact`, `/recap pr|changelog|slack|terse`) wait on
// their respective milestones (M4.2 LLM renderers, M4.3 cross-
// session); the parser surfaces a clear "not yet available" message
// rather than silently no-opping.

import { type RecapScopeOption, projectRecap } from '../../../recap/projection.ts';
import { renderHuman, renderJson } from '../../../recap/render.ts';
import { recordRecapRun } from '../../../storage/repos/recap-runs.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const DEFAULT_STEP_LIMIT = 10;

interface ParsedRecap {
  format: 'human' | 'json';
  scope:
    | { kind: 'session_current'; limit: number }
    | { kind: 'session_specific'; sessionId: string };
}

const positiveInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const FUTURE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'day',
  'range',
  'pre-compact',
  'pr',
  'changelog',
  'slack',
  'terse',
  'list',
]);

const futureSubcommandMessage = (sub: string): string => {
  if (sub === 'pr' || sub === 'changelog' || sub === 'slack' || sub === 'terse') {
    return `/recap: '${sub}' renderer needs the LLM render path (M4.2); not yet available`;
  }
  if (sub === 'day' || sub === 'range') {
    return `/recap: '${sub}' is cross-session scope (M4.3); not yet available`;
  }
  if (sub === 'pre-compact') {
    return `/recap: 'pre-compact' needs Context Engine wiring (M4.3); not yet available`;
  }
  // 'list'
  return `/recap: 'list' needs recap_mini cache (M4.2); not yet available`;
};

// Parse the subcommand vocabulary into a tagged union or a SlashResult
// error. Pure: no DB access, no ctx — ctx-dependent decisions
// (resolving the current session id) happen in the executor below.
//
// Rejected up-front:
//   - more than 3 args (no recognized form needs more)
//   - mixing `last <N>` with `session <id>` in the same invocation
//   - non-positive step limits
const parseRecapArgs = (args: string[]): ParsedRecap | { error: string } => {
  if (args.length === 0) {
    return { format: 'human', scope: { kind: 'session_current', limit: DEFAULT_STEP_LIMIT } };
  }
  let format: 'human' | 'json' = 'human';
  let i = 0;
  if (args[0] === 'json') {
    format = 'json';
    i = 1;
  }
  if (i === args.length) {
    return { format, scope: { kind: 'session_current', limit: DEFAULT_STEP_LIMIT } };
  }
  const head = args[i];
  if (head === 'last') {
    const next = args[i + 1];
    if (next === undefined) {
      return { error: '/recap last: missing step count (e.g. /recap last 5)' };
    }
    const n = positiveInt(next);
    if (n === null) {
      return {
        error: `/recap last: invalid step count '${next}' (must be a positive integer)`,
      };
    }
    if (i + 2 < args.length) {
      return { error: '/recap last: takes exactly one argument' };
    }
    return { format, scope: { kind: 'session_current', limit: n } };
  }
  if (head === 'session') {
    const next = args[i + 1];
    if (next === undefined || next.length === 0) {
      return { error: '/recap session: missing session id' };
    }
    if (i + 2 < args.length) {
      return { error: '/recap session: takes exactly one argument (the session id)' };
    }
    return { format, scope: { kind: 'session_specific', sessionId: next } };
  }
  if (head !== undefined && FUTURE_SUBCOMMANDS.has(head)) {
    return { error: futureSubcommandMessage(head) };
  }
  return {
    error: `/recap: unknown subcommand '${head ?? ''}' (try /recap, /recap last <N>, /recap session <id>, /recap json)`,
  };
};

const renderToNotes = (text: string): string[] => {
  // Renderers emit a trailing newline (human: explicit; json: stable
  // shape from JSON.stringify pretty mode). Drop it before splitting
  // so the last "note" isn't an empty line that the bus would
  // surface as a phantom blank info entry. Splitting on `\n` (not
  // `\r?\n`) is correct because both renderers emit pure LF.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
};

export const recapCommand: SlashCommand = {
  name: 'recap',
  description: 'projected view over this session (or another by id)',
  exec: async (args, ctx: SlashContext): Promise<SlashResult> => {
    const parsed = parseRecapArgs(args);
    if ('error' in parsed) {
      return { kind: 'error', message: parsed.error };
    }

    let scope: RecapScopeOption;
    if (parsed.scope.kind === 'session_current') {
      const sessionId = ctx.currentSessionId();
      if (sessionId === null) {
        return {
          kind: 'error',
          message: '/recap: no active session yet (run a turn first, or use /recap session <id>)',
        };
      }
      scope = { kind: 'session_current', sessionId, limit: parsed.scope.limit };
    } else {
      scope = { kind: 'session_specific', sessionId: parsed.scope.sessionId };
    }

    let intermediate: ReturnType<typeof projectRecap>;
    try {
      intermediate = projectRecap(ctx.db, { scope, now: ctx.now() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'error', message: `/recap: ${message}` };
    }

    const output = parsed.format === 'json' ? renderJson(intermediate) : renderHuman(intermediate);

    // Audit the run BEFORE returning. Records the actual sessions
    // touched (post-resolution), the renderer used, and whether the
    // LLM was involved (always false in M4.1). Failures here would
    // surface as a slash-command crash; per RECAP.md §6.3 the row
    // is informational — losing one is preferable to losing the
    // user's recap output, but we treat insertion as a normal write
    // and let any DB error surface.
    recordRecapRun(ctx.db, {
      scopeKind: scope.kind,
      sessionIds: intermediate.scope.sessionIds,
      renderer: parsed.format,
      usedLlm: false,
      createdAt: ctx.now(),
    });

    return { kind: 'ok', notes: renderToNotes(output) };
  },
};
