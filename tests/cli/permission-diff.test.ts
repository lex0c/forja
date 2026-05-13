import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionDiff } from '../../src/cli/permission-diff.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission diff', () => {
  test('routes to permission.verb=diff with two seqs', () => {
    const r = parseArgs(['permission', 'diff', '1', '2']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('diff');
      expect(r.args.permission?.positionals).toEqual(['1', '2']);
    }
  });

  test('missing both seqs fails parse', () => {
    const r = parseArgs(['permission', 'diff']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly two');
    }
  });

  test('only one seq fails parse', () => {
    const r = parseArgs(['permission', 'diff', '1']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly two');
    }
  });

  test('three seqs fail parse', () => {
    const r = parseArgs(['permission', 'diff', '1', '2', '3']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly two');
    }
  });

  test('non-numeric seq fails parse', () => {
    const r = parseArgs(['permission', 'diff', 'abc', '2']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('zero seq fails parse', () => {
    const r = parseArgs(['permission', 'diff', '0', '1']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('out of range');
    }
  });

  test('--json toggle parsed alongside seqs', () => {
    const r = parseArgs(['permission', 'diff', '1', '2', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.positionals).toEqual(['1', '2']);
    }
  });
});

describe('runPermissionDiff', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-diff-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed two rows with provided overrides. Returns the seqs.
  const seedTwoRows = (
    a: Parameters<ReturnType<typeof createSqliteSink>['emit']>[0],
    b: Parameters<ReturnType<typeof createSqliteSink>['emit']>[0],
  ): { seq1: number; seq2: number } => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const e1 = sink.emit(a);
    const e2 = sink.emit(b);
    db.close();
    return { seq1: e1.seq, seq2: e2.seq };
  };

  test('identical rows: every field marked ✓ same', () => {
    const base = {
      session_id: 's',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow' as const,
      policy_hash: 'sha256:fix',
      reason_chain: [{ stage: 'engine-default' }],
      capabilities: ['exec:shell'],
      score: 0,
      score_components: {},
      confidence: 'high' as const,
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    };
    const { seq1, seq2 } = seedTwoRows(base, base);
    const out = captured();
    runPermissionDiff({
      seq1,
      seq2,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain(`Diff seq=${seq1} vs seq=${seq2}`);
    expect(text).toContain('✓ same');
    expect(text).not.toContain('⚠ different');
  });

  test('different decisions surface as ⚠ different on decision', async () => {
    const { seq1, seq2 } = seedTwoRows(
      {
        session_id: 's',
        tool_name: 'bash',
        args: { command: 'ls' },
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 1,
      },
      {
        session_id: 's',
        tool_name: 'bash',
        args: { command: 'ls' },
        decision: 'confirm',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 2,
      },
    );
    const out = captured();
    await runPermissionDiff({
      seq1,
      seq2,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('decision');
    expect(text).toContain('⚠ different');
    expect(text).toContain('allow');
    expect(text).toContain('confirm');
  });

  test('capabilities set diff shows only/common breakdown', async () => {
    const { seq1, seq2 } = seedTwoRows(
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: ['exec:shell', 'read-fs:/work'],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 1,
      },
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: ['exec:shell', 'write-fs:/work'],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 2,
      },
    );
    const out = captured();
    await runPermissionDiff({
      seq1,
      seq2,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('capabilities (set diff)');
    expect(text).toContain('read-fs:/work');
    expect(text).toContain('write-fs:/work');
    expect(text).toContain('exec:shell');
  });

  test('score_components diff shows shared deltas and only-in-each', async () => {
    const { seq1, seq2 } = seedTwoRows(
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0.4,
        score_components: { capability_risk: 0.4 },
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 1,
      },
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'confirm',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0.7,
        score_components: { capability_risk: 0.4, blocklist_command: 0.3 },
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 2,
      },
    );
    const out = captured();
    await runPermissionDiff({
      seq1,
      seq2,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('score_components diff');
    // capability_risk shared with same value → not in deltas (rendered)
    // blocklist_command only in seq2
    expect(text).toContain('blocklist_command');
  });

  test('missing row → exit 1 not_found', async () => {
    const out = captured();
    const err = captured();
    const code = await runPermissionDiff({
      seq1: 100,
      seq2: 200,
      dbPath,
      env,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no approval row found at seq=100');
  });

  test('cross-install refusal', async () => {
    const { seq1, seq2 } = seedTwoRows(
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 1,
      },
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 2,
      },
    );
    // Switch HOME to force a different install_id.
    const otherTmp = mkdtempSync(join(tmpdir(), 'forja-diff-other-'));
    try {
      const out = captured();
      const err = captured();
      const code = await runPermissionDiff({
        seq1,
        seq2,
        dbPath,
        env: { HOME: otherTmp },
        out: out.write,
        err: err.write,
      });
      expect(code).toBe(1);
      expect(err.lines.join('')).toContain('different install_id');
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });

  test('--json output: structured rows + diff sub-object', async () => {
    const { seq1, seq2 } = seedTwoRows(
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: ['exec:shell'],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 1,
      },
      {
        session_id: 's',
        tool_name: 'bash',
        args: {},
        decision: 'confirm',
        policy_hash: 'sha256:fix',
        reason_chain: [],
        capabilities: ['exec:shell', 'write-fs:.'],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 2,
      },
    );
    const out = captured();
    const code = await runPermissionDiff({
      seq1,
      seq2,
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.seq1).toBe(seq1);
    expect(obj.seq2).toBe(seq2);
    const diff = obj.diff as Record<string, unknown>;
    expect(diff.fields).toBeDefined();
    expect(diff.capabilities).toBeDefined();
    expect(diff.score_components).toBeDefined();
    const caps = diff.capabilities as Record<string, unknown>;
    expect(caps.only_in_seq2).toEqual(['write-fs:.']);
  });
});
