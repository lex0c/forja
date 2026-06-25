// messages: mark a turn as RETRACTED (operator un-sent it after a hard abort).
//
// When the operator hard-cancels right after sending (double-Esc), the message
// is popped from the live context and its text returns to the input — but it was
// already persisted (appendUser writes the row before the request, append-only
// audit). A nullable `retracted_at` records the un-send WITHOUT deleting the row:
// the model-facing conversion (messagesToProviderMessages) skips retracted turns,
// so the un-send is durable across `--resume`, while the transcript / recap keeps
// the row (rendered "cancelled") so the audit and the visual history stay
// faithful. NULL = live; epoch ms = the retraction time. Pre-migration rows are
// NULL (never retracted).
export const migration079MessagesRetracted = {
  id: 79,
  name: '079-messages-retracted',
  sql: `
    ALTER TABLE messages ADD COLUMN retracted_at INTEGER;
  `,
} as const;
