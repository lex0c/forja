// Resume scrollback replay. Reads persisted messages for a session
// and emits the UIEvents that rebuild the visual scrollback the
// operator saw at exit. Slice 3 (this file): user prompts +
// assistant text + tool cards + the per-run `Cogitated for Xs`
// footer.
//
// Why timestamps matter. The reducer's `assistant:end` branch reads
// `event.ts - buf.startedAt` to fill `durationMs` on the assistant
// PermanentItem (UI.md §3.2 turn-end marker). Synthesizing replay
// timestamps from a single now() snapshot collapses the duration to
// 0 and the footer renders `Cogitated for 0s` — accurate for the
// replay itself but a lie about the original turn. So we use the
// persisted `createdAt` of each message: `assistant:start.ts` =
// the immediately preceding message's createdAt (user submit for
// the first assistant of a run, tool_result user message for
// continuations); `assistant:end.ts` = the assistant message's
// createdAt; `session:end.ts` = the run-final assistant's
// createdAt. Tool durationMs proxies via assistant.createdAt →
// tool_result.createdAt — the available signal, not a guess.
//
// Run boundaries vs message boundaries. The harness persists ONE
// assistant message per LLM completion: a run with tool_use can
// produce assistant → user(tool_result) → assistant chains across
// several rows (see src/harness/loop.ts). The live operator saw
// ONE `Cogitated for Xs` footer at the end of the whole run, not
// one per assistant row. We mirror that here: `session:end` fires
// only at the run boundary (= the last assistant message before
// either end-of-session or a user message with STRING content,
// i.e. the next operator prompt). A user message with ARRAY
// content (tool_result) means the run continues — no footer yet.
//
// Two-pass design. The first pass indexes every tool_use ↔
// tool_result pair across the message stream, so the emit pass
// can: (a) skip orphan tool_use blocks (no matching result —
// would leave a "running…" card frozen in the live region), (b)
// resolve a real durationMs per tool from createdAt deltas. The
// emit pass walks blocks individually so text and tool cards
// interleave in the same order the operator saw live (text →
// tool → text → tool → text within a single assistant message).
//
// Resume window — MUST match the model's. The harness does NOT feed
// the whole persisted log to the model on --resume: it fetches a
// bounded tail (listMessageTailBySession with MAX_RESUME_MESSAGES +
// ALIGNMENT_FETCH_MARGIN) and cuts it down to MAX_RESUME_MESSAGES
// via resumeWindowCut (src/harness/resume.ts). Replaying the FULL
// log would (a) make REPL boot time + memory scale with total
// history, and (b) show the operator turns the model can't
// actually reference — a silent mislead about what the next turn
// can build on. So replay drives off the exact same capped window
// and surfaces a truncation indicator when older history was
// dropped.
//
// Content shape. Anthropic content blocks:
//   - {type: 'text', text: string}
//   - {type: 'tool_use', id: string, name: string, input: object}
//   - {type: 'tool_result', tool_use_id: string, content: ..., is_error?: boolean}
// User content is either a plain string (operator prompt) or an
// array of tool_result blocks (continuation of the prior run).

import { ALIGNMENT_FETCH_MARGIN, MAX_RESUME_MESSAGES, resumeWindowCut } from '../harness/resume.ts';
import { type DB, listMessageTailBySession } from '../storage/index.ts';
import type { Bus } from '../tui/bus.ts';
import { lookupToolVocab } from '../tui/tool-vocab.ts';

export interface ReplayResult {
  // Number of user-facing runs that produced at least one assistant
  // turn boundary. Mirrors what the bridge anchor announces; the
  // operator's "I typed 3 prompts" maps to this count.
  turns: number;
  // Number of source messages actually walked (= the size of the
  // capped resume window). Diagnostic.
  messagesWalked: number;
  // Messages that exist in the persisted log but fall OUTSIDE the
  // resume window — older than what the model received as context.
  // Zero when the whole session fit. The caller can use this to
  // decide whether to mention truncation; the replay itself already
  // emits an in-scrollback indicator (see below).
  droppedFromHead: number;
}

// Cap for the tool:end summary line. Anthropic tool_results can run
// kilobytes; the scrollback `└─` connector renders one line, so we
// truncate. 200 mirrors the modal SUBAGENT_DISPLAY_MAX cap — same
// rationale (avoid pushing subsequent content off screen) on a
// surface with similar width.
const TOOL_SUMMARY_MAX = 200;

