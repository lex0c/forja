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

import { type DB, withTransaction } from '../../storage/db.ts';
import {
  type FailureEventRow,
  listFailureEventsBySession,
} from '../../storage/repos/failure-events.ts';
import { type Message, listMessagesBySession } from '../../storage/repos/messages.ts';
import { type BM25Document, createBM25Index, tokenize } from '../bm25.ts';
import { parseSessionNodeId } from '../node-ids.ts';
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
  // `_signal` accepted per the ViewSearch contract but ignored —
  // this view is synchronous over SQLite reads against the active
  // session; there's no subprocess or long IO to cancel. The
  // pipeline's between-stage `checkAborted` covers bail-out.
  async search(query: RetrievalQuery, _signal?: AbortSignal): Promise<Candidate[]> {
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

    // Wrap the three substrate reads in a single transaction so
    // they see a consistent snapshot of the session. Without it,
    // a new message inserted between read 1 (messages) and read 2
    // (tool_calls) could leave the corpus with a toolcall whose
    // parent message exists in the DB but not in `messageById`
    // — the projection step then falls through to a generic
    // "unknown session source" reason for a row that's genuinely
    // valid. WAL mode + DEFERRED transaction is the right shape:
    // readers don't block writers; the BEGIN's snapshot is stable
    // through COMMIT for ALL reads inside it.
    withTransaction(deps.db, () => {
      // Messages.
      const messages = listMessagesBySession(deps.db, deps.sessionId);
      for (const msg of messages) {
        messageById.set(msg.id, msg);
        // Operator un-sent this turn (migration 079): keep it OUT of the
        // retrieval index so a later retrieve_context query can't surface the
        // cancelled text back to the model — the same model-facing exclusion the
        // resume rebuild applies (messagesToProviderMessages). The row stays in
        // the log; messageById keeps it for parent/projection lookups.
        if (msg.retractedAt !== null) continue;
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
    });

    if (docs.length === 0) return [];

    const index = createBM25Index(docs);
    const hits = index.topK(query.text, limit);

    return hits.map((hit) => {
      // Compose the reason string per row kind. Operator-readable;
      // free of paths (those that come through messages/tool input
      // get scrubbed at the trace persist layer in slice 4.1).
      // Each row carries its createdAt so the ranking temporal
      // signal can decay against the session half-life (§4.3).
      //
      // The parser enforces the invariants:
      //   - prefix is `session:`
      //   - kind ∈ { message, tool_call, failure }
      //   - id is non-empty after the second colon
      // Without it, a malformed id matching `session:message:` with
      // an empty UUID after would slice to `""`, the Map miss
      // would fall through to the generic "unknown session source"
      // reason, and the invariant breach would go unnoticed. The
      // parser returns null for any of those shapes; we log so a
      // BM25 invariant breach surfaces.
      const parsed = parseSessionNodeId(hit.id);
      if (parsed === null) {
        process.stderr.write(
          `forja retrieval session view: BM25 emitted malformed node id '${hit.id}'; dropping (this is a view-internal bug)\n`,
        );
        return {
          nodeId: hit.id,
          view: VIEW,
          bootstrapScore: hit.score,
          reason: 'BM25 match in malformed session node id (dropped)',
        };
      }
      if (parsed.kind === 'message') {
        const messageMatch = messageById.get(parsed.id);
        if (messageMatch !== undefined) {
          return {
            nodeId: hit.id,
            view: VIEW,
            bootstrapScore: hit.score,
            reason: `BM25 match in ${messageMatch.role} message`,
            createdAt: messageMatch.createdAt,
          };
        }
      } else if (parsed.kind === 'tool_call') {
        const toolCallMatch = toolCallById.get(parsed.id);
        if (toolCallMatch !== undefined) {
          return {
            nodeId: hit.id,
            view: VIEW,
            bootstrapScore: hit.score,
            reason: `BM25 match in tool_call(${toolCallMatch.tool_name})`,
            createdAt: toolCallMatch.created_at,
          };
        }
      } else if (parsed.kind === 'failure') {
        const failureMatch = failureById.get(parsed.id);
        if (failureMatch !== undefined) {
          return {
            nodeId: hit.id,
            view: VIEW,
            bootstrapScore: hit.score,
            reason: `BM25 match in failure_event(${failureMatch.code})`,
            createdAt: failureMatch.created_at,
          };
        }
      }
      // Parsed shape was valid but the Map missed — would mean the
      // BM25 corpus contains an id that no source table has. Fall
      // through with a safe shape; the reason distinguishes this
      // race-condition / corpus-drift case from the malformed-id
      // case above so the trace still tells the operator what
      // happened.
      return {
        nodeId: hit.id,
        view: VIEW,
        bootstrapScore: hit.score,
        reason: `BM25 match in unknown session source (kind=${parsed.kind}, id missing in lookup map)`,
      };
    });
  },
});
