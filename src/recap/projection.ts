import type { DB } from '../storage/db.ts';
import { listApprovalsByToolCall } from '../storage/repos/approvals.ts';
import { listCheckpointsBySession } from '../storage/repos/checkpoints.ts';
import { listMemoryEventsBySession } from '../storage/repos/memory-events.ts';
import { type Message, listMessagesBySession } from '../storage/repos/messages.ts';
import {
  type Session,
  getSession,
  listChildSessions,
  listSessionsInRange,
} from '../storage/repos/sessions.ts';
import { getSubagentOutput } from '../storage/repos/subagent-outputs.ts';
import { type ToolCall, listToolCallsByMessage } from '../storage/repos/tool-calls.ts';
import {
  RECAP_SCHEMA_VERSION,
  type RecapCommandRun,
  type RecapDecision,
  type RecapFileRead,
  type RecapFileWrite,
  type RecapIntermediate,
  type RecapMemoryProposed,
  type RecapSubagentSpawn,
  type RecapTestRun,
  type RecapTimelineEvent,
} from './types.ts';

// Set of tool names treated as "writes a file at a known path".
// Bash is `writes:true` (CONTRACTS §2.6.3 pessimism) but the path
// it writes is unknowable from input — surfaced under commands_run
// instead.
const FILE_WRITER_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

// Bash family. Every shell call shows up under commands_run; the
// foreground/background variant doesn't matter for category
// assignment (audit consumers can still pivot on
// `tool_calls.tool_name`). It DOES matter for exit-code semantics
// though — see `FOREGROUND_BASH_TOOLS` below.
const BASH_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'bash_background',
  'bash_kill',
  'bash_output',
]);

// Subset of bash tools whose `tool_calls.status='done'` means
// "the command finished and we have an exit code". Today only
// foreground `bash` qualifies. `bash_background` reports done at
// spawn time (the process keeps running afterward); reading its
// `exit_code` from the recap would lie about completion. The
// gate also excludes background calls from the test-runner
// heuristic — a backgrounded `bun test` cannot be honestly
// reported as `passed` because the process state at recap time
// is undecidable. Foreground/background distinction is captured
// here instead of by category-tag on the tool because the
// recap projection is the only consumer that cares about the
// difference today; pushing it into tool metadata is premature.
const FOREGROUND_BASH_TOOLS: ReadonlySet<string> = new Set(['bash']);

const READ_TOOLS: ReadonlySet<string> = new Set(['read_file']);

const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['running']);

// Heuristic match for `outcomes.tests_run` (RECAP.md §5: "tests_run
// — heurística sobre bash commands matching test runners"). Matches
// the head of the command line, after stripping leading `cd …; ` /
// env prefixes via a simple trim. Conservative on purpose: false
// positives in tests_run are worse than false negatives — a missed
// test command shows up under commands_run anyway, but a stray
// `pytest --help` getting flagged as "tests passed" misleads the
// reader about what actually validated the change.
const TEST_RUNNER_PATTERNS: readonly RegExp[] = [
  /^bun(?:\s+(?:run|x))?\s+test\b/,
  /^npm\s+(?:run\s+)?test\b/,
  /^pnpm\s+(?:run\s+)?test\b/,
  /^yarn\s+(?:run\s+)?test\b/,
  /^npx\s+jest\b/,
  /^jest\b/,
  /^vitest\b/,
  /^pytest\b/,
  /^cargo\s+test\b/,
  /^go\s+test\b/,
  /^mvn\s+test\b/,
  /^gradle\s+test\b/,
];

