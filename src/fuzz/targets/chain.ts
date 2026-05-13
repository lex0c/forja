// Fuzz target: §15.4 line 1120 "hash chain verify (corrupted
// rows → state=refusing, no panic)". Exercises the audit chain's
// `verifyChain` after applying a random tamper op to a freshly-
// seeded chain (slice 69 — closes the §15.4 four-target roster).
//
// Per iteration:
//   1. Open a fresh in-memory SQLite DB.
//   2. Seed N (1-20) chain rows via `createSqliteSink.emit`.
//   3. Apply one of three corruption ops chosen at random:
//      - `update_field`  flip one column of one row to a random value
//      - `insert_forged` add a row at the end with a hash that won't link
//      - `delete_row`    remove a random row, leaving a seq gap
//   4. Call `sink.verifyChain()` and assert the result conforms
//      to the `VerifyResult` shape.
//
// Invariants enforced:
//   - `verifyChain` MUST NOT throw. Any thrown exception is a
//     fuzz failure regardless of input.
//   - The returned object has `ok: boolean`. When ok=true: `rows`,
//     `current_rotation_id` (numbers), `quarantined` (boolean).
//     When ok=false: `brokenAt`, `current_rotation_id` (numbers),
//     `reason` is one of the two known enum values,
//     `expected`/`actual` are strings.
//
// Note: NOT every corruption breaks the chain. Updating a column
// not in the hash payload, or deleting a row that happens to be
// at the tail, may leave the chain verifiably intact. The
// invariant is structural (no throw + valid shape), not "always
// returns ok:false".

import { createSqliteSink, ensureInstallId } from '../../permissions/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../storage/index.ts';
import type { FuzzTarget } from '../index.ts';
import { randAsciiString, randInt } from '../random.ts';

export type ChainTamperKind = 'update_field' | 'insert_forged' | 'delete_row';

// Columns that affect the hash payload (any mutation breaks the
// chain). Limited to fields WITHOUT CHECK constraints so the
// SQL update succeeds with arbitrary random payloads:
//   - decision / confidence have enum CHECKs (would reject on
//     non-enum values); excluded.
//   - tool_name / session_id / ts have no constraints and are
//     all in the hash payload, so any mutation breaks the chain
//     and exercises verifyChain's mismatch detection.
// This trades off "fuzz the decision flip case" against
// "always-succeeds SQL update"; the decision flip is well-
// covered by hand-crafted hash_chain conformance cases (slice
// 33).
const TAMPER_FIELDS = ['tool_name', 'session_id', 'ts'] as const;

export interface ChainFuzzInput {
  rowCount: number;
  tamperKind: ChainTamperKind;
  // Index of the row to tamper, 0-based. `update_field` /
  // `delete_row` use it directly; `insert_forged` ignores it
  // (always appends).
  rowIndex: number;
  // Used by `update_field` to pick which column to mutate.
  fieldIndex: number;
  // Random payload for forged rows / field values. Kept short
  // to keep error messages readable in CI logs.
  payload: string;
}

const seedChain = (
  db: DB,
  rowCount: number,
): { installId: string; sink: ReturnType<typeof createSqliteSink> } => {
  const identity = ensureInstallId({
    env: { HOME: '/tmp/forja-fuzz-chain' },
    now: () => 1,
    uuid: () => 'chain-fuzz-uuid-aaaa-bbbb',
  });
  const sink = createSqliteSink({ db, identity });
  for (let i = 0; i < rowCount; i++) {
    sink.emit({
      session_id: `s${i}`,
      tool_name: 'bash',
      args: { i },
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 100 + i,
    });
  }
  return { installId: identity.install_id, sink };
};

