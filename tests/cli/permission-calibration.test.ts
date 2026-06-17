// Slice 138 — `forja permission calibration-export` CLI verb.
// Tests cover:
//   - parseArgs: --since-days / --all-decisions parsing + scope
//     guard against other verbs;
//   - runPermissionCalibrationExport: text vs --json output,
//     install_id resolution, window filter via `now` seam,
//     install isolation, error paths (install_id failure,
//     malformed --since-days).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionCalibrationExport } from '../../src/cli/permission-calibration.ts';
import { createSqliteOutcomeSink } from '../../src/outcomes/index.ts';
import { ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import {
  type ApprovalLogDecision,
  appendApprovalsLog,
} from '../../src/storage/repos/approvals-log.ts';

let tmpRoot: string;
let dbPath: string;
let homeDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-calibration-cli-'));
  homeDir = join(tmpRoot, 'home');
  dbPath = join(tmpRoot, 'agent.db');
  env = { HOME: homeDir };
  // Pre-create the install_id so the runner doesn't have to.
  ensureInstallId({ env });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let serialCounter = 0;
const seedApproval = (params: {
  ts: number;
  decision?: string;
  installId?: string;
  score?: number;
}): number => {
  serialCounter++;
  const identity = ensureInstallId({ env });
  const db = openDb(dbPath);
  try {
    migrate(db, MIGRATIONS);
    const r = appendApprovalsLog(db, {
      ts: params.ts,
      install_id: params.installId ?? identity.install_id,
      session_id: 's',
      parent_approval_id: null,
      tool_name: 'bash',
      tool_version: 'v1',
      resolver_version: 'v1',
      args_hash: `h-${serialCounter}`,
      capabilities_json: '[]',
      decision: (params.decision ?? 'confirm-allowed') as ApprovalLogDecision,
      score: params.score ?? 0.5,
      score_components_json: '{}',
      confidence: 'high',
      classifier_hash: null,
      classifier_adjust: null,
      policy_hash: 'p',
      sandbox_profile: null,
      ttl_expires_at: null,
      reason_chain_json: '[]',
      prev_hash: `prev-${serialCounter}`,
      this_hash: `this-${serialCounter}`,
    });
    return r.seq;
  } finally {
    db.close();
  }
};

interface CapturedOutput {
  out: string[];
  err: string[];
  write: { out: (s: string) => void; err: (s: string) => void };
}

const capture = (): CapturedOutput => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
};

describe('parseArgs — permission calibration-export', () => {
  test('verb parses + accepts --json + --since-days + --all-decisions', () => {
    const r = parseArgs([
      'permission',
      'calibration-export',
      '--json',
      '--since-days',
      '7',
      '--all-decisions',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.verb).toBe('calibration-export');
      expect(r.args.permission?.sinceDays).toBe(7);
      expect(r.args.permission?.allDecisions).toBe(true);
    }
  });

  test('--since-days defaults are absent when flag omitted', () => {
    const r = parseArgs(['permission', 'calibration-export']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.sinceDays).toBeUndefined();
      expect(r.args.permission?.allDecisions).toBeUndefined();
    }
  });

  test('--since-days requires a positive integer', () => {
    const r = parseArgs(['permission', 'calibration-export', '--since-days', '0']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--since-days');
    }
  });

  test('--since-days requires a value', () => {
    const r = parseArgs(['permission', 'calibration-export', '--since-days']);
    expect(r.ok).toBe(false);
  });

  test('--since-days on a non-calibration verb fails', () => {
    const r = parseArgs(['permission', 'verify', '--since-days', '7']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("only apply to 'calibration-export'");
    }
  });

  test('--all-decisions on a non-calibration verb fails', () => {
    const r = parseArgs(['permission', 'verify', '--all-decisions']);
    expect(r.ok).toBe(false);
  });

  test('calibration-export rejects positionals', () => {
    const r = parseArgs(['permission', 'calibration-export', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('no positionals expected');
    }
  });
});

