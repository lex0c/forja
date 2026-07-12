// update_check — the local cache backing the passive "update available"
// notice (SECURITY_GUIDELINE §11.4). Single-row (CHECK id = 1): the notice is
// per-install, not per-session. Three fields the boot path reads synchronously
// and the async refresh writes:
//   - last_checked_at  : epoch ms of the last network probe (throttle gate)
//   - latest_seen      : newest version the probe reported (null = never probed)
//   - notified_version : the last version the operator was already shown, so the
//                        banner fires ONCE per new release, not on every boot.
// The singleton row is seeded here so the repo only ever UPDATEs it. Not chained
// — it's a disposable cache, rebuilt from the network, never a decision ledger
// (so no hash/prev columns, unlike approvals/failure_events).
export const migration086UpdateCheckState = {
  id: 86,
  name: '086-update-check-state',
  sql: `
    CREATE TABLE update_check (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      last_checked_at  INTEGER,
      latest_seen      TEXT,
      notified_version TEXT
    );

    INSERT INTO update_check (id) VALUES (1);
  `,
} as const;
