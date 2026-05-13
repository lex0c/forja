// Worker script for the slice 135 P0-10 cross-process audit chain
// test. NOT a test file (no `.test.ts` suffix), so the test runner
// ignores it. The audit.test.ts cross-process suite spawns this
// script via `Bun.spawn` to emit a batch of audit rows from a
// distinct OS process — exercising the bun:sqlite WAL +
// busy_timeout + BEGIN IMMEDIATE chain we set in
// `openDb`/`withImmediateTransaction`.
//
// Argv contract (positional):
//   1. dbPath:    absolute path to the SQLite file
//   2. installId: the install_id UUID to use as identity (the
//                 parent pre-plants the install_id file too, but
//                 we accept it on argv so the worker can build
//                 the identity without depending on path
//                 discovery)
//   3. createdAt: created_at_ms numeric (parses to int)
//   4. sessionPrefix: session_id prefix for the rows this worker
//                     emits — lets the parent attribute rows
//   5. count:     how many rows to emit
//
// Side effect: opens the DB (no migrations — parent does that
// once), constructs a sink, emits `count` rows with seq inferred
// from the chain head. On any throw, exit code 1 + stderr line
// so the test can read the failure.

import { createSqliteSink } from '../../src/permissions/audit.ts';
import type { InstallIdentity } from '../../src/permissions/install_id.ts';
import { openDb } from '../../src/storage/db.ts';

const main = async (): Promise<void> => {
  const [dbPath, installId, createdAtRaw, sessionPrefix, countRaw] = process.argv.slice(2);
  if (
    dbPath === undefined ||
    installId === undefined ||
    createdAtRaw === undefined ||
    sessionPrefix === undefined ||
    countRaw === undefined
  ) {
    process.stderr.write('emitter: missing argv\n');
    process.exit(2);
  }
  const createdAt = Number(createdAtRaw);
  const count = Number(countRaw);
  if (!Number.isFinite(createdAt) || !Number.isFinite(count) || count < 1) {
    process.stderr.write('emitter: bad numeric argv\n');
    process.exit(2);
  }
  const identity: InstallIdentity = {
    install_id: installId,
    created_at_ms: createdAt,
  };
  const db = openDb(dbPath);
  const sink = createSqliteSink({ db, identity });
  const ts = Date.now();
  for (let i = 0; i < count; i++) {
    sink.emit({
      session_id: `${sessionPrefix}-${i}`,
      tool_name: 'bash',
      args: { idx: i, who: sessionPrefix },
      decision: 'allow',
      policy_hash: 'sha256:cross-proc',
      reason_chain: [
        { stage: 'static-rule', layer: 'project', rule: 'cross-proc', section: 'bash' },
      ],
      ts: ts + i,
    });
  }
  db.close();
  process.exit(0);
};

main().catch((e) => {
  process.stderr.write(`emitter: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