describe('runPermissionCalibrationExport — text output', () => {
  test('empty DB → coverage summary with zero counts', async () => {
    const c = capture();
    const code = await runPermissionCalibrationExport({
      dbPath,
      env,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(0);
    const text = c.out.join('');
    expect(text).toContain('triples: 0');
    expect(text).toContain('harmful : 0');
    expect(text).toContain('harmless: 0');
  });

  test('seeded approvals + signals appear in coverage', async () => {
    const now = Date.now();
    const seq1 = seedApproval({ ts: now - 1_000_000, decision: 'confirm-allowed' });
    const seq2 = seedApproval({ ts: now - 1_000_000, decision: 'confirm-denied' });
    const db = openDb(dbPath);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq1, signal_kind: 'checkpoint_reverted' });
    sink.emit({ approval_seq: seq2, signal_kind: 'tool_error' });
    db.close();

    const c = capture();
    const code = await runPermissionCalibrationExport({
      dbPath,
      env,
      now: () => now,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(0);
    const text = c.out.join('');
    expect(text).toContain('triples: 2');
    expect(text).toContain('harmful : 1');
    expect(text).toContain('harmless: 1');
    expect(text).toContain('confirm-allowed: 1');
    expect(text).toContain('confirm-denied: 1');
    expect(text).toContain('with at least one outcome_signal: 2');
  });

  test('sparse-window note fires for <100 triples', async () => {
    seedApproval({ ts: Date.now() - 1000, decision: 'confirm-allowed' });
    const c = capture();
    await runPermissionCalibrationExport({
      dbPath,
      env,
      out: c.write.out,
      err: c.write.err,
    });
    expect(c.out.join('')).toContain('<100 triples');
  });
});

describe('runPermissionCalibrationExport — --json NDJSON output', () => {
  test('emits one JSON line per triple on stdout; summary on stderr', async () => {
    const now = Date.now();
    const seq = seedApproval({ ts: now - 1000, decision: 'confirm-allowed' });
    const db = openDb(dbPath);
    const sink = createSqliteOutcomeSink({ db });
    sink.emit({ approval_seq: seq, signal_kind: 'checkpoint_reverted' });
    db.close();

    const c = capture();
    const code = await runPermissionCalibrationExport({
      json: true,
      dbPath,
      env,
      now: () => now,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(0);
    const stdout = c.out.join('');
    // NDJSON: one line, parses cleanly.
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed.approval_seq).toBe(seq);
    expect(parsed.outcome).toBe('harmful');
    expect(parsed.composite).toBeCloseTo(0.9);
    expect(parsed.signal_kinds).toEqual(['checkpoint_reverted']);
    // Coverage summary goes to stderr.
    expect(c.err.join('')).toContain('triples: 1');
  });

  test('empty result → empty stdout but summary still on stderr', async () => {
    const c = capture();
    const code = await runPermissionCalibrationExport({
      json: true,
      dbPath,
      env,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(0);
    expect(c.out.join('')).toBe('');
    expect(c.err.join('')).toContain('triples: 0');
  });
});

describe('runPermissionCalibrationExport — window + filter behavior', () => {
  test('--since-days bounds the window correctly', async () => {
    const now = Date.now();
    // Inside the 30d window:
    seedApproval({ ts: now - 1_000_000, decision: 'confirm-allowed' });
    // Outside (60d ago):
    seedApproval({ ts: now - 60 * 86_400_000, decision: 'confirm-allowed' });
    const c = capture();
    await runPermissionCalibrationExport({
      sinceDays: 30,
      dbPath,
      env,
      now: () => now,
      out: c.write.out,
      err: c.write.err,
    });
    expect(c.out.join('')).toContain('triples: 1');
  });

  test('default --since-days=30 narrows window vs --since-days=365', async () => {
    const now = Date.now();
    seedApproval({ ts: now - 60 * 86_400_000, decision: 'confirm-allowed' });
    // Default 30d misses the 60d-old row.
    const c30 = capture();
    await runPermissionCalibrationExport({
      dbPath,
      env,
      now: () => now,
      out: c30.write.out,
      err: c30.write.err,
    });
    expect(c30.out.join('')).toContain('triples: 0');
    // 365d catches it.
    const c365 = capture();
    await runPermissionCalibrationExport({
      sinceDays: 365,
      dbPath,
      env,
      now: () => now,
      out: c365.write.out,
      err: c365.write.err,
    });
    expect(c365.out.join('')).toContain('triples: 1');
  });

  test('--all-decisions widens to include auto-allow rows', async () => {
    const now = Date.now();
    seedApproval({ ts: now - 1000, decision: 'allow' }); // auto-allow
    seedApproval({ ts: now - 1000, decision: 'confirm-allowed' });
    // Default filter: only confirm-allowed counts.
    const cDefault = capture();
    await runPermissionCalibrationExport({
      dbPath,
      env,
      now: () => now,
      out: cDefault.write.out,
      err: cDefault.write.err,
    });
    expect(cDefault.out.join('')).toContain('triples: 1');
    // --all-decisions widens.
    const cAll = capture();
    await runPermissionCalibrationExport({
      allDecisions: true,
      dbPath,
      env,
      now: () => now,
      out: cAll.write.out,
      err: cAll.write.err,
    });
    expect(cAll.out.join('')).toContain('triples: 2');
  });

  test("install_id scope: another install's rows are invisible", async () => {
    const now = Date.now();
    seedApproval({
      ts: now - 1000,
      decision: 'confirm-allowed',
      installId: 'other-install-uuid',
    });
    const c = capture();
    await runPermissionCalibrationExport({
      dbPath,
      env,
      now: () => now,
      out: c.write.out,
      err: c.write.err,
    });
    expect(c.out.join('')).toContain('triples: 0');
  });
});

describe('runPermissionCalibrationExport — error paths', () => {
  test('non-positive sinceDays bypassing CLI rejection still gets caught', async () => {
    const c = capture();
    const code = await runPermissionCalibrationExport({
      sinceDays: 0,
      dbPath,
      env,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(1);
    expect(c.err.join('')).toContain('--since-days must be > 0');
  });

  test('install_id discovery failure exits 1', async () => {
    // env without HOME → installIdPath returns null → ensureInstallId throws.
    const c = capture();
    const code = await runPermissionCalibrationExport({
      dbPath,
      env: {} as NodeJS.ProcessEnv,
      out: c.write.out,
      err: c.write.err,
    });
    expect(code).toBe(1);
    expect(c.err.join('')).toContain('install_id');
  });
});