const applyTamper = (db: DB, input: ChainFuzzInput): void => {
  const allRows = db.query('SELECT seq FROM approvals_log ORDER BY seq ASC').all() as Array<{
    seq: number;
  }>;
  if (allRows.length === 0) return; // No rows to tamper with.

  if (input.tamperKind === 'update_field') {
    const target = allRows[input.rowIndex % allRows.length];
    if (target === undefined) return;
    const field = TAMPER_FIELDS[input.fieldIndex % TAMPER_FIELDS.length];
    // Use a random string for textual fields; for ts (numeric),
    // SQLite will coerce — that's fine, the chain breaks
    // regardless.
    db.run(`UPDATE approvals_log SET ${field} = ? WHERE seq = ?`, [input.payload, target.seq]);
    return;
  }

  if (input.tamperKind === 'insert_forged') {
    // Insert at seq = max+1 with random hashes. The chain will
    // detect the prev_hash mismatch against the genuine last
    // row's this_hash.
    const lastSeq = allRows[allRows.length - 1]?.seq ?? 0;
    db.run(
      `INSERT INTO approvals_log (ts, install_id, session_id, parent_approval_id, tool_name,
        tool_version, resolver_version, args_hash, capabilities_json, decision,
        score, score_components_json, confidence, classifier_hash, classifier_adjust,
        policy_hash, sandbox_profile, ttl_expires_at, reason_chain_json, prev_hash, this_hash)
       VALUES (?, ?, ?, NULL, ?, 'v1', 'v1', ?, '[]', 'allow', 0, '{}', 'high', NULL, NULL,
        'sha256:forged', NULL, NULL, '[]', ?, ?)`,
      [
        9999,
        'fuzz-install',
        `forged-${input.payload}`,
        'forged_tool',
        `forged-hash-${input.payload}`,
        `forged-prev-${input.payload}`,
        `forged-this-${input.payload}-${lastSeq + 1}`,
      ],
    );
    return;
  }

  // delete_row
  const target = allRows[input.rowIndex % allRows.length];
  if (target === undefined) return;
  db.run('DELETE FROM approvals_log WHERE seq = ?', [target.seq]);
};

const isValidVerifyResult = (r: unknown): boolean => {
  if (r === null || typeof r !== 'object') return false;
  const obj = r as Record<string, unknown>;
  if (typeof obj.ok !== 'boolean') return false;
  if (obj.ok === true) {
    return (
      typeof obj.rows === 'number' &&
      typeof obj.current_rotation_id === 'number' &&
      typeof obj.quarantined === 'boolean'
    );
  }
  // ok === false: broken shape
  return (
    typeof obj.brokenAt === 'number' &&
    typeof obj.current_rotation_id === 'number' &&
    typeof obj.quarantined === 'boolean' &&
    (obj.reason === 'prev_hash_mismatch' || obj.reason === 'this_hash_mismatch') &&
    typeof obj.expected === 'string' &&
    typeof obj.actual === 'string'
  );
};

export const chainFuzzTarget: FuzzTarget<ChainFuzzInput> = {
  name: 'chain',
  generate: (rng) => {
    const tamperRoll = rng();
    const tamperKind: ChainTamperKind =
      tamperRoll < 0.5 ? 'update_field' : tamperRoll < 0.8 ? 'insert_forged' : 'delete_row';
    return {
      rowCount: randInt(rng, 1, 20),
      tamperKind,
      rowIndex: randInt(rng, 0, 100),
      fieldIndex: randInt(rng, 0, TAMPER_FIELDS.length - 1),
      payload: randAsciiString(rng, randInt(rng, 1, 16)),
    };
  },
  format: (input) =>
    `rowCount=${input.rowCount} tamperKind=${input.tamperKind} rowIndex=${input.rowIndex} fieldIndex=${input.fieldIndex} payload=${JSON.stringify(input.payload)}`,
  run: (input) => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const { sink } = seedChain(db, input.rowCount);
    applyTamper(db, input);
    // verifyChain MUST NOT throw — wrap in try/catch so the
    // harness surfaces unhandled exceptions as crash reports.
    let result: unknown;
    try {
      result = sink.verifyChain();
    } catch (e) {
      throw new Error(`verifyChain threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isValidVerifyResult(result)) {
      throw new Error(`verifyChain returned malformed result: ${JSON.stringify(result)}`);
    }
  },
};
