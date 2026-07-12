import type { DB } from '../db.ts';

// Local cache backing the passive "update available" notice
// (SECURITY_GUIDELINE §11.4). Single-row table (id = 1, seeded by migration
// 086): the repo only ever reads the row or UPDATEs it in place — it never
// inserts. The boot path reads it synchronously; the async refresh writes it.

export interface UpdateCheckState {
  // Epoch ms of the last SUCCESSFUL network probe. The throttle gate compares
  // against this; a failed probe leaves it untouched so the next boot retries.
  lastCheckedAt: number | null;
  // Newest version the probe last resolved (semver string, no leading `v`).
  latestSeen: string | null;
  // Last version already surfaced to the operator, so the banner fires once
  // per release instead of on every boot.
  notifiedVersion: string | null;
}

interface UpdateCheckRow {
  id: number;
  last_checked_at: number | null;
  latest_seen: string | null;
  notified_version: string | null;
}

const fromRow = (row: UpdateCheckRow): UpdateCheckState => ({
  lastCheckedAt: row.last_checked_at,
  latestSeen: row.latest_seen,
  notifiedVersion: row.notified_version,
});

const EMPTY: UpdateCheckState = {
  lastCheckedAt: null,
  latestSeen: null,
  notifiedVersion: null,
};

// Reads the singleton cache row. Migration 086 always seeds it, so this
// normally hits the row; the row?/EMPTY guard only covers a row that was
// manually deleted (the write helpers re-seed via INSERT OR IGNORE). A missing
// TABLE is not defended here — that would mean the DB never migrated, and boot
// fails earlier.
export const getUpdateCheck = (db: DB): UpdateCheckState => {
  const row = db.query('SELECT * FROM update_check WHERE id = 1').get() as UpdateCheckRow | null;
  return row ? fromRow(row) : { ...EMPTY };
};

// Records a SUCCESSFUL network refresh: the probe time (throttle gate) and the
// version it resolved. Called only from the async refresh, never on the render
// path. A failed probe records nothing (so the next boot retries), which is why
// `latestSeen` is a required string here, not nullable.
export const recordUpdateProbe = (db: DB, lastCheckedAt: number, latestSeen: string): void => {
  db.query('INSERT OR IGNORE INTO update_check (id) VALUES (1)').run();
  db.query('UPDATE update_check SET last_checked_at = ?, latest_seen = ? WHERE id = 1').run(
    lastCheckedAt,
    latestSeen,
  );
};

// Marks a version as already surfaced, so the notice does not repeat every
// boot. Called right after the banner line is emitted.
export const markNotified = (db: DB, version: string): void => {
  db.query('INSERT OR IGNORE INTO update_check (id) VALUES (1)').run();
  db.query('UPDATE update_check SET notified_version = ? WHERE id = 1').run(version);
};
