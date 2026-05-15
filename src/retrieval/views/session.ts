// Session view (RETRIEVAL.md §3.1 + §3.2).
//
// Source: session-scoped rows from three repos. v1 projects the
// session graph implicit in `messages`, `tool_calls`, and
// `failure_events` (RETRIEVAL §15.1 calls these "structures that
// ARE edges"). No new store; the graph is logical.
//
// Per spec §3.2:
//   - "Session: match sobre goal text, task description, failure
//     reason. Recência boost."
//
// What we project as candidates (one logical "node" per row):
//
//   - Messages: role + content. The user's prompt carries the
//     goal text; the assistant's text carries plan / explanation.
//     Token stream pulled from the content payload (handles both
//     legacy string form and Anthropic-shaped content blocks).
//
//   - Tool calls: tool name + JSON-stringified input. The
//     bash-command text, the path being read, the memory name —
//     all surface here. We DO NOT pull output text because tool
//     outputs are unbounded (sometimes megabytes of stdout) and
//     would dominate the corpus without producing useful signal.
//     Slice 4.7 (compression) can resolve outputs at `full` level
//     for selected candidates; the corpus stays lean.
//
//   - Failure events: code + classe + recovery_action + payload.
//     Matches the spec example "failure reason".
//
// Temporal decay (§4.3 half-life 1h for session) is INTENTIONALLY
// NOT applied at the bootstrap stage. Spec §4.3 places decay at
// the ranking signal layer (slice 4.6) so the trace records
// undecayed BM25 scores — eval replay can re-rank against truth
// without unwinding the decay first. The "recência boost" the
// spec mentions for session §3.2 manifests in the ranking
// signal_temporal weight, which is heaviest for the debug
// workflow (§5.2).

import type { DB } from '../../storage/db.ts';
import {
  type FailureEventRow,
  listFailureEventsBySession,
} from '../../storage/repos/failure-events.ts';
import { type Message, listMessagesBySession } from '../../storage/repos/messages.ts';
import { type BM25Document, createBM25Index, tokenize } from '../bm25.ts';
import type { ViewSearch } from '../pipeline.ts';
import type { Candidate, RetrievalQuery, RetrievalView } from '../types.ts';

const VIEW: RetrievalView = 'session';

const DEFAULT_LIMIT = 30;

// Field-weight policy. The role weight on messages mirrors the
// memory view's title × 3 / description × 2 split — operator goals
// (the user prompt) are 3× more identifying than mid-conversation
// assistant text. Same calibration intent: name-of-thing > body-
// of-thing.
const USER_MESSAGE_WEIGHT = 3;
const ASSISTANT_MESSAGE_WEIGHT = 1;
const TOOL_MESSAGE_WEIGHT = 1;
const TOOL_NAME_WEIGHT = 3;
const TOOL_INPUT_WEIGHT = 1;
const FAILURE_CODE_WEIGHT = 3;
const FAILURE_BODY_WEIGHT = 1;

// Node id formats. Scoped by row kind so the trace makes the
// substrate visible at a glance.
const messageNodeId = (id: string): string => `session:message:${id}`;
const toolCallNodeId = (id: string): string => `session:tool_call:${id}`;
const failureNodeId = (id: string): string => `session:failure:${id}`;

// Pull readable text from a message's `content` payload. Anthropic
// returns content as an array of typed blocks (`text`, `tool_use`,
// `tool_result`); older code stores plain strings. Both shapes
// flow through `parseJsonSafe` in the messages repo. We DO NOT
// assert a shape — anything unrecognized falls through to
// JSON.stringify so the token stream still gets the substantive
// words even if the wrapper changes.
const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const obj = block as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        parts.push(obj.text);
        continue;
      }
      if (typeof obj.content === 'string') {
        parts.push(obj.content);
        continue;
      }
      // Tool-shaped blocks (tool_use / tool_result) — stringify
      // their payload so a query for the bash command surfaces
      // the message that issued it.
      if (obj.input !== undefined) {
        parts.push(JSON.stringify(obj.input));
        continue;
      }
      // Fallback so we don't silently drop unknown block shapes.
      parts.push(JSON.stringify(obj));
    }
    return parts.join(' ');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
};

