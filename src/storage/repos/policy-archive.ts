// policy_archive repo (PERMISSION_ENGINE.md §17 prerequisite).
//
// `archivePolicy` is the only writer. Bootstrap calls it once per
// engine boot. Read-side: `getPolicyArchive` for the future replay
// modes (`--against-current-policy`, `--without-classifier`,
// `permission diff <id1> <id2>`); `listPolicyArchive` /
// `countPolicyArchive` for tooling that wants to enumerate.
//
// Upsert semantics: identical hashes only update `last_seen_ms`.
// `first_seen_ms` is set on the initial INSERT and never changed
// thereafter — operationally meaningful as "how long has this
// policy been in use".
//
// Hash format mirrors `approvals_log.policy_hash` (`sha256:<hex>`).
// `canonical_json` is the EXACT bytes that produced the hash —
// `canonicalHash(JSON.parse(canonical_json)) === policy_hash` is the
// roundtrip invariant tests pin.

import type { DB } from '../db.ts';

export interface PolicyArchiveRow {
  policy_hash: string;
  canonical_json: string;
  first_seen_ms: number;
  last_seen_ms: number;
}

export interface ArchivePolicyInput {
  policy_hash: string;
  canonical_json: string;
  // Wall-clock timestamp. Caller-supplied so tests can pin for
  // deterministic upsert behavior.
  now: number;
}

const INSERT_OR_UPDATE_SQL = `
  INSERT INTO policy_archive (policy_hash, canonical_json, first_seen_ms, last_seen_ms)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(policy_hash) DO UPDATE SET last_seen_ms = excluded.last_seen_ms
`;

const SELECT_BY_HASH_SQL = `
  SELECT policy_hash, canonical_json, first_seen_ms, last_seen_ms
    FROM policy_archive
   WHERE policy_hash = ?
`;

const LIST_SQL = `
  SELECT policy_hash, canonical_json, first_seen_ms, last_seen_ms
    FROM policy_archive
   ORDER BY first_seen_ms ASC
`;

// Insert if new, update `last_seen_ms` if the hash already exists.
// Returns the resulting row (post-upsert state). The `canonical_json`
// passed in MUST be the bytes that produced `policy_hash` — the
// caller (bootstrap-engine.ts) computes both from the same source
// in lockstep, so a mismatch would be a programmer bug.
export const archivePolicy = (db: DB, input: ArchivePolicyInput): PolicyArchiveRow => {
  db.query(INSERT_OR_UPDATE_SQL).run(input.policy_hash, input.canonical_json, input.now, input.now);
  // Re-read to surface the canonical row state. On a fresh INSERT,
  // first_seen_ms == last_seen_ms == now. On an UPDATE, first_seen_ms
  // stays at the original value and last_seen_ms advances.
  const row = db.query(SELECT_BY_HASH_SQL).get(input.policy_hash) as PolicyArchiveRow | null;
  if (row === null) {
    // Defensive: an INSERT…ON CONFLICT that didn't end with a row is
    // impossible at the SQLite layer, but a corruption / driver bug
    // shouldn't crash silently here. Caller surfaces this as a
    // bootstrap error.
    throw new Error(
      `policy_archive: upsert for ${input.policy_hash} did not produce a row (storage corruption?)`,
    );
  }
  return row;
};

export const getPolicyArchive = (db: DB, policyHash: string): PolicyArchiveRow | null => {
  return db.query(SELECT_BY_HASH_SQL).get(policyHash) as PolicyArchiveRow | null;
};

// Chronological (oldest first). Used by ops tooling that wants to
// walk the install's policy history. Rarely called — archive
// grows only with UNIQUE hashes (one row per distinct policy ever
// booted), so list cost stays bounded in practice.
export const listPolicyArchive = (db: DB): PolicyArchiveRow[] => {
  return db.query(LIST_SQL).all() as PolicyArchiveRow[];
};

export const countPolicyArchive = (db: DB): number => {
  const row = db.query('SELECT COUNT(*) as n FROM policy_archive').get() as { n: number };
  return row.n;
};
