// Slice 131: --undo / --checkpoints restore emits
// checkpoint_reverted outcome_signals for every approval that
// landed after the restored checkpoint's wall-clock.
//
// Uses the runCheckpointsCli entry point directly with a seeded
// DB. Real git restore isn't exercised — we pre-seed the
// checkpoint row + approval rows and assert the signal emit
// based on the restore code path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheckpointsCli } from '../../src/cli/checkpoints.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { appendApprovalsLog } from '../../src/storage/repos/approvals-log.ts';
import { insertCheckpoint } from '../../src/storage/repos/checkpoints.ts';
import { listOutcomeSignalsByApproval } from '../../src/storage/repos/outcome-signals.ts';

const seedApproval = (db: DB, ts: number, hint: number): number => {
  const r = appendApprovalsLog(db, {
    ts,
    install_id: 'i',
    session_id: 'sess-undo',
    parent_approval_id: null,
    tool_name: 'bash',
    tool_version: 'v1',
    resolver_version: 'v1',
    args_hash: 'h',
    capabilities_json: '[]',
    decision: 'allow',
    score: 0,
    score_components_json: '{}',
    confidence: 'high',
    classifier_hash: null,
    classifier_adjust: null,
    policy_hash: 'p',
    sandbox_profile: null,
    ttl_expires_at: null,
    reason_chain_json: '[]',
    prev_hash: `prev-${ts}-${hint}`,
    this_hash: `this-${ts}-${hint}`,
  });
  return r.seq;
};

let cwd: string;
let db: DB;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'forja-undo-test-'));
  // Real git repo so checkpoint manager builds successfully.
  execSync('git init -q', { cwd });
  execSync('git config user.email t@t', { cwd });
  execSync('git config user.name t', { cwd });
  writeFileSync(join(cwd, 'a.txt'), 'initial\n');
  execSync('git add a.txt && git commit -q -m initial', { cwd });
  db = openMemoryDb();
  migrate(db, MIGRATIONS);
  // Insert session row that the checkpoint FK requires.
  db.query(
    `INSERT INTO sessions (id, model, started_at, cwd, status)
     VALUES ('sess-undo', 'm', ?, ?, 'running')`,
  ).run(Date.now() - 100_000, cwd);
});

afterEach(() => {
  db.close();
  rmSync(cwd, { recursive: true, force: true });
});

describe('runCheckpointsCli --undo wire', () => {
  test('emits checkpoint_reverted signals for approvals after the checkpoint ts', async () => {
    // Capture the current commit so we can checkpoint at it.
    const gitRef = execSync('git rev-parse HEAD', { cwd }).toString().trim();
    const ckptCreatedAt = Date.now() - 50_000;
    insertCheckpoint(db, {
      id: 'ckpt-1',
      sessionId: 'sess-undo',
      stepId: 'step-1',
      gitRef,
      createdAt: ckptCreatedAt,
      hadBash: false,
    });
    // Approval BEFORE the checkpoint — should NOT be signaled.
    const seqBefore = seedApproval(db, ckptCreatedAt - 10, 1);
    // Approvals AFTER the checkpoint — should be signaled.
    const seqAfter1 = seedApproval(db, ckptCreatedAt + 10, 2);
    const seqAfter2 = seedApproval(db, ckptCreatedAt + 20, 3);

    const outLines: string[] = [];
    const errLines: string[] = [];
    const exit = await runCheckpointsCli({
      verb: 'undo',
      positionals: ['sess-undo'],
      json: false,
      yes: false,
      cwd,
      dbOverride: db,
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
    });
    expect(exit).toBe(0);

    // Before-checkpoint approval got NO signal.
    expect(listOutcomeSignalsByApproval(db, seqBefore).length).toBe(0);
    // After-checkpoint approvals got one each.
    const after1 = listOutcomeSignalsByApproval(db, seqAfter1);
    const after2 = listOutcomeSignalsByApproval(db, seqAfter2);
    expect(after1.length).toBe(1);
    expect(after2.length).toBe(1);
    expect(after1[0]?.signal_kind).toBe('checkpoint_reverted');
    expect(after1[0]?.signal_weight).toBeCloseTo(0.9);
    const payload = JSON.parse(after1[0]?.payload_json as string);
    expect(payload.checkpoint_id).toBe('ckpt-1');
    expect(payload.restored_to_step).toBe('step-1');
  });
});