interface ToolCallRow {
  id: string;
  message_id: string;
  tool_name: string;
  input: string;
  output: string | null;
  status: string;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

// Tool calls don't carry a `session_id` directly — they're scoped
// via `message_id → messages.session_id`. We do the JOIN here so
// the view stays self-contained.
const listToolCallsBySession = (db: DB, sessionId: string): ToolCallRow[] =>
  db
    .query<ToolCallRow, [string]>(
      `SELECT tc.id, tc.message_id, tc.tool_name, tc.input, tc.output,
              tc.status, tc.duration_ms, tc.error, tc.created_at
         FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY tc.created_at ASC`,
    )
    .all(sessionId);

export interface SessionViewDeps {
  db: DB;
  sessionId: string;
  // Top-K cap on candidates produced by this view. Spec doesn't
  // fix a number; 30 covers a moderately busy session (10-20
  // messages + 5-10 tool calls + occasional failures).
  limit?: number;
}

export const createSessionView = (deps: SessionViewDeps): ViewSearch => ({
  async search(query: RetrievalQuery): Promise<Candidate[]> {
    if (tokenize(query.text).length === 0) return [];
    const limit = deps.limit ?? DEFAULT_LIMIT;

    // Build the corpus. Each row from each source contributes one
    // doc; field weighting expressed via token repetition matches
    // the memory view's pattern.
    const docs: BM25Document[] = [];
    // Side tables for the projection step. We keep typed lookups
    // here so the reason string + node id resolution after BM25
    // doesn't need to re-query the DB.
    const messageById = new Map<string, Message>();
    const toolCallById = new Map<string, ToolCallRow>();
    const failureById = new Map<string, FailureEventRow>();

    // Messages.
    const messages = listMessagesBySession(deps.db, deps.sessionId);
    for (const msg of messages) {
      messageById.set(msg.id, msg);
      const text = messageText(msg.content);
      const textTokens = tokenize(text);
      const tokens: string[] = [];
      const repeat =
        msg.role === 'user'
          ? USER_MESSAGE_WEIGHT
          : msg.role === 'assistant'
            ? ASSISTANT_MESSAGE_WEIGHT
            : TOOL_MESSAGE_WEIGHT;
      for (let i = 0; i < repeat; i++) tokens.push(...textTokens);
      docs.push({ id: messageNodeId(msg.id), tokens });
    }

    // Tool calls.
    const toolCalls = listToolCallsBySession(deps.db, deps.sessionId);
    for (const tc of toolCalls) {
      toolCallById.set(tc.id, tc);
      const nameTokens = tokenize(tc.tool_name);
      // input is raw JSON string from the DB. Tokenize directly —
      // ASCII split surfaces the substantive words ("grep", "src",
      // "auth", paths' segments) without us needing to JSON.parse
      // every row.
      //
      // This deliberately also surfaces JSON keys (`command`,
      // `path`, etc.) as tokens. They add noise (a query like
      // `command` matches every bash row), but BM25 IDF dampens
      // it — keys that appear in every doc carry near-zero
      // contribution. The simpler tokenizer wins until eval shows
      // measurable harm.
      const inputTokens = tokenize(tc.input);
      const tokens: string[] = [];
      for (let i = 0; i < TOOL_NAME_WEIGHT; i++) tokens.push(...nameTokens);
      for (let i = 0; i < TOOL_INPUT_WEIGHT; i++) tokens.push(...inputTokens);
      docs.push({ id: toolCallNodeId(tc.id), tokens });
    }

    // Failure events.
    const failures = listFailureEventsBySession(deps.db, deps.sessionId);
    for (const fe of failures) {
      failureById.set(fe.id, fe);
      const codeTokens = [
        ...tokenize(fe.code),
        ...tokenize(fe.classe),
        ...tokenize(fe.recovery_action),
      ];
      const bodyTokens = fe.payload_json !== null ? tokenize(fe.payload_json) : ([] as string[]);
      const tokens: string[] = [];
      for (let i = 0; i < FAILURE_CODE_WEIGHT; i++) tokens.push(...codeTokens);
      for (let i = 0; i < FAILURE_BODY_WEIGHT; i++) tokens.push(...bodyTokens);
      docs.push({ id: failureNodeId(fe.id), tokens });
    }

    if (docs.length === 0) return [];

    const index = createBM25Index(docs);
    const hits = index.topK(query.text, limit);

    return hits.map((hit) => {
      // Compose the reason string per row kind. Operator-readable;
      // free of paths (those that come through messages/tool input
      // get scrubbed at the trace persist layer in slice 4.1).
      const messageMatch = hit.id.startsWith('session:message:')
        ? messageById.get(hit.id.slice('session:message:'.length))
        : undefined;
      if (messageMatch !== undefined) {
        return {
          nodeId: hit.id,
          view: VIEW,
          bootstrapScore: hit.score,
          reason: `BM25 match in ${messageMatch.role} message`,
        };
      }
      const toolCallMatch = hit.id.startsWith('session:tool_call:')
        ? toolCallById.get(hit.id.slice('session:tool_call:'.length))
        : undefined;
      if (toolCallMatch !== undefined) {
        return {
          nodeId: hit.id,
          view: VIEW,
          bootstrapScore: hit.score,
          reason: `BM25 match in tool_call(${toolCallMatch.tool_name})`,
        };
      }
      const failureMatch = hit.id.startsWith('session:failure:')
        ? failureById.get(hit.id.slice('session:failure:'.length))
        : undefined;
      if (failureMatch !== undefined) {
        return {
          nodeId: hit.id,
          view: VIEW,
          bootstrapScore: hit.score,
          reason: `BM25 match in failure_event(${failureMatch.code})`,
        };
      }
      // Map miss would be a bug — fall through with a safe shape
      // rather than crash. The unknown-kind reason makes it
      // distinguishable in the trace if it ever surfaces.
      return {
        nodeId: hit.id,
        view: VIEW,
        bootstrapScore: hit.score,
        reason: 'BM25 match in unknown session source',
      };
    });
  },
});
