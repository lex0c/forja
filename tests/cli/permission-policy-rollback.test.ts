import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionPolicyRollback } from '../../src/cli/permission-policy-rollback.ts';
import { ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import { listApprovalsLogByInstall } from '../../src/storage/repos/approvals-log.ts';
import { archivePolicy } from '../../src/storage/repos/policy-archive.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — forja permission policy-rollback', () => {
  test('hash positional captured', () => {
    const r = parseArgs(['permission', 'policy-rollback', 'sha256:abc']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('policy-rollback');
      expect(r.args.permission?.positionals).toEqual(['sha256:abc']);
    }
  });

  test('--write flag captured', () => {
    const r = parseArgs(['permission', 'policy-rollback', 'sha256:abc', '--write']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.permission?.rollbackWrite).toBe(true);
  });

  test('--target captured', () => {
    const r = parseArgs(['permission', 'policy-rollback', 'sha256:abc', '--target', '/tmp/x.yaml']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.permission?.rollbackTarget).toBe('/tmp/x.yaml');
  });

  test('--write on non-rollback verb rejected', () => {
    const r = parseArgs(['permission', 'verify', '--write']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--write');
  });

  test('missing hash positional rejected', () => {
    const r = parseArgs(['permission', 'policy-rollback']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('exactly one <hash>');
  });

  test('--target without value rejected', () => {
    const r = parseArgs(['permission', 'policy-rollback', 'sha256:abc', '--target']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--target requires a file path');
  });
});

describe('runPermissionPolicyRollback', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  const CANONICAL = '{"defaults":{"mode":"strict"},"tools":{}}';
  const HASH = 'sha256:test-hash-aaaa';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-perm-rollback-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedArchive = (rows: ReadonlyArray<{ hash: string; canonical: string; now?: number }>) => {
    ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    for (const r of rows) {
      archivePolicy(db, {
        policy_hash: r.hash,
        canonical_json: r.canonical,
        now: r.now ?? 1_000,
      });
    }
  };

  test('hash not in archive → exit 1 + "not found" error', async () => {
    seedArchive([]);
    const out = captured();
    const err = captured();
    const code = await runPermissionPolicyRollback({
      hash: 'sha256:missing',
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join('')).toContain('no policy archive entry');
  });

  test('dry-run (no --write): renders summary, leaves target file untouched', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const targetFile = join(tmp, 'permissions.yaml');
    writeFileSync(targetFile, 'defaults: { mode: acceptEdits }\n');
    const out = captured();
    let writeCalled = false;
    const code = await runPermissionPolicyRollback({
      hash: HASH,
      target: targetFile,
      dbPath,
      env,
      cwd: tmp,
      writeFile: () => {
        writeCalled = true;
      },
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(writeCalled).toBe(false);
    const text = out.lines.join('');
    expect(text).toContain('dry-run');
    expect(text).toContain(HASH);
    expect(text).toContain(targetFile);
    expect(text).toContain('--write');
    // Underlying file unchanged on disk.
    expect(readFileSync(targetFile, 'utf-8')).toBe('defaults: { mode: acceptEdits }\n');
  });

  test('dry-run when target file does not exist → "will be created" hint', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const targetFile = join(tmp, 'does-not-exist.yaml');
    const out = captured();
    await runPermissionPolicyRollback({
      hash: HASH,
      target: targetFile,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(out.lines.join('')).toContain('will be created');
  });

  test('--write: overwrites target file with canonical_json AND emits audit row', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const targetFile = join(tmp, 'permissions.yaml');
    writeFileSync(targetFile, 'stale content\n');
    const out = captured();
    const captureBox: { path: string | null; content: string | null } = {
      path: null,
      content: null,
    };
    const code = await runPermissionPolicyRollback({
      hash: HASH,
      target: targetFile,
      write: true,
      dbPath,
      env,
      cwd: tmp,
      now: () => 5_000,
      writeFile: (p, c) => {
        captureBox.path = p;
        captureBox.content = c;
      },
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    // File-write call captured (the writeFile stub doesn't actually
    // touch the filesystem; tests don't need real I/O for assertion).
    expect(captureBox.path).toBe(targetFile);
    expect(captureBox.content).toBe(CANONICAL);
    // Plain-text confirmation includes the bytes-written count.
    const text = out.lines.join('');
    expect(text).toContain('committed');
    expect(text).toContain(`bytes written: ${CANONICAL.length}`);
    expect(text).toContain('audit:         emitted');
    // Audit row landed in approvals_log via the real sink.
    const identity = ensureInstallId({ env });
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    const rollbackRow = rows.find((r) => r.tool_name === 'permission-engine');
    expect(rollbackRow).toBeDefined();
    expect(rollbackRow?.decision).toBe('allow');
    expect(rollbackRow?.policy_hash).toBe(HASH);
    const reason = JSON.parse(rollbackRow?.reason_chain_json ?? '[]');
    expect(reason[0].stage).toBe('policy-rollback');
    expect(reason[0].note).toContain(`to_hash=${HASH}`);
  });

  test('--write with no existing target file: still writes the bytes (fresh install)', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const targetFile = join(tmp, 'fresh.yaml');
    let written = false;
    await runPermissionPolicyRollback({
      hash: HASH,
      target: targetFile,
      write: true,
      dbPath,
      env,
      cwd: tmp,
      writeFile: () => {
        written = true;
      },
      out: captured().write,
      err: captured().write,
    });
    expect(written).toBe(true);
  });

  test('--json dry-run shape', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const out = captured();
    const code = await runPermissionPolicyRollback({
      hash: HASH,
      target: join(tmp, 'permissions.yaml'),
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const env_ = JSON.parse(out.lines.join('').trim());
    expect(env_.ok).toBe(true);
    expect(env_.dry_run).toBe(true);
    expect(env_.hash).toBe(HASH);
    expect(env_.archive_bytes).toBe(CANONICAL.length);
    expect(env_.current_bytes).toBeNull(); // file doesn't exist
  });

  test('--json --write shape', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const out = captured();
    await runPermissionPolicyRollback({
      hash: HASH,
      target: join(tmp, 'permissions.yaml'),
      write: true,
      json: true,
      dbPath,
      env,
      cwd: tmp,
      writeFile: () => {},
      out: out.write,
      err: captured().write,
    });
    const env_ = JSON.parse(out.lines.join('').trim());
    expect(env_.ok).toBe(true);
    expect(env_.dry_run).toBe(false);
    expect(env_.bytes_written).toBe(CANONICAL.length);
  });

  test('--json not-found returns ok=false + error=not_found', async () => {
    seedArchive([]);
    const out = captured();
    const code = await runPermissionPolicyRollback({
      hash: 'sha256:missing',
      json: true,
      dbPath,
      env,
      cwd: tmp,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(1);
    const env_ = JSON.parse(out.lines.join('').trim());
    expect(env_.ok).toBe(false);
    expect(env_.error).toBe('not_found');
  });

  test('default target is `.forja/permissions.yaml` relative to cwd', async () => {
    seedArchive([{ hash: HASH, canonical: CANONICAL }]);
    const targetBox: { path: string | null } = { path: null };
    await runPermissionPolicyRollback({
      hash: HASH,
      // No `target` — handler picks default.
      write: true,
      dbPath,
      env,
      cwd: tmp,
      writeFile: (p) => {
        targetBox.path = p;
      },
      out: captured().write,
      err: captured().write,
    });
    expect(targetBox.path).toBe(join(tmp, '.forja/permissions.yaml'));
  });
});