// Strip shell prefixes that commonly precede a test-runner
// command: a `cd`/`pushd` setup, leading env-var assignments,
// and the time/nohup/exec wrappers. Each pass eats one
// boundary-delimited prefix; the loop runs until nothing
// matches, so chained forms (`A=1 cd pkg && bun test`,
// `cd a && cd b && pytest`) collapse correctly. Quoted
// directories with spaces are recognised. The intentional
// limits — no subshell `( ... )`, no command substitution,
// no `find -exec`-style trailing-runner forms — keep the
// regex predictable; those shapes are rare enough in
// agent-emitted commands that the false-negative cost is
// lower than the false-positive risk of trying to parse
// arbitrary shell.
const SHELL_PREFIX_PATTERNS: readonly RegExp[] = [
  // `cd <dir> && ` or `cd <dir>; ` — handles bare, single-
  // quoted, and double-quoted directory tokens.
  /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/,
  // `pushd <dir> && ` / `pushd <dir>; `
  /^pushd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/,
  // `NAME=value ` env-var assignment. Values may be bare,
  // single-quoted, or double-quoted. The trailing whitespace
  // is required so we do not eat into the runner token
  // itself (`NODE_ENV=test` must consume the space before
  // `npm`).
  /^[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/,
  // `time `, `nohup `, `exec ` wrappers.
  /^(?:time|nohup|exec)\s+/,
];

const stripShellPrefixes = (command: string): string => {
  let s = command.trimStart();
  let prev = '';
  while (s !== prev) {
    prev = s;
    for (const rx of SHELL_PREFIX_PATTERNS) {
      s = s.replace(rx, '');
    }
  }
  return s;
};

const isTestRunner = (command: string): boolean => {
  const stripped = stripShellPrefixes(command);
  const head = stripped.split('\n')[0]?.trim() ?? '';
  return TEST_RUNNER_PATTERNS.some((rx) => rx.test(head));
};

const extractTextBlocks = (content: unknown): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out;
};

// Trailing-question heuristic for `unresolvedQuestions`. Walks the
// last few sentences of an assistant text block and returns any
// that end with `?`. Bounded at 3 per message so a long brainstorm
// turn does not flood the recap; bounded at 5 total per scope so a
// pathological session does not blow up the schema-bound array.
const QUESTION_LIMIT_PER_MESSAGE = 3;
const QUESTION_LIMIT_TOTAL = 5;

const extractQuestions = (text: string): string[] => {
  const out: string[] = [];
  // Split on sentence terminators that retain the terminator.
  const parts = text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (let i = parts.length - 1; i >= 0 && out.length < QUESTION_LIMIT_PER_MESSAGE; i -= 1) {
    const part = parts[i];
    if (part?.endsWith('?') && part.length <= 200) {
      out.unshift(part);
    }
  }
  return out;
};

const truncateForDecisionWhat = (s: string, max = 80): string => {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
};

const summarizeToolInputForDecision = (toolName: string, input: unknown): string => {
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string')
      return `${toolName}: ${truncateForDecisionWhat(obj.command)}`;
    if (typeof obj.path === 'string') return `${toolName}: ${truncateForDecisionWhat(obj.path)}`;
    if (typeof obj.url === 'string') return `${toolName}: ${truncateForDecisionWhat(obj.url)}`;
  }
  return toolName;
};

export type RecapScopeOption =
  | { kind: 'session_current'; sessionId: string; limit?: number }
  | { kind: 'session_specific'; sessionId: string }
  | { kind: 'pre_compact'; sessionId: string }
  | { kind: 'day'; cwd: string; date: string }
  | { kind: 'range'; cwd: string; start: number; end: number };

export interface ProjectRecapOptions {
  scope: RecapScopeOption;
  // Defaults to `Date.now()`; override for deterministic tests.
  now?: number;
}

interface SessionBundle {
  session: Session;
  messages: Message[];
  toolCalls: ToolCall[];
}

const loadSessionBundle = (db: DB, session: Session): SessionBundle => {
  const messages = listMessagesBySession(db, session.id);
  const toolCalls: ToolCall[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    toolCalls.push(...listToolCallsByMessage(db, m.id));
  }
  return { session, messages, toolCalls };
};

