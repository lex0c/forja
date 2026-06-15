import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runPermissionPolicyList } from '../../src/cli/permission-policy-list.ts';
import { MIGRATIONS, migrate, openDb } from '../../src/storage/index.ts';
import { archivePolicy } from '../../src/storage/repos/policy-archive.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

describe('parseArgs — forja permission policy-list', () => {
  test('verb is recognized', () => {
    const r = parseArgs(['permission', 'policy-list']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.permission?.verb).toBe('policy-list');
      expect(r.args.permission?.positionals).toEqual([]);
    }
  });

  test('--json captured', () => {
    const r = parseArgs(['permission', 'policy-list', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.json).toBe(true);
      expect(r.args.permission?.verb).toBe('policy-list');
    }
  });

  test('positionals rejected', () => {
    const r = parseArgs(['permission', 'policy-list', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no positionals expected');
  });

  test('--reason on policy-list rejected', () => {
    const r = parseArgs(['permission', 'policy-list', '--reason', 'because']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--reason only applies');
  });
});

describe('runPermissionPolicyList', () => {
  let tmp: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-perm-policy-list-'));
    dbPath = join(tmp, 'sessions.db');
    env = { HOME: tmp };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const seed = (
    rows: ReadonlyArray<{ hash: string; bytes?: string; first?: number; last?: number }>,
  ) => {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    for (const r of rows) {
      // archivePolicy upserts on (hash); first call sets first_seen,
      // subsequent updates last_seen. To pin both values precisely in
      // a single archive call, we'd need to write raw SQL — for the
      // tests we just call archivePolicy with the desired `now`.
      archivePolicy(db, {
        policy_hash: r.hash,
        canonical_json: r.bytes ?? '{}',
        now: r.first ?? 1_000,
      });
      if (r.last !== undefined && r.last !== (r.first ?? 1_000)) {
        // Bump last_seen by re-upserting at a later ts.
        archivePolicy(db, {
          policy_hash: r.hash,
          canonical_json: r.bytes ?? '{}',
          now: r.last,
        });
      }
    }
  };

  test('empty archive: prints "empty" message + exit 0', async () => {
    const out = captured();
    const code = await runPermissionPolicyList({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('policy archive: (empty');
  });

  test('renders rows with hash + ISO timestamps + bytes + current flag', async () => {
    seed([
      { hash: 'sha256:aaaa', bytes: '{"a":1}', first: 1_000, last: 2_000 },
      { hash: 'sha256:bbbb', bytes: '{"b":2}', first: 1_500, last: 5_000 },
    ]);
    const out = captured();
    const code = await runPermissionPolicyList({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('policy archive (2 rows)');
    expect(text).toContain('sha256:aaaa');
    expect(text).toContain('sha256:bbbb');
    expect(text).toContain('bytes=7');
    // The bbbb row has the highest last_seen_ms → current.
    expect(text).toMatch(/\*\s+sha256:bbbb/);
    // aaaa is NOT current.
    expect(text).toMatch(/ {2}sha256:aaaa/);
    // ISO timestamps for both first + last.
    expect(text).toContain('first=1970-');
    expect(text).toContain('last=1970-');
  });

  test('single-row archive marks it current', async () => {
    seed([{ hash: 'sha256:only', bytes: '{"x":1}', first: 100, last: 100 }]);
    const out = captured();
    await runPermissionPolicyList({
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('policy archive (1 row)');
    expect(text).toMatch(/\*\s+sha256:only/);
  });

  test('--json: NDJSON one row per archive entry with full hash', async () => {
    seed([
      { hash: 'sha256:0001', bytes: '{"a":1}', first: 100 },
      { hash: 'sha256:0002', bytes: '{"b":2}', first: 200 },
    ]);
    const out = captured();
    const code = await runPermissionPolicyList({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const lines = out.lines.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    const rows = lines.map((l) => JSON.parse(l));
    // listPolicyArchive orders by first_seen_ms ASC.
    expect(rows[0].policy_hash).toBe('sha256:0001');
    expect(rows[1].policy_hash).toBe('sha256:0002');
    // current flag: 0002 has highest last_seen_ms (= first_seen_ms = 200).
    expect(rows[0].current).toBe(false);
    expect(rows[1].current).toBe(true);
    expect(rows[0].bytes).toBe('{"a":1}'.length);
  });

  test('--json: empty archive emits zero lines on stdout', async () => {
    const out = captured();
    const code = await runPermissionPolicyList({
      json: true,
      dbPath,
      env,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toBe('');
  });
});
