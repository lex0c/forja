// messages: record the resolved provider reasoning-effort that produced
// each assistant message.
//
// Why: a quality regression has two prime suspects — the prompt/context
// changed, or the effort changed. `prompt_hash` (migration 068) already
// pins the prompt dimension; effort had no home. It is the ONE dimension
// that is both mutable mid-session (the operator runs `/effort` between
// turns) and not recoverable from any other row — model lives on the
// session, sampling-stripped derives from capabilities, thinking_budget
// derives from effort+model. So persisting effort closes the attribution
// gap: "worse because effort dropped, or because the context did?"
//
// Stored as the effort string ('low' | 'medium' | 'high' | 'max'). NULL on
// rows written before this migration, and on non-assistant rows (user /
// tool_result are not model outputs) and turns where no effort was resolved.
export const migration074MessagesEffort = {
  id: 74,
  name: '074-messages-effort',
  sql: `
    ALTER TABLE messages ADD COLUMN effort TEXT;
  `,
} as const;
