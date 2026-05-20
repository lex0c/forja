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
// the prior user message's createdAt; `assistant:end.ts` and
// `session:end.ts` = the assistant message's createdAt. Reducer
// math then yields the real wall-clock duration of the historical
// turn.
//
// Content shape. The provider (Anthropic) writes assistant content
// as an array of blocks: `{type: 'text', text}`, `{type: 'tool_use',
// id, name, input}`, etc. User content is either a plain string
// (the initial prompt) or an array of `tool_result` blocks (the
// turn that follows a tool_use). We only need the `text` blocks
// here; everything else is skipped silently. Future tool-replay
// slice walks the same content but maps tool_use/tool_result to
// `tool:start` / `tool:end` events.

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
  // Track the most recent user message's createdAt so the next
  // assistant emission can compute a real `durationMs`. Cleared
  // after each assistant turn lands, so a subsequent tool-only
  // turn doesn't borrow the prior user message's anchor.
  let lastUserAt: number | null = null;
  let turns = 0;
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractUserText(msg.content);
      if (text !== null) {
        bus.emit({ type: 'user:submit', ts: msg.createdAt, text });
        lastUserAt = msg.createdAt;
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const text = extractAssistantText(msg.content);
      if (text === null) {
        // Tool-only turn (no text). The tool-replay slice will
        // emit tool:start/tool:end here; for now, leave the slot
        // empty and don't fabricate a session:end footer (a
        // footer with no preceding assistant block visually
        // floats and reads as a bug).
        continue;
      }
      // Synthesize start → delta → end → session:end. The reducer
      // collapses delta-driven text into the assistant
      // PermanentItem; a single delta carrying the whole message
      // is functionally identical to N small ones from the live
      // stream (the renderer's frame coalescer batches the live
      // path anyway).
      //
      // start.ts uses the user message's createdAt when we have
      // one; otherwise the assistant's own createdAt (turn with no
      // matching prior user). Reducer's durationMs computation
      // (event.ts - buf.startedAt) yields the wall-clock gap
      // between user submit and assistant completion in the
      // first case, and 0 in the orphan case (safe fallback —
      // reduces to text-only chip).
      const startTs = lastUserAt ?? msg.createdAt;
      bus.emit({ type: 'assistant:start', ts: startTs, messageId: msg.id });
      bus.emit({
        type: 'assistant:delta',
        ts: msg.createdAt,
        messageId: msg.id,
        text,
      });
      bus.emit({ type: 'assistant:end', ts: msg.createdAt, messageId: msg.id });
      // session:end produces the `Cogitated for Xs` footer
      // (UI.md §3.2). durationMs comes from the createdAt gap so
      // the operator sees the historical turn's real timing, not
      // a 0s placeholder. Reason is fixed as 'done' — the
      // persisted messages don't record turn-end cause; subsequent
      // turns existing implies the prior one completed cleanly
      // enough to take another input.
      const durationMs = lastUserAt !== null ? msg.createdAt - lastUserAt : 0;
      bus.emit({
        type: 'session:end',
        ts: msg.createdAt,
        sessionId,
        reason: 'done',
        durationMs,
      });
      lastUserAt = null;
      turns++;
    }
    // role === 'tool': no current producer writes this role; the
    // type is kept on `MessageRole` for forward compat with
    // providers that need a dedicated tool channel. Skip silently
    // so a future migration that starts using it doesn't crash
    // the replay.
  }
  return { turns, messagesWalked: messages.length };
};
