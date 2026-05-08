import type { DB } from '../storage/db.ts';
import { listApprovalsByToolCall } from '../storage/repos/approvals.ts';
import { listCheckpointsBySession } from '../storage/repos/checkpoints.ts';
import { listMemoryEventsBySession } from '../storage/repos/memory-events.ts';
import { type Message, listMessagesBySession } from '../storage/repos/messages.ts';
import { type Session, getSession, listSessions } from '../storage/repos/sessions.ts';
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
// foreground/background variant doesn't matter for the projection
// (audit consumers can still pivot on tool_calls.tool_name).
const BASH_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'bash_background',
  'bash_kill',
  'bash_output',
]);

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

const isTestRunner = (command: string): boolean => {
  const head = command.trimStart().split('\n')[0]?.trim() ?? '';
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
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
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
      // listSessions filters by cwd at the SQL layer; we apply the
      // ts window in JS since listSessions doesn't accept a time
      // range yet (and adding one is a separate refactor we do not
      // want to fold into the recap slice). Cap at a generous 500 —
      // an order of magnitude beyond a heavy workday — so a runaway
      // does not OOM the projection.
      const all = listSessions(db, { cwd: scope.cwd, limit: 500 });
      return all.filter((s) => s.startedAt >= start && s.startedAt < end);
    }
    case 'range': {
      const all = listSessions(db, { cwd: scope.cwd, limit: 500 });
      return all.filter((s) => s.startedAt >= scope.start && s.startedAt < scope.end);
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
  const filesWritten: RecapFileWrite[] = [];
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
      const input = tc.input as Record<string, unknown> | null;
      if (READ_TOOLS.has(tc.toolName)) {
        const path = typeof input?.path === 'string' ? input.path : '';
        if (path.length > 0) {
          readsByPath.set(path, (readsByPath.get(path) ?? 0) + 1);
        }
      } else if (FILE_WRITER_TOOLS.has(tc.toolName)) {
        const path = typeof input?.path === 'string' ? input.path : '';
        if (path.length > 0) {
          filesWritten.push({
            path,
            linesAdded: 0,
            linesRemoved: 0,
            semanticSummary: '',
          });
        }
      } else if (BASH_TOOLS.has(tc.toolName)) {
        const command = typeof input?.command === 'string' ? input.command : '';
        if (command.length > 0) {
          const exitCode = extractExitCode(tc);
          commandsRun.push({ command, exitCode, durationMs: tc.durationMs ?? 0 });
          if (isTestRunner(command)) {
            testsRun.push({
              command,
              passed: exitCode === 0,
              durationMs: tc.durationMs ?? 0,
            });
          }
        }
      }

      // Approvals → decisions. We surface only user/hook decisions
      // and explicit denies; pure policy auto-allows are noise (the
      // operator made no choice, the rule did). For each approval,
      // step_id is the tool_call's host message_id.
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

    // Subagent children of this session. `parent_session_id` is
    // the FK; orphans (parent purged) are excluded via the IDENTITY
    // flag check inside listSessions's includeSubagents path.
    const children = listSessions(db, {
      includeSubagents: true,
      limit: 500,
    }).filter((s) => s.parentSessionId === b.session.id);
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

  timeline.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.event < b.event ? -1 : 1));

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
      filesWritten,
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