const dayBoundsUtc = (yyyyMmDd: string): { start: number; end: number } => {
  // Strict YYYY-MM-DD. The CLI parses operator input upstream; this
  // function is reachable only after that gate, so a non-matching
  // string is a programmer bug, not user input.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (m === null) {
    throw new Error(`day scope expects YYYY-MM-DD, got: ${yyyyMmDd}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const start = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Round-trip validation: `Date.UTC` silently normalizes
  // calendar overflows (Feb 31 → Mar 3, month 13 → next-year
  // January, day 0 → previous month's last day). Without this
  // check, an operator typing `/recap day 2026-02-31` would get
  // back a recap of March 3 with no error — silently wrong, the
  // worst failure mode for an audit-shaped surface.
  // Comparing the components the constructor produced against
  // the values the operator typed catches every overflow shape:
  // month 13 / day 32 / Feb 31 / day 0 / month 0 all make AT
  // LEAST one of the three components diverge after the
  // normalization.
  const back = new Date(start);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new Error(`day scope received an invalid calendar date: ${yyyyMmDd}`);
  }
  const end = start + 24 * 60 * 60 * 1000;
  return { start, end };
};

const resolveSessions = (db: DB, scope: RecapScopeOption): Session[] => {
  switch (scope.kind) {
    case 'session_current':
    case 'session_specific':
    case 'pre_compact': {
      const s = getSession(db, scope.sessionId);
      if (s === null) {
        throw new Error(`recap: session ${scope.sessionId} not found`);
      }
      return [s];
    }
    case 'day': {
      const { start, end } = dayBoundsUtc(scope.date);
      // Time predicate applied in SQL via `listSessionsInRange` —
      // the prior `listSessions(limit:500).filter(...)` shape
      // would silently miss older day windows once a project
      // crossed the cap. The `[start, end)` interval matches the
      // half-open day boundary `dayBoundsUtc` produces.
      return listSessionsInRange(db, { start, end, cwd: scope.cwd });
    }
    case 'range': {
      // Operator-supplied range; trust the bounds as-is. Same
      // SQL-side filter rationale as `day` above.
      return listSessionsInRange(db, {
        start: scope.start,
        end: scope.end,
        cwd: scope.cwd,
      });
    }
  }
};

const projectGoal = (bundles: readonly SessionBundle[]): { text: string; sourceStepId: string } => {
  // M4.1 goal_stack table does not exist yet; fallback per RECAP.md
  // §5 row "goal.text" is the first user message of the earliest
  // session in scope.
  for (const b of bundles) {
    for (const m of b.messages) {
      if (m.role !== 'user') continue;
      const text =
        typeof m.content === 'string' ? m.content : (extractTextBlocks(m.content)[0] ?? '');
      if (text.length > 0) {
        return { text, sourceStepId: m.id };
      }
    }
  }
  return { text: '', sourceStepId: '' };
};

const extractExitCode = (tc: ToolCall): number => {
  // tool_calls.output for bash carries `{ exit_code: number, ... }`
  // when the harness completed the call. status='error' / 'denied'
  // paths often have null output — surface a sentinel so the
  // renderer can flag them.
  const out = tc.output as Record<string, unknown> | null;
  if (out !== null && typeof out === 'object') {
    if (typeof out.exit_code === 'number') return out.exit_code;
  }
  if (tc.status === 'done') return 0;
  // -1 marks "no exit code observed" without colliding with valid
  // POSIX exit codes (0..255). Renderer can decide how to display.
  return -1;
};

export const projectRecap = (db: DB, options: ProjectRecapOptions): RecapIntermediate => {
  const now = options.now ?? Date.now();
  const sessions = resolveSessions(db, options.scope);
  const bundles = sessions.map((s) => loadSessionBundle(db, s));

  // Deterministic ordering: oldest first. day/range scope returns
  // sessions in DESC start order from listSessions; flip so the
  // resulting timeline + goal extraction pick the chronological
  // anchor.
  bundles.sort((a, b) => a.session.startedAt - b.session.startedAt);

  const incompleteSessions = bundles
    .filter((b) => NON_TERMINAL_STATUSES.has(b.session.status))
    .map((b) => b.session.id);

  const sessionIds = bundles.map((b) => b.session.id);

  // Apply step limit for session_current. The limit truncates the
  // last N user/assistant message pairs from the working set; tool
  // calls are filtered to the same window. Other scope kinds ignore
  // the limit.
  if (options.scope.kind === 'session_current' && options.scope.limit !== undefined) {
    const limit = options.scope.limit;
    for (const b of bundles) {
      const stepStarts: number[] = [];
      for (let i = 0; i < b.messages.length; i += 1) {
        const m = b.messages[i];
        if (m !== undefined && m.role === 'user') stepStarts.push(i);
      }
      if (stepStarts.length > limit) {
        const cutoff = stepStarts[stepStarts.length - limit] ?? 0;
        const keptIds = new Set<string>();
        b.messages = b.messages.slice(cutoff);
        for (const m of b.messages) keptIds.add(m.id);
        b.toolCalls = b.toolCalls.filter((tc) => keptIds.has(tc.messageId));
      }
    }
  }

  const goal = projectGoal(bundles);

  // Actions — second pass with proper db access, replacing the
  // stand-in walks above.
  const readsByPath = new Map<string, number>();
  // filesWritten is aggregated by path so an iterative-edit flow
  // (read → edit → edit again → edit once more, all touching
  // `src/foo.ts`) produces ONE entry per file, not N. Without this,
  // "## Files edited" listed the same path repeatedly and the
  // "## What changed" headline showed inflated counts ("4 files
  // edited" for 4 edits to a single file).
  //
  // Map preserves first-seen insertion order, which matches the
  // chronological order of the bash-tool dispatch loop (oldest
  // tool_call first via the `seq`-ordered messages query). Audit
  // consumers reading the json envelope see paths in the order
  // they were first touched. When `linesAdded` / `linesRemoved`
  // become real (currently 0/0 placeholders), accumulating them
  // here is the natural extension — sum across siblings within
  // the same path key.
  const writesByPath = new Map<string, RecapFileWrite>();
  const commandsRun: RecapCommandRun[] = [];
  const subagentsSpawned: RecapSubagentSpawn[] = [];
  const checkpointsRefs: { id: string; stepId: string; filesAffected: number }[] = [];
  const testsRun: RecapTestRun[] = [];
  const decisions: RecapDecision[] = [];
  const memoryProposed: RecapMemoryProposed[] = [];
  const timeline: RecapTimelineEvent[] = [];
  const unresolvedQuestions: string[] = [];

  let tokensIn = 0;
  let tokensOut = 0;
  let cachedTokens = 0;
  let usd = 0;
  let durationMs = 0;
  const models = new Set<string>();

  for (const b of bundles) {
    models.add(b.session.model);
    durationMs += (b.session.endedAt ?? now) - b.session.startedAt;
    timeline.push({
      ts: b.session.startedAt,
      event: 'session_start',
      detail: b.session.id,
    });
    if (b.session.endedAt !== null) {
      timeline.push({
        ts: b.session.endedAt,
        event: 'session_end',
        detail: `${b.session.id} (${b.session.status})`,
      });
    }

    for (const m of b.messages) {
      tokensIn += m.tokensIn ?? 0;
      tokensOut += m.tokensOut ?? 0;
      cachedTokens += m.cachedTokens ?? 0;
      usd += m.costUsd ?? 0;
      if (m.role === 'assistant') {
        for (const text of extractTextBlocks(m.content)) {
          for (const q of extractQuestions(text)) {
            if (unresolvedQuestions.length < QUESTION_LIMIT_TOTAL) {
              unresolvedQuestions.push(q);
            }
          }
        }
      }
    }

    for (const tc of b.toolCalls) {
      // Action aggregates (filesRead / filesWritten / commandsRun
      // / testsRun) describe what THE SESSION ACTUALLY DID. Only
      // tool_calls that reached `status='done'` count: a denied
      // write_file never touched the filesystem and a denied
      // bash never executed, so reporting them as edits / runs
      // would be straight-up false. `error` (the body returned a
      // ToolError or threw before producing a result) is also
      // excluded — the harness's failure shape is opaque enough
      // that "the call ran but errored" vs. "the call never
      // reached the body" is undecidable at this layer; safer
      // to leave the row out of the action counts and let the
      // approvals/decisions loop below surface the gating signal
      // separately. `pending` / `running` are likewise filtered
      // (a recap projected mid-tool would otherwise inflate
      // counts with calls that haven't settled).
      if (tc.status === 'done') {
        const input = tc.input as Record<string, unknown> | null;
        if (READ_TOOLS.has(tc.toolName)) {
          const path = typeof input?.path === 'string' ? input.path : '';
          if (path.length > 0) {
            readsByPath.set(path, (readsByPath.get(path) ?? 0) + 1);
          }
        } else if (FILE_WRITER_TOOLS.has(tc.toolName)) {
          const path = typeof input?.path === 'string' ? input.path : '';
          if (path.length > 0 && !writesByPath.has(path)) {
            // First write to this path lands the entry; subsequent
            // writes to the same path collapse silently (they DID
            // happen, but the "files edited" view is per-file, not
            // per-call). When real line deltas arrive, the
            // collapse becomes accumulation: read existing entry,
            // sum linesAdded/linesRemoved, write back.
            writesByPath.set(path, {
              path,
              linesAdded: 0,
              linesRemoved: 0,
              semanticSummary: '',
            });
          }
        } else if (BASH_TOOLS.has(tc.toolName)) {
          const command = typeof input?.command === 'string' ? input.command : '';
          if (command.length > 0) {
            const isForeground = FOREGROUND_BASH_TOOLS.has(tc.toolName);
            // Background bash variants exit to `done` at spawn,
            // not at process exit — `extractExitCode` would
            // return 0 (the "done with no exit_code" fallback)
            // and the recap would falsely report success. Use
            // the -1 sentinel ("no exit observed") which the
            // renderer can flag visually. Audit consumers
            // branching on exit_code already treat negative
            // values as "no signal", so this preserves their
            // existing assumptions.
            const exitCode = isForeground ? extractExitCode(tc) : -1;
            commandsRun.push({ command, exitCode, durationMs: tc.durationMs ?? 0 });
            // Test-runner heuristic gated to foreground only. A
            // backgrounded `bun test` produces no recap-time
            // signal of pass/fail; reporting it as `passed:true`
            // because the spawn succeeded would mislead the
            // operator about validation outcome. The command
            // still appears under commandsRun above (with
            // exitCode=-1) so it is not silently dropped.
            if (isForeground && isTestRunner(command)) {
              testsRun.push({
                command,
                passed: exitCode === 0,
                durationMs: tc.durationMs ?? 0,
              });
            }
          }
        }
      }

      // Approvals → decisions. We surface only user/hook decisions
      // and explicit denies; pure policy auto-allows are noise (the
      // operator made no choice, the rule did). For each approval,
      // step_id is the tool_call's host message_id.
      // NB: this loop is OUTSIDE the `status === 'done'` gate above
      // — a denied call IS the source of a decision row, so
      // filtering at the action layer must not collapse the audit
      // trail of WHY the call did not run.
      const approvals = listApprovalsByToolCall(db, tc.id);
      for (const a of approvals) {
        const isInteresting =
          a.decidedBy === 'user' ||
          a.decidedBy === 'hook' ||
          a.decision === 'deny' ||
          a.decision === 'confirm_no';
        if (!isInteresting) continue;
        decisions.push({
          stepId: tc.messageId,
          what: summarizeToolInputForDecision(tc.toolName, tc.input),
          why: a.reason ?? '',
          decidedBy: a.decidedBy,
        });
        timeline.push({
          ts: a.decidedAt,
          event: `approval_${a.decision}`,
          detail: `${tc.toolName} (${a.decidedBy})`,
        });
      }
    }

    // Subagent children of this session. `listChildSessions` SQL-
    // filters on `parent_session_id` and returns oldest-first, so
    // the natural call order is preserved (operator reading the
    // recap sees subagent[0] before subagent[1] as they were
    // dispatched). Orphans (parent purged → parent_session_id NULL)
    // are excluded structurally by the WHERE clause.
    const children = listChildSessions(db, b.session.id);
    for (const child of children) {
      const payload = getSubagentOutput(db, child.id);
      let outputSummary = '';
      if (payload?.payload !== undefined && payload?.payload !== null) {
        const env = payload.payload as Record<string, unknown>;
        if (typeof env.summary === 'string') outputSummary = env.summary;
        else if (typeof env.output === 'string') outputSummary = env.output.slice(0, 200);
      }
      subagentsSpawned.push({
        name: child.id,
        status: child.status,
        outputSummary,
      });
      timeline.push({
        ts: child.startedAt,
        event: 'subagent_spawned',
        detail: child.id,
      });
    }

    for (const cp of listCheckpointsBySession(db, b.session.id)) {
      checkpointsRefs.push({
        id: cp.id,
        stepId: cp.stepId,
        // M4.1: filesAffected requires git diff against the
        // checkpoint ref. Emitting 0 keeps the schema bound; a
        // follow-up wires the diff.
        filesAffected: 0,
      });
      timeline.push({ ts: cp.createdAt, event: 'checkpoint', detail: cp.id });
    }

    for (const ev of listMemoryEventsBySession(db, b.session.id)) {
      if (ev.action !== 'proposed') continue;
      memoryProposed.push({
        name: ev.memoryName,
        scope: ev.scope,
        accepted: false,
      });
    }
  }

  // Three-key total order: ts → event → detail. Returning 0 for
  // truly equal entries respects the comparator contract; without
  // it, equal (ts, event) pairs would fall through to `: 1` and
  // make the sort non-antisymmetric (cmp(a,b) and cmp(b,a) would
  // both return 1), which V8's TimSort can resolve unpredictably
  // across runs / engines. The `detail` tiebreaker exists so two
  // approvals decided in the same millisecond on different tools
  // still render in a deterministic order even when their event
  // labels coincide (e.g., two `approval_allow` events).
  timeline.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.event !== b.event) return a.event < b.event ? -1 : 1;
    if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1;
    return 0;
  });

  const filesRead: RecapFileRead[] = [...readsByPath.entries()]
    .map(([path, count]): RecapFileRead => ({ path, count }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const cacheHitRatio = tokensIn > 0 ? cachedTokens / tokensIn : 0;
  const model = models.size === 1 ? ([...models][0] ?? '') : '';

  // Range bounds: explicit for day/range scopes, zero-pair for
  // single-session scopes. Always present (schema-bound).
  const range =
    options.scope.kind === 'day'
      ? dayBoundsUtc(options.scope.date)
      : options.scope.kind === 'range'
        ? { start: options.scope.start, end: options.scope.end }
        : { start: 0, end: 0 };

  const incomplete = incompleteSessions.length > 0;
  const incompleteReason = incomplete
    ? `${incompleteSessions.length} session(s) in non-terminal state`
    : '';

  return {
    schemaVersion: RECAP_SCHEMA_VERSION,
    generatedAt: now,
    scope: {
      kind: options.scope.kind,
      sessionIds,
      range,
    },
    completeness: {
      incomplete,
      incompleteSessions,
      incompleteReason,
    },
    goal,
    goalStack: [],
    decisions,
    pinnedContext: [],
    actions: {
      filesRead,
      // Drain the path-keyed Map. Map iteration preserves
      // insertion order, so callers see paths in the order they
      // were first touched in the session.
      filesWritten: [...writesByPath.values()],
      commandsRun,
      webFetches: [],
      subagentsSpawned,
    },
    outcomes: {
      testsRun,
      checkpoints: checkpointsRefs,
      artifacts: [],
    },
    timeline,
    costs: {
      tokens: { in: tokensIn, out: tokensOut, cached: cachedTokens },
      usd,
      durationMs,
      model,
      cacheHitRatio,
    },
    errors: [],
    notDone: [],
    unresolvedQuestions,
    memoryProposed,
  };
};
