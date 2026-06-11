// messages: distinguish who/what produced a message's INPUT.
//
// Why: a user-role message is normally the operator's prompt, but the
// harness can now inject a turn's input itself — a bash_background
// completion notification wakes a turn whose input is the notification
// text (ORCHESTRATION §3B.4). Routed through the same path, it persisted
// as role='user' and was INDISTINGUISHABLE from operator input: the
// audit log read it as something the operator typed, and `--resume`
// replayed it as an operator-submit bar. Both wrong.
//
// `source` closes that gap at the storage layer so it survives resume:
// 'operator' (the human typed it — the default for every existing row
// and the normal case) vs 'system' (the harness/REPL injected it — wake
// notifications today, reminders later). The provider still sees these as
// user-role context (the model must read them); `source` is for audit and
// the resume renderer, which now shows 'system' inputs as system events
// rather than operator bars.
export const migration075MessagesSource = {
  id: 75,
  name: '075-messages-source',
  sql: `
    ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'operator';
  `,
} as const;
