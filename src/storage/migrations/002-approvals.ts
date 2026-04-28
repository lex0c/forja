export const migration002Approvals = {
  id: 2,
  name: '002-approvals',
  sql: `
    CREATE TABLE approvals (
      id              TEXT PRIMARY KEY,
      tool_call_id    TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      decision        TEXT NOT NULL
                        CHECK (decision IN ('allow','deny','confirm_yes','confirm_no')),
      decided_by      TEXT NOT NULL
                        CHECK (decided_by IN ('policy','user','hook')),
      decided_at      INTEGER NOT NULL,
      reason          TEXT
    );

    CREATE INDEX idx_approvals_tool_call ON approvals(tool_call_id);
  `,
} as const;
