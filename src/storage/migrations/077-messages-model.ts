// messages: record the MODEL that produced each turn (per-turn provenance).
//
// Why: cost surfaces inferred a session's metered-vs-unmetered status from a
// SINGLE model — the live provider (/stats, recap) or the session row's INITIAL
// model (/sessions, --list). But a session spans multiple models: a `/model`
// switch mutates only the live provider, not the session row, so a session that
// started unmetered and switched to a metered one (or vice versa) was mislabeled
// — real recorded spend could read as "unmetered", or untracked usage be missed.
//
// The per-turn model closes that gap at the storage layer: each assistant row
// now carries the model that billed it, so any historical surface resolves a
// session's ACTUAL metering from the models it really used. Nullable — user/tool
// rows carry no model, and rows written before this migration carry NULL (the
// read path falls back to sessions.model for those).
export const migration077MessagesModel = {
  id: 77,
  name: '077-messages-model',
  sql: `
    ALTER TABLE messages ADD COLUMN model TEXT;
  `,
} as const;
