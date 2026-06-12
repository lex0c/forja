import type { ProviderMessage } from '../providers/types.ts';
import { type WorkingState, formatWorkingState } from '../working-state/index.ts';

// Append the [working_state] panel to the bottom of [current_turn] — i.e. the
// last user message of the request — so the model sees it at the max-attention
// position (WORKING_STATE.md §5.1) WITHOUT:
//   - breaking user/assistant alternation (we mutate the last user message in
//     place rather than appending a fresh message that would pair two user
//     turns and 400 on strict providers). The guarantee is "bottom of
//     [current_turn]": Anthropic/Google keep the block in the same user
//     content; the OpenAI adapter (tool_results become role:'tool' messages)
//     materializes it as a separate trailing user turn — still legal, still
//     bottom-of-turn, just not literally inside the last message. And
//   - re-caching the stable prefix (the current turn is rebuilt every step, so
//     a block that changes every step costs no extra cache here; §5.2).
//
// Mutates the passed array in place — the caller hands in a fresh snapshot
// (`[...ctx.getMessages()]`), and we only REPLACE the last element with a new
// object (never mutate the shared message instances), so the canonical
// in-memory history is untouched. No-op when the panel is empty (a session that
// never used the tool leaves no trace; §7.1) or the last message isn't a user
// turn (defensive — at the send point the tail is always a user input or a
// tool_result, both role 'user').
export const injectWorkingStateBlock = (
  messages: ProviderMessage[],
  state: WorkingState,
  currentStep: number,
): void => {
  const block = formatWorkingState(state, currentStep);
  if (block === undefined) return;
  if (messages.length === 0) return;

  const i = messages.length - 1;
  const last = messages[i];
  if (last === undefined || last.role !== 'user') return;

  if (typeof last.content === 'string') {
    // Plain text input → concatenate at the bottom (a blank input still gets
    // the panel as its whole content).
    messages[i] = {
      role: 'user',
      content: last.content.length > 0 ? `${last.content}\n\n${block}` : block,
    };
  } else {
    // tool_result blocks → append a trailing text block. A user message may
    // carry tool_result blocks plus a text block (Anthropic/OpenAI accept it).
    messages[i] = { role: 'user', content: [...last.content, { type: 'text', text: block }] };
  }
};
