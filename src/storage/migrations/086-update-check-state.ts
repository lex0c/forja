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
//
// Disposable, but STILL a registered migration on purpose. `_migrations` is the
// DB's COMPLETE schema fingerprint and Forja keeps zero out-of-band tables:
// carving this one out to dodge the forward-compat guard (migrate.ts, "Slice 134
// P0-6") would make the fingerprint lie — two binaries both "at 086", different
// real schemas — to buy back a rollback that is ALREADY unsupported by design for
// every one of the 85 tables before it. Rebuilding the cache is one network
// probe; that's the accepted price of uniform schema discipline. A reviewer will
// read "disposable cache" and reach for a lazy CREATE TABLE IF NOT EXISTS — this
// note is why we don't.
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
