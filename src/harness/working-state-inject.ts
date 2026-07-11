import type { ProviderMessage } from '../providers/types.ts';
import { formatWorkingState, type WorkingState } from '../working-state/index.ts';
import { appendTextToLastUserMessage } from './turn-append.ts';

// Append the [working_state] panel to the bottom of [current_turn] — i.e. the
// last user message of the request — so the model sees it at the max-attention
// position (WORKING_STATE.md §5.1). The alternation-safe, replace-not-mutate
// append lives in `appendTextToLastUserMessage` (turn-append.ts). No-op when the
// panel is empty (a session that never used the tool leaves no trace; §7.1).
export const injectWorkingStateBlock = (
  messages: ProviderMessage[],
  state: WorkingState,
  currentStep: number,
): void => {
  const block = formatWorkingState(state, currentStep);
  if (block === undefined) return;
  appendTextToLastUserMessage(messages, block);
};