interface ToolUseRef {
  // Assistant message row that emitted the tool_use. Its createdAt
  // anchors `tool:start.ts` and the lower bound of durationMs.
  startAt: number;
  name: string;
  input: unknown;
}

interface ToolResultRef {
  // User message row that carried the tool_result. Its createdAt
  // anchors `tool:end.ts` and the upper bound of durationMs.
  endAt: number;
  isError: boolean;
  summary: string | null;
}

// Build a one-line summary out of a persisted tool_result.content.
// The provider layer normalizes every tool result to a plain string
// before the harness persists it — `ProviderToolResultBlock.content`
// is typed `string` (src/providers/types.ts). So we only handle the
// string shape here; anything else (a future provider that persists
// a richer shape) returns null and the renderer drops the `└─`
// summary line rather than render `null`. If that future arrives,
// widen the type FIRST, then this function.
const summarizeToolResult = (content: unknown): string | null => {
  if (typeof content !== 'string' || content.length === 0) return null;
  // Collapse internal whitespace so a multi-line result reads as a
  // single tight summary in the `└─` connector. Trim the edges so
  // a result that happens to start/end with whitespace doesn't get
  // a leading/trailing blank visible to the operator.
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length > TOOL_SUMMARY_MAX) {
    // ASCII '...' rather than the '…' glyph: the summary is content
    // text, not a renderer-controlled glyph, so it bypasses the
    // unicode/ASCII fallback in glyphs.ts. '...' renders identically
    // on every terminal.
    return `${collapsed.slice(0, TOOL_SUMMARY_MAX - 3)}...`;
  }
  return collapsed;
};

// Best-effort subject extraction matching the live adapter
// (src/tui/harness-adapter.ts:423-450). vocab.subject can throw on
// unexpected input shapes; defensive try/catch falls back to null
// so the operator gets the chip without a connector line rather
// than a crash.
const subjectFromInput = (
  input: unknown,
  vocab: ReturnType<typeof lookupToolVocab>,
): string | null => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  try {
    return vocab.subject?.(input as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
};

// First pass: index every tool_use ↔ tool_result pair. The emit
// pass uses `results` to decide whether a tool_use needs a synthetic
// closing event: a tool_use WITH a matching result emits a real
// tool:end from the result row; a tool_use WITHOUT one (run
// interrupted before the tool returned) emits a synthetic
// error tool:end so the card doesn't freeze as "running…".
// Tool_results without a matching tool_use are dropped from the
// emit pass (defensive against malformed audit shapes — a tool:end
// for a card the reducer never opened would noop at best).
const indexToolPairs = (
  messages: ReadonlyArray<{ role: string; content: unknown; createdAt: number }>,
): {
  uses: Map<string, ToolUseRef>;
  results: Map<string, ToolResultRef>;
} => {
  const uses = new Map<string, ToolUseRef>();
  const results = new Map<string, ToolResultRef>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (
          b.type === 'tool_use' &&
          typeof b.id === 'string' &&
          typeof b.name === 'string' &&
          b.id.length > 0
        ) {
          uses.set(b.id, { startAt: msg.createdAt, name: b.name, input: b.input });
        }
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as {
          type?: unknown;
          tool_use_id?: unknown;
          content?: unknown;
          is_error?: unknown;
        };
        if (
          b.type === 'tool_result' &&
          typeof b.tool_use_id === 'string' &&
          b.tool_use_id.length > 0
        ) {
          results.set(b.tool_use_id, {
            endAt: msg.createdAt,
            isError: b.is_error === true,
            summary: summarizeToolResult(b.content),
          });
        }
      }
    }
  }
  return { uses, results };
};

// Default tail-fetch size — the same value the harness passes to
// listMessageTailBySession on resume (loop.ts). Exposed as a
// parameter only so tests can exercise the truncation path with a
// small session instead of seeding 600+ rows; production always
// uses this default, keeping replay's window identical to the
// model's.
const DEFAULT_FETCH_LIMIT = MAX_RESUME_MESSAGES + ALIGNMENT_FETCH_MARGIN;

