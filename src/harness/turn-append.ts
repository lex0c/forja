import type { ProviderMessage } from '../providers/types.ts';

// Append a text block to the bottom of [current_turn] — i.e. the last user
// message of the request — so the model sees it at the max-attention position
// WITHOUT:
//   - breaking user/assistant alternation (we mutate the last user message in
//     place rather than appending a fresh message that would pair two user
//     turns and 400 on strict providers). The guarantee is "bottom of
//     [current_turn]": Anthropic/Google keep the block in the same user
//     content; the OpenAI adapter (tool_results become role:'tool' messages)
//     materializes it as a separate trailing user turn — still legal, still
//     bottom-of-turn, just not literally inside the last message. And
//   - re-caching the stable prefix (the current turn is rebuilt every step, so
//     a block that changes every step costs no extra cache here).
//
// Mutates the passed array in place — the caller hands in a fresh snapshot
// (`[...ctx.getMessages()]`), and we only REPLACE the last element with a new
// object (never mutate the shared message instances), so the canonical
// in-memory history is untouched. No-op when the array is empty or the last
// message isn't a user turn (defensive — at the send point the tail is always a
// user input or a tool_result, both role 'user').
//
// Shared by every "bottom-of-turn" injector (working-state panel, static
// guidance) so the alternation/replace-not-mutate contract lives in one place.
// Returns true when the text was appended, false on the no-op paths (empty array / tail
// not a user turn) so callers that must know whether the block actually reached the
// request (e.g. proactive provenance) can branch on it.
export const appendTextToLastUserMessage = (messages: ProviderMessage[], text: string): boolean => {
  if (messages.length === 0) return false;

  const i = messages.length - 1;
  const last = messages[i];
  if (last === undefined || last.role !== 'user') return false;

  if (typeof last.content === 'string') {
    // Plain text input → concatenate at the bottom (a blank input still gets
    // the text as its whole content).
    messages[i] = {
      role: 'user',
      content: last.content.length > 0 ? `${last.content}\n\n${text}` : text,
    };
    return true;
  }

  // tool_result blocks → append a trailing text block. A user message may carry
  // tool_result blocks plus a text block (Anthropic/OpenAI accept it). When the
  // tail is ALREADY a text block (a prior injector ran on this same message),
  // merge into it with a blank line instead of pushing a second block: the
  // OpenAI/Responses adapter flattens multiple text blocks with `join('')`, so
  // two separate blocks would glue end-to-start with no separator. One block
  // mirrors the string path and is separator-safe across every adapter.
  const content = last.content;
  const tail = content[content.length - 1];
  if (tail !== undefined && tail.type === 'text') {
    const merged = tail.text.length > 0 ? `${tail.text}\n\n${text}` : text;
    messages[i] = {
      role: 'user',
      content: [...content.slice(0, -1), { type: 'text', text: merged }],
    };
    return true;
  }
  messages[i] = { role: 'user', content: [...content, { type: 'text', text }] };
  return true;
};
