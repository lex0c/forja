import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionSealVerify } from '../../src/cli/permission-seal-verify.ts';

describe('parseArgs — agent permission seal-verify', () => {
  test('verb is recognized', () => {
    const r = parseArgs(['permission', 'seal-verify']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('seal-verify');
      expect(r.args.permission?.positionals).toEqual([]);
    }
  });

  test('--json captured', () => {
    const r = parseArgs(['permission', 'seal-verify', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
    }
  });

  test('positionals rejected', () => {
    const r = parseArgs(['permission', 'seal-verify', '7']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no positionals expected');
  });

  test('--reason rejected', () => {
    const r = parseArgs(['permission', 'seal-verify', '--reason', 'because']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--reason only applies');
  });
});
import {
  type SealEntry,
  type SealStore,
  createSqliteSink,
  ensureInstallId,
} from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';

let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-seal-verify-cli-'));
  dbPath = join(tmpRoot, 'state.sqlite');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const writeUserYaml = (sealSection: string | null): string => {
  const path = join(tmpRoot, 'user-permissions.yaml');
  const content =
    sealSection === null
      ? 'defaults:\n  mode: strict\n'
      : `defaults:\n  mode: strict\n${sealSection}\n`;
  writeFileSync(path, content);
  return path;
};

// Returns the chain's emitted (seq, this_hash) pairs so tests can
// construct seal entries that match (or deliberately don't).
const seedChain = (installEnv: NodeJS.ProcessEnv, rowCount: number) => {
  const db = openDb(dbPath);
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: installEnv,
    now: () => 1,
    uuid: () => 'seal-verify-uuid-aaaa-bbbb',
  });
  const sink = createSqliteSink({ db, identity });
  const emitted: Array<{ seq: number; this_hash: string }> = [];
  for (let i = 0; i < rowCount; i++) {
    const row = sink.emit({
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
    emitted.push({ seq: row.seq, this_hash: row.this_hash });
  }
  db.close?.();
  return { identity, emitted };
};

// Factory that returns a store pre-loaded with the provided entries.
const makeFactory = (entries: SealEntry[]) => (): SealStore => ({
  append: () => ({ ok: true }),
  list: () => entries.slice(),
  close: () => {},
});

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

describe('runPermissionSealVerify', () => {
  test('returns 1 when policy has no seal section', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml(null);
    const io = captureOutput();
    const code = await runPermissionSealVerify({
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
    const code = await runPermissionSealVerify({
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

  test('matching seal entries → returns 0 with intact message + count', async () => {
    const env = { HOME: tmpRoot };
    const { emitted } = seedChain(env, 4);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const r1 = emitted[1];
    const r3 = emitted[3];
    if (r1 === undefined || r3 === undefined) throw new Error('setup');
    // Seal entries pointing at rows 2 and 4 with the right hashes.
    const sealEntries: SealEntry[] = [
      { seq: r1.seq, ts: 200, hash: r1.this_hash },
      { seq: r3.seq, ts: 400, hash: r3.this_hash },
    ];
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory(sealEntries),
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(io.stdout).toContain('seal file: intact');
    expect(io.stdout).toContain('2 entries cross-checked');
    // The intact path must steer the operator to also run chain-verify:
    // seal-verify proves seal-vs-stored-hash only, NOT that each stored
    // hash matches its row payload (that recompute lives in `permission
    // verify`). Without this directive a clean seal-verify is mistaken
    // for full chain integrity.
    expect(io.stdout).toContain('agent permission verify');
    expect(io.stdout).toContain('stored chain hashes only');
  });

  test('hash mismatch → returns 1 with firstMismatchAt in stdout', async () => {
    const env = { HOME: tmpRoot };
    const { emitted } = seedChain(env, 3);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const r0 = emitted[0];
    const r1 = emitted[1];
    if (r0 === undefined || r1 === undefined) throw new Error('setup');
    // First entry correct, second deliberately wrong.
    const sealEntries: SealEntry[] = [
      { seq: r0.seq, ts: 100, hash: r0.this_hash },
      { seq: r1.seq, ts: 200, hash: 'sha256:tampered000' },
    ];
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory(sealEntries),
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stdout).toContain('seal file: BROKEN');
    expect(io.stdout).toContain('first mismatch at seq: 2');
  });

  test('missing seq → returns 1 with broken message', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 2);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    // Reference seq=999 which doesn't exist in the chain.
    const sealEntries: SealEntry[] = [{ seq: 999, ts: 500, hash: 'sha256:any' }];
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory(sealEntries),
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    expect(io.stdout).toContain('seal file: BROKEN');
    expect(io.stdout).toContain('missing from approvals_log');
    expect(io.stdout).toContain('first mismatch at seq: 999');
  });

  test('empty seal file → returns 0 with note', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 3);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory([]),
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(io.stdout).toContain('0 entries cross-checked');
    expect(io.stdout).toContain('no seal entries yet');
  });

  test('corrupted seal file (list throws) → returns 1 broken', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const factory = (): SealStore => ({
      append: () => ({ ok: true }),
      list: () => {
        throw new Error('malformed seal entry at line 3');
      },
      close: () => {},
    });
    const io = captureOutput();
    const code = await runPermissionSealVerify({
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
    expect(io.stdout).toContain('seal file corrupted');
  });

  test('JSON mode emits a single NDJSON line on intact', async () => {
    const env = { HOME: tmpRoot };
    const { emitted, identity } = seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const r0 = emitted[0];
    if (r0 === undefined) throw new Error('setup');
    const sealEntries: SealEntry[] = [{ seq: r0.seq, ts: 100, hash: r0.this_hash }];
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory(sealEntries),
      json: true,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.entriesChecked).toBe(1);
    expect(parsed.install_id).toBe(identity.install_id);
    // Scope hint mirrors the human-path note: an automated gate keying
    // on `ok` must be able to discover that seal-verify proves
    // seal-vs-stored-hash ONLY, not payload integrity. `ok` stays the
    // bare seal verdict; the gap is advertised in dedicated fields.
    expect(parsed.scope).toBe('seal-vs-stored-hash');
    expect(parsed.fullIntegrityRequires).toBe('permission verify');
  });

  test('JSON mode emits structured error on broken', async () => {
    const env = { HOME: tmpRoot };
    seedChain(env, 1);
    const userPath = writeUserYaml('seal:\n  mode: worm-file\n  path: /seal.log');
    const sealEntries: SealEntry[] = [{ seq: 999, ts: 1, hash: 'sha256:nope' }];
    const io = captureOutput();
    const code = await runPermissionSealVerify({
      dbPath,
      cwd: tmpRoot,
      env,
      userPath,
      enterprisePath: null,
      sealStoreFactory: makeFactory(sealEntries),
      json: true,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(io.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.firstMismatchAt).toBe(999);
  });
});
