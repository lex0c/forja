import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionReplay } from '../../src/cli/permission-replay.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — permission replay', () => {
  test('routes to permission.verb=replay with numeric seq positional', () => {
    const r = parseArgs(['permission', 'replay', '42']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('replay');
      expect(r.args.permission?.positionals).toEqual(['42']);
    }
  });

  test('missing <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('<seq>');
      expect(r.message).toContain('required');
    }
  });

  test('non-numeric <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay', 'abc']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('zero <seq> fails parse', () => {
    const r = parseArgs(['permission', 'replay', '0']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('out of range');
    }
  });

  test('negative <seq> fails parse (treated as non-numeric by the regex)', () => {
    const r = parseArgs(['permission', 'replay', '-1']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('positive integer');
    }
  });

  test('multiple positionals fail parse', () => {
    const r = parseArgs(['permission', 'replay', '1', '2']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('exactly one');
    }
  });

  test('--json toggle parsed alongside <seq>', () => {
    const r = parseArgs(['permission', 'replay', '7', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.positionals).toEqual(['7']);
    }
  });

  test('unknown verb message lists replay', () => {
    const r = parseArgs(['permission', 'mystery']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('replay');
    }
  });

  test('--without-classifier flag flows through replay parse', () => {
    const r = parseArgs(['permission', 'replay', '42', '--without-classifier']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('replay');
      expect(r.args.permission?.withoutClassifier).toBe(true);
    }
  });

  test('--without-classifier on verify fails parse (§17 mode is replay-only)', () => {
    const r = parseArgs(['permission', 'verify', '--without-classifier']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--without-classifier only applies to');
    }
  });

  test('default parse leaves withoutClassifier undefined', () => {
    const r = parseArgs(['permission', 'replay', '42']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.withoutClassifier).toBeUndefined();
    }
  });

  test('--against-current-policy flag flows through replay parse', () => {
    const r = parseArgs(['permission', 'replay', '42', '--against-current-policy']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.againstCurrentPolicy).toBe(true);
    }
  });

  test('--against-current-policy on verify fails parse', () => {
    const r = parseArgs(['permission', 'verify', '--against-current-policy']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--against-current-policy only applies to');
    }
  });

  test('--against-current-policy and --without-classifier compose', () => {
    const r = parseArgs([
      'permission',
      'replay',
      '42',
      '--against-current-policy',
      '--without-classifier',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.againstCurrentPolicy).toBe(true);
      expect(r.args.permission?.withoutClassifier).toBe(true);
    }
  });

  // Slice 135 P1 audit-2: full matrix of replay flag combinations.
  // The three §17 replay modes are orthogonal — `--without-classifier`,
  // `--against-current-policy`, `--against-archived-policy`. Any
  // subset should parse + run together. The existing tests cover
  // {classifier, current} parse and {current, archived} runner; this
  // fills in the missing combinations (archived+classifier,
  // all-three, and argument-order independence).
  test('--against-archived-policy and --without-classifier compose', () => {
    const r = parseArgs([
      'permission',
      'replay',
      '42',
      '--against-archived-policy',
      '--without-classifier',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.againstArchivedPolicy).toBe(true);
      expect(r.args.permission?.withoutClassifier).toBe(true);
      // Unused flag stays undefined — no cross-pollination.
      expect(r.args.permission?.againstCurrentPolicy).toBeUndefined();
    }
  });

  test('all three replay-mode flags compose', () => {
    const r = parseArgs([
      'permission',
      'replay',
      '42',
      '--without-classifier',
      '--against-current-policy',
      '--against-archived-policy',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.withoutClassifier).toBe(true);
      expect(r.args.permission?.againstCurrentPolicy).toBe(true);
      expect(r.args.permission?.againstArchivedPolicy).toBe(true);
    }
  });

  test('flag ordering does not affect parse outcome', () => {
    // Same flags, two different orders, identical result.
    const order1 = parseArgs([
      'permission',
      'replay',
      '42',
      '--without-classifier',
      '--against-current-policy',
      '--against-archived-policy',
    ]);
    const order2 = parseArgs([
      'permission',
      'replay',
      '42',
      '--against-archived-policy',
      '--against-current-policy',
      '--without-classifier',
    ]);
    expect(order1.ok).toBe(true);
    expect(order2.ok).toBe(true);
    if (order1.ok && order2.ok) {
      expect(order1.args.permission?.withoutClassifier).toBe(
        order2.args.permission?.withoutClassifier,
      );
      expect(order1.args.permission?.againstCurrentPolicy).toBe(
        order2.args.permission?.againstCurrentPolicy,
      );
      expect(order1.args.permission?.againstArchivedPolicy).toBe(
        order2.args.permission?.againstArchivedPolicy,
      );
    }
  });

  test('--against-archived-policy rejected on verify verb', () => {
    const r = parseArgs(['permission', 'verify', '--against-archived-policy']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('--against-archived-policy only applies to');
    }
  });

  test('flags can interleave with the seq positional after the verb', () => {
    // Operator might write the seq anywhere after the verb;
    // positional discovery scans through the post-verb argv. Each
    // mode flag must still register regardless of where the seq
    // lands. parseArgs returns `positionals: ['42']` — the seq
    // proper is extracted by the runtime handler.
    const r = parseArgs([
      'permission',
      'replay',
      '--against-archived-policy',
      '--without-classifier',
      '42',
      '--against-current-policy',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.positionals).toEqual(['42']);
      expect(r.args.permission?.withoutClassifier).toBe(true);
      expect(r.args.permission?.againstCurrentPolicy).toBe(true);
      expect(r.args.permission?.againstArchivedPolicy).toBe(true);
    }
  });

  test('--json composes with all three replay-mode flags', () => {
    const r = parseArgs([
      'permission',
      'replay',
      '42',
      '--json',
      '--without-classifier',
      '--against-current-policy',
      '--against-archived-policy',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.withoutClassifier).toBe(true);
      expect(r.args.permission?.againstCurrentPolicy).toBe(true);
      expect(r.args.permission?.againstArchivedPolicy).toBe(true);
    }
  });
});