export const replaySessionMessages = (
  db: DB,
  sessionId: string,
  bus: Bus,
  fetchLimit: number = DEFAULT_FETCH_LIMIT,
): ReplayResult => {
  // Fetch the bounded tail, not the whole log — same call shape the
  // harness uses to build the model's resume context. `totalCount`
  // is the full persisted size; `tail.messages` is at most
  // `fetchLimit` of the most-recent rows.
  const tail = listMessageTailBySession(db, sessionId, fetchLimit);
  // Apply the SAME head cut the model's context uses, so visual
  // history and model context are the identical window.
  const cut = resumeWindowCut(tail.messages);
  const messages = cut > 0 ? tail.messages.slice(cut) : tail.messages;
  // Messages outside the window = rows older than the fetched tail
  // (totalCount minus what the tail query returned) PLUS rows the
  // alignment cut dropped from the tail's head.
  const droppedFromHead = tail.totalCount - tail.messages.length + cut;

  // Truncation indicator. When older history was dropped, the
  // operator must know the scrollback above is partial — and, more
  // importantly, that the model's context is equally partial, so
  // the next turn can't reference those dropped turns. Emitted
  // FIRST so it sits at the top of the replayed block. `secondary`
  // tone — scaffolding, not content.
  if (droppedFromHead > 0) {
    bus.emit({
      type: 'info',
      ts: messages[0]?.createdAt ?? 0,
      tone: 'secondary',
      message: `— ${droppedFromHead} earlier ${droppedFromHead === 1 ? 'message' : 'messages'} not shown — outside the resume window, not in model context —`,
    });
  }

  const { uses, results } = indexToolPairs(messages);
  // `runStartTs`: createdAt of the operator-prompt user message
  // that opened the current run. Carried across intermediate
  // assistant + tool_result messages so the run's final footer can
  // span the WHOLE run, not just the last LLM completion. Null
  // outside of an active run.
  let runStartTs: number | null = null;
  // `prevCreatedAt`: createdAt of the immediately preceding message.
  // Used as the `assistant:start.ts` so per-block `durationMs`
  // reflects "this LLM completion's wall clock" — the gap between
  // the previous row and this assistant row.
  let prevCreatedAt: number | null = null;
  let turns = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as (typeof messages)[number];

    if (msg.role === 'user') {
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        // Operator prompt: opens a new run.
        bus.emit({ type: 'user:submit', ts: msg.createdAt, text: msg.content });
        runStartTs = msg.createdAt;
      } else if (Array.isArray(msg.content)) {
        // tool_result continuation. Emit `tool:end` for each block
        // that pairs with a known tool_use. Iteration order matches
        // the persisted block order, which matches the order the
        // operator saw live.
        for (const block of msg.content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as { type?: unknown; tool_use_id?: unknown };
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const useRef = uses.get(b.tool_use_id);
          if (useRef === undefined) continue; // orphan result
          const resultRef = results.get(b.tool_use_id);
          // resultRef must exist — we just walked this block to build
          // the map. Belt-and-suspenders: skip if somehow missing.
          if (resultRef === undefined) continue;
          bus.emit({
            type: 'tool:end',
            ts: resultRef.endAt,
            toolId: b.tool_use_id,
            status: resultRef.isError ? 'error' : 'done',
            durationMs: Math.max(0, resultRef.endAt - useRef.startAt),
            ...(resultRef.summary !== null ? { summary: resultRef.summary } : {}),
          });
        }
      }
      prevCreatedAt = msg.createdAt;
      continue;
    }

    if (msg.role === 'assistant') {
      // Look ahead to detect run boundary. ARRAY user content next
      // = tool_result follow-up = same run still going. Anything
      // else (no next, or string-content user prompt) closes the
      // run after this assistant.
      const next = messages[i + 1];
      const isMidRun = next !== undefined && next.role === 'user' && Array.isArray(next.content);

      // Walk content blocks: emit `assistant:start` lazily on the
      // first text block (skip the bracket entirely for tool-only
      // assistants), then interleave `assistant:delta` and
      // `tool:start` in block order. Live behavior: when an LLM
      // streams text → tool_use → text within one completion, the
      // operator sees the assistant chip + a tool card spawn
      // beneath it, then more text continues. The reducer accepts
      // tool:start while pendingAssistant is open; this preserves
      // the same shape from persisted data.
      let assistantStarted = false;
      const startTs = prevCreatedAt ?? msg.createdAt;
      const ensureAssistantStart = (): void => {
        if (!assistantStarted) {
          bus.emit({ type: 'assistant:start', ts: startTs, messageId: msg.id });
          assistantStarted = true;
        }
      };
      // tool_use ids emitted from THIS message that have no matching
      // tool_result anywhere in the session — the run was interrupted
      // (hard kill, crash) before the tool returned. We still emit
      // tool:start so the operator sees the tool was attempted, then
      // a synthetic tool:end below so the card doesn't freeze as
      // "running…" in the live region forever.
      const orphanToolIds: string[] = [];

      const content = msg.content;
      if (typeof content === 'string') {
        if (content.length > 0) {
          ensureAssistantStart();
          bus.emit({
            type: 'assistant:delta',
            ts: msg.createdAt,
            messageId: msg.id,
            text: content,
          });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as {
            type?: unknown;
            text?: unknown;
            id?: unknown;
            name?: unknown;
            input?: unknown;
          };
          if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
            ensureAssistantStart();
            bus.emit({
              type: 'assistant:delta',
              ts: msg.createdAt,
              messageId: msg.id,
              text: b.text,
            });
          } else if (
            b.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
          ) {
            const vocab = lookupToolVocab(b.name);
            bus.emit({
              type: 'tool:start',
              ts: msg.createdAt,
              toolId: b.id,
              name: b.name,
              activeVerb: vocab.activeVerb,
              finalVerb: vocab.finalVerb,
              subject: subjectFromInput(b.input, vocab),
            });
            // Orphan tool_use: no tool_result anywhere. Defer a
            // synthetic tool:end until after assistant:end below —
            // emitting it inline would close the card before the
            // surrounding text finished rendering.
            if (!results.has(b.id)) orphanToolIds.push(b.id);
          }
          // Other block kinds (thinking, image, etc.) are skipped
          // silently — no scrollback representation in this slice.
        }
      }

      if (assistantStarted) {
        bus.emit({ type: 'assistant:end', ts: msg.createdAt, messageId: msg.id });
      }

      // Close any orphan tool cards with a synthetic error tool:end.
      // The live operator saw the tool spawn and then the run die;
      // replaying a frozen "running…" card against a historical
      // session reads as a bug. status='error' + an explanatory
      // summary tells the truth: the tool was attempted, no result
      // was recorded. durationMs=0 — we have no end timestamp, and
      // a fabricated one would be a worse lie than zero.
      for (const orphanId of orphanToolIds) {
        bus.emit({
          type: 'tool:end',
          ts: msg.createdAt,
          toolId: orphanId,
          status: 'error',
          durationMs: 0,
          summary: '(no result recorded — run interrupted)',
        });
      }

      // session:end fires only at the real run boundary AND only
      // when this run had a user-facing start (runStartTs !==
      // null — operator prompt present). The orphan-assistant
      // edge (no opening user) skips the footer entirely; a
      // floating footer with no opening user row would read as
      // a bug.
      if (!isMidRun && runStartTs !== null) {
        // 'done' vs 'interrupted'. The harness ends a run only
        // when the model produces a tool-FREE response — a
        // run-boundary assistant that still carries unresolved
        // tool_use blocks (orphanToolIds non-empty) never reached
        // that clean stop: the prior run crashed / was killed
        // with a tool outstanding (or before its result was
        // persisted). Emitting reason='done' there would render a
        // successful "Cogitated for Xs" marker over a dead run —
        // misrepresenting it as completed and misleading the
        // operator about what the resumed context holds. Mark it
        // 'interrupted' so the footer reads "Interrupted after Xs"
        // instead. The turn still counts toward the anchor: it
        // IS a turn of history present above the prompt, just an
        // incomplete one.
        const runInterrupted = orphanToolIds.length > 0;
        bus.emit({
          type: 'session:end',
          ts: msg.createdAt,
          sessionId,
          reason: runInterrupted ? 'interrupted' : 'done',
          durationMs: msg.createdAt - runStartTs,
        });
        turns++;
        runStartTs = null;
      }
      prevCreatedAt = msg.createdAt;
      continue;
    }
    // role === 'tool': no current producer writes this role; type
    // kept on MessageRole for forward compat with future provider
    // adapters. Skip silently so a migration that starts using it
    // doesn't crash the replay. prevCreatedAt still advances so
    // the next emission anchors to the latest activity.
    prevCreatedAt = msg.createdAt;
  }
  return { turns, messagesWalked: messages.length, droppedFromHead };
};
