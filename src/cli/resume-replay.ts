// Resume scrollback replay. Reads persisted messages for a session
// and emits the UIEvents that rebuild the visual scrollback the
// operator saw at exit. Text-only in this slice: user prompts +
// assistant text + the per-turn `Cogitated for Xs` footer. Tool
// cards (tool_use / tool_result blocks) are skipped here and pick
// up in a follow-up slice — they need pairing across messages and
// a `tool-vocab` lookup that the audit log doesn't carry.
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
// createdAt. Reducer math then yields the real wall-clock duration
// of the historical turn at each level (per-block + per-run).
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
// Content shape. The provider (Anthropic) writes assistant content
// as an array of blocks: `{type: 'text', text}`, `{type: 'tool_use',
// id, name, input}`, etc. User content is either a plain string
// (the initial prompt or a follow-up operator turn) or an array of
// `tool_result` blocks (continuation of the prior run). We only
// need the `text` blocks here; everything else is skipped silently.
// Future tool-replay slice walks the same content but maps
// tool_use/tool_result to `tool:start` / `tool:end` events.

import { type DB, listMessagesBySession } from '../storage/index.ts';
import type { Bus } from '../tui/bus.ts';

export interface ReplayResult {
  // Number of past turns that produced an assistant text emission.
  // Tool-only turns (no assistant text) count as 0. Lets the caller
  // surface "<N> prior turns" in a boot diagnostic without
  // recomputing.
  turns: number;
  // Number of source messages actually walked. Diagnostic — helps a
  // future test or operator confirm the replay touched every row.
  messagesWalked: number;
}

// Extract a single string from a user message's content. The
// initial prompt path stores a plain string; the tool-result path
// stores an array of tool_result blocks (no operator-facing text).
// Returns null when nothing user-facing can be rendered.
const extractUserText = (content: unknown): string | null => {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  // Arrays = tool_result blocks (Anthropic). Skipped in this slice;
  // a future tool-replay slice handles them as `tool:end` events.
  return null;
};

// Concatenate every text block in an assistant message's content
// array. Tool_use / thinking blocks are silently skipped. Returns
// null when no text block contributed (tool-only turns).
const extractAssistantText = (content: unknown): string | null => {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  // Anthropic emits multiple text blocks when the response is
  // interleaved with tool_uses ("Looking...\n[tool_use]\nFound it,
  // here's why..."). Joining with `\n` keeps the prose continuous in
  // scrollback; the tool chip that lived between the blocks lands
  // in the right place when the tool-replay slice ships.
  return parts.length > 0 ? parts.join('\n') : null;
};

export const replaySessionMessages = (db: DB, sessionId: string, bus: Bus): ReplayResult => {
  const messages = listMessagesBySession(db, sessionId);
  // `runStartTs`: createdAt of the operator-prompt user message
  // that opened the current run. Carried across intermediate
  // assistant + tool_result messages so the run's final footer can
  // span the WHOLE run, not just the last LLM completion. Null
  // outside of an active run.
  let runStartTs: number | null = null;
  // `prevCreatedAt`: createdAt of the immediately preceding message.
  // Used as the `assistant:start.ts` so per-block `durationMs`
  // reflects "this LLM completion's wall clock" — which is the
  // gap between the previous row and this assistant row (the user
  // prompt for the first assistant; the tool_result user message
  // for continuations). Mirrors what the renderer showed live, per
  // assistant block.
  let prevCreatedAt: number | null = null;
  let turns = 0;
  for (let i = 0; i < messages.length; i++) {
    // SAFETY: i is bounded by messages.length above; the entry
    // exists. The non-null assertion is the same shape the rest of
    // the codebase uses for guarded array access.
    const msg = messages[i] as (typeof messages)[number];
    if (msg.role === 'user') {
      const text = extractUserText(msg.content);
      if (text !== null) {
        // Operator prompt opens a new run. Anchor the run start
        // here so the run-end footer can measure the full wall
        // clock from prompt to final assistant.
        bus.emit({ type: 'user:submit', ts: msg.createdAt, text });
        runStartTs = msg.createdAt;
      }
      // Array content (tool_result continuation) doesn't reset
      // runStartTs — it's the same run still going. prevCreatedAt
      // still advances either way so the next assistant's start
      // timestamp lines up with the most recent activity.
      prevCreatedAt = msg.createdAt;
      continue;
    }
    if (msg.role === 'assistant') {
      const text = extractAssistantText(msg.content);
      // Look ahead to decide whether THIS assistant is the run's
      // last LLM completion or a mid-run continuation. A user
      // message with ARRAY content means tool_result follow-up —
      // run continues. Anything else (no next message, or a
      // user-string operator prompt, or another assistant — which
      // shouldn't happen but we treat conservatively) closes the
      // run.
      const next = messages[i + 1];
      const isMidRun = next !== undefined && next.role === 'user' && Array.isArray(next.content);
      // Emit the assistant block when there's text. Tool-only
      // assistants produce no row in this slice — but they still
      // count toward the run boundary check above. A future tool-
      // replay slice will fill in the missing card.
      if (text !== null) {
        // start.ts = previous message's createdAt when available.
        // First assistant in a run: user prompt's createdAt;
        // continuation: tool_result user message's createdAt;
        // orphan (no prior): assistant's own createdAt → reducer
        // yields durationMs=0 per block, safe.
        const startTs = prevCreatedAt ?? msg.createdAt;
        bus.emit({ type: 'assistant:start', ts: startTs, messageId: msg.id });
        bus.emit({
          type: 'assistant:delta',
          ts: msg.createdAt,
          messageId: msg.id,
          text,
        });
        bus.emit({ type: 'assistant:end', ts: msg.createdAt, messageId: msg.id });
      }
      // session:end fires only at the real run boundary AND only
      // when this run had a user-facing start (runStartTs !==
      // null — operator prompt present). The orphan-assistant
      // edge skips the footer entirely: with no opening user row
      // in scrollback, a "Cogitated for 0s" footer would float
      // alone and read as a bug. Reason is 'done' — persisted
      // messages don't record turn-end cause; the run produced
      // followups (or ended), so 'done' is the safe default.
      if (!isMidRun && runStartTs !== null) {
        bus.emit({
          type: 'session:end',
          ts: msg.createdAt,
          sessionId,
          reason: 'done',
          durationMs: msg.createdAt - runStartTs,
        });
        turns++;
        runStartTs = null;
      }
      prevCreatedAt = msg.createdAt;
      continue;
    }
    // role === 'tool': no current producer writes this role; the
    // type is kept on `MessageRole` for forward compat with
    // providers that need a dedicated tool channel. Skip silently
    // so a future migration that starts using it doesn't crash
    // the replay. prevCreatedAt still tracks so the next emission
    // anchors to the latest activity.
    prevCreatedAt = msg.createdAt;
  }
  return { turns, messagesWalked: messages.length };
};