describe('runPermissionReplay', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedRow = (): number => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({
      session_id: 'sess-replay',
      tool_name: 'bash',
      args: { command: 'ls -la' },
      decision: 'allow',
      policy_hash: 'sha256:fixture-policy-hash',
      reason_chain: [
        { stage: 'static-rule', layer: 'project', rule: 'ls *', section: 'bash' },
        { stage: 'risk-score', note: 'score=0.00' },
      ],
      capabilities: ['exec:shell', 'read-fs:/work/proj'],
      score: 0,
      score_components: {},
      confidence: 'high',
      classifier_hash: 'fixture-v1',
      classifier_adjust: -0.05,
      sandbox_profile: 'cwd-rw',
      ttl_expires_at: null,
      ts: 1700000000000,
    });
    db.close();
    return r.seq;
  };

  test('text output: prints every preserved field', async () => {
    const seq = seedRow();
    const out = captured();
    const err = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain(`Replay approval seq=${seq}`);
    expect(text).toContain('tool:               bash (version=v1)');
    expect(text).toContain('decision:           allow');
    expect(text).toContain('args_hash:');
    expect(text).toContain('exec:shell');
    expect(text).toContain('read-fs:/work/proj');
    expect(text).toContain('sandbox profile:    cwd-rw');
    expect(text).toContain('classifier:         hash=fixture-v1, adjust=-0.05');
    expect(text).toContain('stage=static-rule');
    expect(text).toContain('rule="ls *"');
    expect(text).toContain('sha256:fixture-policy-hash');
    // The fixture policy hash will NOT match the active policy
    // (loadActivePolicy resolves a real one); drift should fire.
    expect(text).toContain('policy drift:');
    expect(err.lines).toEqual([]);
  });

  test('JSON output: one NDJSON line with parsed sub-objects', async () => {
    const seq = seedRow();
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.length).toBe(1);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.seq).toBe(seq);
    expect(obj.tool_name).toBe('bash');
    expect(obj.decision).toBe('allow');
    expect(obj.capabilities).toEqual(['exec:shell', 'read-fs:/work/proj']);
    expect(obj.reason_chain).toEqual([
      { stage: 'static-rule', layer: 'project', rule: 'ls *', section: 'bash' },
      { stage: 'risk-score', note: 'score=0.00' },
    ]);
    expect(typeof obj.policy_drift).toBe('boolean');
    expect(typeof obj.active_policy_hash).toBe('string');
  });

  test('row missing → exit 1 with not_found error', async () => {
    // Seed install_id + DB but no rows.
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    db.close();

    const out = captured();
    const err = captured();
    const code = await runPermissionReplay({
      seq: 999,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no approval row found at seq=999');
  });

  test('row from a different install_id → exit 1 (not_found)', async () => {
    // Seed under one install, then re-run replay with a different
    // HOME (different install_id) — the seq exists but belongs to
    // the other install. Replay must refuse cross-install lookups.
    const seq = seedRow();
    const otherTmp = mkdtempSync(join(tmpdir(), 'forja-replay-other-'));
    try {
      const otherEnv = { HOME: otherTmp };
      const otherOut = captured();
      const otherErr = captured();
      const code = await runPermissionReplay({
        seq,
        dbPath,
        env: otherEnv,
        cwd: otherTmp,
        out: otherOut.write,
        err: otherErr.write,
      });
      expect(code).toBe(1);
      expect(otherErr.lines.join('')).toContain('different install_id');
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });

  test('JSON not_found shape includes install_id + seq', async () => {
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: 12345,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    expect(obj.ok).toBe(false);
    expect(obj.error).toBe('not_found');
    expect(obj.seq).toBe(12345);
    expect(typeof obj.install_id).toBe('string');
  });

  test('policy drift: ACTIVE matches the row → no drift', async () => {
    // Re-emit a row whose policy_hash matches the hash of an
    // explicitly-empty policy. cwd has no policy YAML, so the active
    // policy is the default (empty rules) — its canonical hash is
    // computable; we mirror it on the row's policy_hash and assert
    // no drift fires.
    const identity = ensureInstallId({ env });
    const { canonicalHash, resolvePolicy } = await import('../../src/permissions/index.ts');
    const activePolicy = resolvePolicy({ cwd: tmp, home: tmp, env }).policy;
    const activeHash = `sha256:${canonicalHash(activePolicy)}`;

    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({
      session_id: 'sess',
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: activeHash,
      reason_chain: [{ stage: 'engine-default' }],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: r.seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('active policy matches the row');
  });

  test('policy drift: malformed active policy → drift undecidable, shown as unavailable', async () => {
    // Plant a malformed user-policy YAML so resolvePolicy throws.
    // Replay must still render the row (don't bring down a forensic
    // readout because the live config is broken).
    const seq = seedRow();

    // Override resolvePolicy lookup by setting a broken
    // user-policy file. resolvePolicy tries to read both enterprise +
    // user files; missing OK, but if HOME has a malformed
    // ~/.config/agent/permissions.yaml it throws.
    const userDir = join(tmp, '.config', 'agent');
    require('node:fs').mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'permissions.yaml'), 'this is: not :: valid: yaml: : :');

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    // Replay swallows the policy error and reports the row.
    expect(out.lines.join('')).toContain(`Replay approval seq=${seq}`);
    expect(out.lines.join('')).toContain('active policy unavailable');
  });
});

describe('runPermissionReplay — --without-classifier analysis', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-wc-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed a row with explicit score + components + classifier_adjust
  // so the analysis math is verifiable. The §6.6 threshold is 0.40.
  const seedScoredRow = (params: {
    components: Record<string, number>;
    classifierAdjust: number | null;
  }): number => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const sink = createSqliteSink({ db, identity });
    const deterministic = Math.min(
      1,
      Math.max(
        0,
        Object.values(params.components).reduce((acc, v) => acc + v, 0),
      ),
    );
    const finalScore =
      params.classifierAdjust === null
        ? deterministic
        : Math.min(1, Math.max(0, deterministic + params.classifierAdjust));
    const r = sink.emit({
      session_id: 'sess',
      tool_name: 'bash',
      args: { command: 'x' },
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'engine-default' }],
      capabilities: [],
      score: finalScore,
      score_components: params.components,
      confidence: 'high',
      classifier_hash: params.classifierAdjust === null ? null : 'v1',
      classifier_adjust: params.classifierAdjust,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.close();
    return r.seq;
  };

  test("verdict 'not_run' when classifier_adjust is null", async () => {
    const seq = seedScoredRow({
      components: { capability_risk: 0.4 },
      classifierAdjust: null,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      withoutClassifier: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Classifier impact analysis');
    expect(text).toContain('classifier did not run');
  });

  test("verdict 'no_change' when classifier adjust does not cross threshold", async () => {
    // Deterministic score 0.50 (above threshold), classifier adjusts
    // -0.05 → final 0.45. Both still gate. Verdict: no change.
    const seq = seedScoredRow({
      components: { capability_risk: 0.4, mcp_tool: 0.1 },
      classifierAdjust: -0.05,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      withoutClassifier: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('no change');
  });

  test("verdict 'changed_decision' when classifier LOWERED below threshold", async () => {
    // Deterministic 0.50 (above 0.40), classifier -0.15 → final 0.35
    // (below 0.40). Without classifier, the score-gate WOULD have
    // fired. With classifier, it did NOT.
    const seq = seedScoredRow({
      components: { capability_risk: 0.4, mcp_tool: 0.1 },
      classifierAdjust: -0.15,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      withoutClassifier: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('classifier LOWERED');
    expect(text).toContain('without it, the gate would have fired');
  });

  test("verdict 'changed_decision' when classifier RAISED above threshold", async () => {
    // Deterministic 0.30 (below 0.40), classifier +0.15 → final 0.45
    // (above 0.40). Classifier raised the score across the gate.
    const seq = seedScoredRow({
      components: { capability_risk: 0.3 },
      classifierAdjust: 0.15,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      withoutClassifier: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('classifier RAISED');
    expect(text).toContain('without it, no gate would have fired');
  });

  test('JSON output includes classifier_impact sub-object', async () => {
    // Same shape as the 'no_change' verdict above: deterministic
    // 0.50 (above threshold), classifier -0.05 → final 0.45 (still
    // above). Both gate; verdict 'no_change'.
    const seq = seedScoredRow({
      components: { capability_risk: 0.4, mcp_tool: 0.1 },
      classifierAdjust: -0.05,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      withoutClassifier: true,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    const impact = obj.classifier_impact as Record<string, unknown>;
    expect(impact).toBeDefined();
    expect(impact.verdict).toBe('no_change');
    expect(impact.threshold).toBe(0.4);
    expect(impact.classifier_adjust).toBe(-0.05);
    expect(typeof impact.deterministic_score).toBe('number');
    expect(typeof impact.would_gate_with_classifier).toBe('boolean');
    expect(typeof impact.would_gate_without_classifier).toBe('boolean');
  });

  test('default replay (no flag) omits classifier_impact', async () => {
    const seq = seedScoredRow({
      components: { capability_risk: 0.4 },
      classifierAdjust: -0.05,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).not.toContain('Classifier impact analysis');
  });
});

describe('runPermissionReplay — --against-current-policy re-execution (slice 16)', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-acp-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seeds the full chain a replay would consume: sessions, message,
  // tool_calls (with raw args), approvals_log (emitted via SQLite
  // sink), approval_call_links. Returns the emitted approval seq.
  const seedFullReplayable = async (args: Record<string, unknown>): Promise<number> => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    // Make sure the bash AST resolver is ready — engine.check on
    // `bash` category fires the resolver, which throws without init.
    const { initBashParser } = await import('../../src/permissions/bash-parser.ts');
    await initBashParser();

    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const { appendMessage } = await import('../../src/storage/repos/messages.ts');
    const { createToolCall } = await import('../../src/storage/repos/tool-calls.ts');
    const { linkApprovalToToolCall } = await import(
      '../../src/storage/repos/approval-call-links.ts'
    );

    const session = createSession(db, { model: 'm', cwd: tmp });
    const message = appendMessage(db, {
      sessionId: session.id,
      role: 'assistant',
      content: 'x',
    });
    const toolCall = createToolCall(db, {
      messageId: message.id,
      toolName: 'bash',
      input: args,
    });
    const sink = createSqliteSink({ db, identity });
    const emitted = sink.emit({
      session_id: session.id,
      tool_name: 'bash',
      args,
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'engine-default' }],
      capabilities: ['exec:shell', `read-fs:${tmp}`],
      score: 0,
      score_components: {},
      confidence: 'high',
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    linkApprovalToToolCall(db, {
      approvalSeq: emitted.seq,
      toolCallId: toolCall.id,
    });
    db.close();
    return emitted.seq;
  };

  test('deterministic: active policy produces the same decision', async () => {
    // Project policy allows ls in cwd; row is decision='allow';
    // active policy (loaded from tmp cwd — no .agent/permissions.yaml
    // so defaults apply) would default-deny. Hmm, default behavior is
    // strict + default-deny → drift. To make this case truly
    // deterministic we plant a project policy mirroring what produced
    // the row's allow.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.agent', 'permissions.yaml'),
      `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    );
    const seq = await seedFullReplayable({ command: 'ls -la' });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Re-execution against ACTIVE policy');
    expect(text).toContain('original decision:         allow');
    expect(text).toContain('replayed decision:         allow');
    expect(text).toContain('✓ deterministic');
  });

  test('changed_decision: active policy differs (no rule matches → default deny)', async () => {
    // No active policy file. Active resolves to defaults: strict /
    // empty rules. row.decision='allow' (fixture-seeded); replay
    // re-execution gets default-deny → verdict 'changed_decision'.
    const seq = await seedFullReplayable({ command: 'ls -la' });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('policy drift changed the decision');
    expect(text).toContain('(allow → deny)');
  });

  test('skipped: no approval_call_link for the seq', async () => {
    // Seed a real session + audit row but DON'T write a link —
    // emulates a pre-slice-15 audit row, or a write that dropped
    // through a transaction crash between emit and link.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const session = createSession(db, { model: 'm', cwd: tmp });
    const sink = createSqliteSink({ db, identity });
    const emitted = sink.emit({
      session_id: session.id,
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:fixture',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: emitted.seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('skipped');
    expect(text).toContain('no tool_call linked');
  });

  test('JSON output includes against_current_policy sub-object', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.agent', 'permissions.yaml'),
      `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    );
    const seq = await seedFullReplayable({ command: 'ls -la' });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    const acp = obj.against_current_policy as Record<string, unknown>;
    expect(acp).toBeDefined();
    expect(acp.verdict).toBe('deterministic');
    expect(acp.original_decision).toBe('allow');
    expect(acp.replayed_decision).toBe('allow');
  });

  test('default replay (no flag) omits against_current_policy', async () => {
    const seq = await seedFullReplayable({ command: 'ls' });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).not.toContain('Re-execution against ACTIVE policy');
  });
});

// Slice 96 — R12 #52 closure: §23 "Replay funcional pra todas as
// categorias" required deny + confirm fixtures. Pre-slice, every
// replay test seeded `decision: 'allow'` exclusively, so the
// `--against-current-policy` mode had ZERO regression coverage for
// the deny/confirm sides of the rule pipeline. These tests prove
// the replay surfaces both the deterministic and changed_decision
// verdicts for every recorded outcome.
describe('runPermissionReplay — --against-current-policy decision coverage (slice 96, R12 #52)', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-decisions-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed a fully-replayable row with a specified decision. The
  // `decision` lands on the approvals_log row verbatim; the
  // active policy at the cwd controls what the replay engine
  // produces, so each test pairs a decision with a policy.yaml
  // designed to make replay match (deterministic) or diverge
  // (changed_decision).
  const seedRowWithDecision = async (params: {
    decision: 'allow' | 'deny' | 'confirm';
    args: Record<string, unknown>;
    toolName?: string;
  }): Promise<number> => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const { initBashParser } = await import('../../src/permissions/bash-parser.ts');
    await initBashParser();

    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const { appendMessage } = await import('../../src/storage/repos/messages.ts');
    const { createToolCall } = await import('../../src/storage/repos/tool-calls.ts');
    const { linkApprovalToToolCall } = await import(
      '../../src/storage/repos/approval-call-links.ts'
    );

    const session = createSession(db, { model: 'm', cwd: tmp });
    const message = appendMessage(db, {
      sessionId: session.id,
      role: 'assistant',
      content: 'x',
    });
    const toolName = params.toolName ?? 'bash';
    const toolCall = createToolCall(db, {
      messageId: message.id,
      toolName,
      input: params.args,
    });
    const sink = createSqliteSink({ db, identity });
    const emitted = sink.emit({
      session_id: session.id,
      tool_name: toolName,
      args: params.args,
      decision: params.decision,
      policy_hash: 'sha256:fixture',
      reason_chain: [{ stage: 'engine-default' }],
      capabilities:
        toolName === 'bash'
          ? ['exec:shell', `read-fs:${tmp}`]
          : [`read-fs:${tmp}/${(params.args.file_path as string | undefined) ?? ''}`],
      score: 0,
      score_components: {},
      confidence: 'high',
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    linkApprovalToToolCall(db, { approvalSeq: emitted.seq, toolCallId: toolCall.id });
    db.close();
    return emitted.seq;
  };

  test('deny row + active policy still denies → deterministic', async () => {
    // Active policy has bash.deny that matches the command. Row
    // recorded `deny`; replay against the same shape also denies.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.agent', 'permissions.yaml'),
      `defaults:
  mode: strict
tools:
  bash:
    deny:
      - "rm *"
`,
    );
    const seq = await seedRowWithDecision({ decision: 'deny', args: { command: 'rm -rf /tmp' } });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('original decision:         deny');
    expect(text).toContain('replayed decision:         deny');
    expect(text).toContain('✓ deterministic');
  });

  test('deny row + active policy now allows → changed_decision', async () => {
    // Operator added an allow rule that overrides the prior deny
    // shape. `ls` is high-confidence in the bash resolver so the
    // allow rule survives without a conservative-resolver upgrade
    // to confirm; the verdict cleanly surfaces deny → allow.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.agent', 'permissions.yaml'),
      `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    );
    const seq = await seedRowWithDecision({ decision: 'deny', args: { command: 'ls -la' } });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('policy drift changed the decision');
    expect(text).toContain('(deny → allow)');
  });

  test('confirm row + active policy still confirms → deterministic', async () => {
    // bash command containing `;` triggers the compound-command
    // guard which forces confirm regardless of allow rules. Pin
    // the shape to test the confirm path through the rule pipeline.
    const seq = await seedRowWithDecision({
      decision: 'confirm',
      args: { command: 'ls; rm tmp' },
    });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('original decision:         confirm');
    expect(text).toContain('replayed decision:         confirm');
    expect(text).toContain('✓ deterministic');
  });

  test('confirm row + active policy now denies (rule added) → changed_decision', async () => {
    // Operator added a deny rule that catches the literal shape;
    // deny short-circuits before the compound-command guard fires.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.agent', 'permissions.yaml'),
      `defaults:
  mode: strict
tools:
  bash:
    deny:
      - "ls*"
`,
    );
    const seq = await seedRowWithDecision({
      decision: 'confirm',
      args: { command: 'ls; rm tmp' },
    });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('policy drift changed the decision');
    expect(text).toContain('(confirm → deny)');
  });

  test('caveats rendered below every verdict (replay-engine bounds)', async () => {
    const seq = await seedRowWithDecision({ decision: 'deny', args: { command: 'rm -rf /tmp' } });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('caveats (engine dimensions NOT replayed):');
    expect(text).toContain('classifier output not replayed');
    expect(text).toContain('grants snapshot not preserved');
    expect(text).toContain('sandbox availability not preserved');
  });

  test('JSON output carries caveats array', async () => {
    const seq = await seedRowWithDecision({ decision: 'deny', args: { command: 'rm -rf /tmp' } });

    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstCurrentPolicy: true,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    const acp = obj.against_current_policy as { caveats: string[] };
    expect(Array.isArray(acp.caveats)).toBe(true);
    expect(acp.caveats.length).toBeGreaterThan(0);
    expect(acp.caveats.some((c) => c.includes('classifier'))).toBe(true);
  });
});

// Slice 96 — §17 canonical reproducibility mode. Re-runs the row
// against the ORIGINAL policy bytes (looked up by row.policy_hash
// in policy_archive). The deterministic verdict here is the
// strongest replay signal: matching means the rule pipeline IS
// reproducible (modulo the caveats — classifier/grants/sandbox).
describe('runPermissionReplay — --against-archived-policy (slice 96, R11 #34)', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-replay-archived-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Seed a row whose policy_hash matches an entry in policy_archive.
  // Uses canonicalHash to compute the real hash of a Policy object
  // and archives the canonical bytes — same shape bootstrap-engine.ts
  // uses in production.
  const seedRowWithArchivedPolicy = async (params: {
    decision: 'allow' | 'deny' | 'confirm';
    args: Record<string, unknown>;
    policyYaml: string;
  }): Promise<{ seq: number; policyHash: string }> => {
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const { initBashParser } = await import('../../src/permissions/bash-parser.ts');
    await initBashParser();

    const { canonicalHash, canonicalize } = await import('../../src/permissions/canonical.ts');
    const { archivePolicy } = await import('../../src/storage/repos/policy-archive.ts');
    const { resolvePolicy } = await import('../../src/permissions/index.ts');

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(join(tmp, '.agent', 'permissions.yaml'), params.policyYaml);

    const resolved = resolvePolicy({ cwd: tmp, home: tmp, env });
    const canonicalJson = canonicalize(resolved.policy);
    const policyHash = `sha256:${canonicalHash(resolved.policy)}`;

    archivePolicy(db, {
      policy_hash: policyHash,
      canonical_json: canonicalJson,
      now: 1,
    });

    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const { appendMessage } = await import('../../src/storage/repos/messages.ts');
    const { createToolCall } = await import('../../src/storage/repos/tool-calls.ts');
    const { linkApprovalToToolCall } = await import(
      '../../src/storage/repos/approval-call-links.ts'
    );

    const session = createSession(db, { model: 'm', cwd: tmp });
    const message = appendMessage(db, {
      sessionId: session.id,
      role: 'assistant',
      content: 'x',
    });
    const toolCall = createToolCall(db, {
      messageId: message.id,
      toolName: 'bash',
      input: params.args,
    });
    const sink = createSqliteSink({ db, identity });
    const emitted = sink.emit({
      session_id: session.id,
      tool_name: 'bash',
      args: params.args,
      decision: params.decision,
      policy_hash: policyHash,
      reason_chain: [{ stage: 'engine-default' }],
      capabilities: ['exec:shell', `read-fs:${tmp}`],
      score: 0,
      score_components: {},
      confidence: 'high',
      classifier_hash: null,
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    linkApprovalToToolCall(db, { approvalSeq: emitted.seq, toolCallId: toolCall.id });
    db.close();
    return { seq: emitted.seq, policyHash };
  };

  test('allow row + archived policy reproduces → deterministic', async () => {
    const { seq } = await seedRowWithArchivedPolicy({
      decision: 'allow',
      args: { command: 'ls -la' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstArchivedPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Re-execution against ARCHIVED policy');
    expect(text).toContain('original decision:         allow');
    expect(text).toContain('replayed decision:         allow');
    expect(text).toContain('✓ deterministic');
  });

  test('deny row + archived policy reproduces deny → deterministic', async () => {
    const { seq } = await seedRowWithArchivedPolicy({
      decision: 'deny',
      args: { command: 'rm -rf /tmp' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    deny:
      - "rm *"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstArchivedPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('original decision:         deny');
    expect(text).toContain('replayed decision:         deny');
    expect(text).toContain('✓ deterministic');
  });

  test('confirm row + archived policy reproduces confirm → deterministic', async () => {
    const { seq } = await seedRowWithArchivedPolicy({
      decision: 'confirm',
      args: { command: 'ls; rm tmp' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstArchivedPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('original decision:         confirm');
    expect(text).toContain('replayed decision:         confirm');
    expect(text).toContain('✓ deterministic');
  });

  test('archive miss → skipped with operator-readable cause', async () => {
    // Seed a row with a policy_hash NOT present in policy_archive
    // (no archivePolicy call). Replay surfaces the miss as
    // skipped — operator can still inspect the row's recorded
    // hash for forensic value.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const { createSession } = await import('../../src/storage/repos/sessions.ts');
    const session = createSession(db, { model: 'm', cwd: tmp });
    const sink = createSqliteSink({ db, identity });
    const emitted = sink.emit({
      session_id: session.id,
      tool_name: 'bash',
      args: { command: 'ls' },
      decision: 'allow',
      policy_hash: 'sha256:never-archived',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.close();

    const out = captured();
    const code = await runPermissionReplay({
      seq: emitted.seq,
      againstArchivedPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Re-execution against ARCHIVED policy');
    expect(text).toContain('skipped');
    expect(text).toContain('not in policy_archive');
  });

  test('JSON output carries against_archived_policy sub-object with archived_policy_hash', async () => {
    const { seq, policyHash } = await seedRowWithArchivedPolicy({
      decision: 'allow',
      args: { command: 'ls -la' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstArchivedPolicy: true,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(out.lines[0] as string) as Record<string, unknown>;
    const aap = obj.against_archived_policy as Record<string, unknown>;
    expect(aap).toBeDefined();
    expect(aap.verdict).toBe('deterministic');
    expect(aap.archived_policy_hash).toBe(policyHash);
    expect(aap.original_decision).toBe('allow');
    expect(aap.replayed_decision).toBe('allow');
    expect(Array.isArray(aap.caveats)).toBe(true);
  });

  test('both modes can run simultaneously', async () => {
    // Operator wants both reproducibility (archived) and drift
    // impact (current) in one shot. The replay surface accepts
    // both flags; output contains both sections.
    const { seq } = await seedRowWithArchivedPolicy({
      decision: 'allow',
      args: { command: 'ls -la' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      againstArchivedPolicy: true,
      againstCurrentPolicy: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Re-execution against ACTIVE policy');
    expect(text).toContain('Re-execution against ARCHIVED policy');
  });

  test('default replay (no flag) omits against_archived_policy', async () => {
    const { seq } = await seedRowWithArchivedPolicy({
      decision: 'allow',
      args: { command: 'ls -la' },
      policyYaml: `defaults:
  mode: strict
tools:
  bash:
    allow:
      - "ls*"
`,
    });
    const out = captured();
    const code = await runPermissionReplay({
      seq,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).not.toContain('Re-execution against ARCHIVED policy');
  });
});
