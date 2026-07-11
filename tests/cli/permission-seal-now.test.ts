import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionSealNow } from '../../src/cli/permission-seal-now.ts';
import {
  createSqliteSink,
  ensureInstallId,
  type SealEntry,
  type SealStore,
} from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

describe('parseArgs — forja permission seal-now', () => {
  test('verb is recognized', () => {
    const r = parseArgs(['permission', 'seal-now']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('seal-now');
      expect(r.args.permission?.positionals).toEqual([]);
    }
  });

  test('--json captured', () => {
    const r = parseArgs(['permission', 'seal-now', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
    }
  });

  test('positionals rejected', () => {
    const r = parseArgs(['permission', 'seal-now', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no positionals expected');
  });

  test('--reason rejected', () => {
    const r = parseArgs(['permission', 'seal-now', '--reason', 'because']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--reason only applies');
  });
});

let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-seal-now-cli-'));
  dbPath = join(tmpRoot, 'state.sqlite');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Write a user-level YAML with the given seal section. Returns the
// path so the test can pass it as `userPath` to runPermissionSealNow.
const writeUserYaml = (sealSection: string | null): string => {
  const path = join(tmpRoot, 'user-permissions.yaml');
  const content =
    sealSection === null
      ? 'defaults:\n  mode: strict\n'
      : `defaults:\n  mode: strict\n${sealSection}\n`;
  writeFileSync(path, content);
  return path;
};

// Prepares a DB with `rowCount` chain rows for the given install_id.
const seedChain = (installEnv: NodeJS.ProcessEnv, rowCount: number) => {
  const db = openDb(dbPath);
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: installEnv,
    now: () => 1,
    uuid: () => 'seal-now-uuid-aaaa-bbbb',
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
  db.close?.();
  return identity;
};

const makeMemFactory = () => {
  const entries: SealEntry[] = [];
  let shouldFail: string | null = null;
  const factory = (): SealStore => ({
    append: (entry) => {
      if (shouldFail !== null) return { ok: false, reason: shouldFail };
      entries.push(entry);
      return { ok: true };
    },
    list: () => entries.slice(),
    close: () => {},
  });
  return {
    factory,
    entries,
    failNext: (reason: string) => {
      shouldFail = reason;
    },
  };
};

const captureOutput = () => {
  let stdout = '';
  let stderr = '';
  return {
    out: (s: string) => {
      stdout += s;
    },
    err: (s: string) => {
      stderr += s;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
};

describe('runPermissionSealNow', () => {
  test('returns 1 when policy has no seal section', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml(null); // no seal: section
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stderr).toContain('sealing is not configured');
  });

  test('returns 1 when mode is "none"', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: none');
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stderr).toContain('sealing is not configured');
  });

  test('chain empty → returns 0 with chain_empty noop message', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 0);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(io.stdout).toContain('chain is empty');
    expect(mem.entries).toHaveLength(0);
  });

  test('healthy chain → seals one entry pointing at latest seq', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 5);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      now: () => 7777,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]?.seq).toBe(5);
    expect(mem.entries[0]?.ts).toBe(7777);
    expect(io.stdout).toContain('sealed seq 5');
  });

  test('already-sealed seq → returns 0 with already_sealed noop', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 3);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    const io1 = captureOutput();
    // First call: seals seq=3.
    await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      out: io1.out,
      err: io1.err,
    });
    expect(mem.entries).toHaveLength(1);
    // Second call without any new emits — chain head still at seq=3.
    const io2 = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      out: io2.out,
      err: io2.err,
    });
    expect(code).toBe(0);
    expect(io2.stdout).toContain('already sealed at seq 3');
    expect(mem.entries).toHaveLength(1);
  });

  test('store.append failure → returns 1 with reason in stderr', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 2);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    mem.failNext('chattr +a failed: permission denied');
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stderr).toContain('append failed');
    expect(io.stderr).toContain('chattr +a failed');
  });

  test('JSON mode emits a single NDJSON line on success', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      now: () => 12345,
      json: true,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.sealed?.seq).toBe(1);
    expect(parsed.sealed?.ts).toBe(12345);
  });

  test('JSON mode emits structured error on store failure', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const mem = makeMemFactory();
    mem.failNext('disk full');
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: mem.factory,
      json: true,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(io.stdout.trim());
    expect(parsed).toEqual({ ok: false, error: 'append', message: 'disk full' });
  });

  test('corrupted seal file (list throws) → returns 1', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const factory = (): SealStore => ({
      append: () => ({ ok: true }),
      list: () => {
        throw new Error('malformed seal entry at line 7');
      },
      close: () => {},
    });
    const io = captureOutput();
    const code = await runPermissionSealNow({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: factory,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stderr).toContain('seal file corrupted');
  });
});
