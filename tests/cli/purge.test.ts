// `agent purge` handler tests. Pin the operator-facing contracts:
//   - Init-marker gate: refuses purge when .agent/ has none of the
//     four canonical artifacts; accepts when any one is present.
//   - Symlink defense: refuses when .agent/ is a symlink, never
//     follows symlink entries beneath it.
//   - Dry-run vs --force separation: dry-run never mutates FS or DB.
//   - Force happy path: audit row written BEFORE FS removal, then
//     entire .agent/ tree gone.
//   - --no-audit escape hatch: --force succeeds even with DB
//     unwriteable; without it, --force aborts.
//   - JSON shape for both modes.
//
// We isolate XDG_CONFIG_HOME + HOME so `ensureInstallId` writes to
// the test's temp workdir instead of the developer's real
// ~/.config/agent/install_id.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STEPS, type InitStep } from '../../src/cli/init.ts';
import { INIT_MARKERS, runPurge, verifySamePostReaddir } from '../../src/cli/purge.ts';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listPurgeEventsByCwd } from '../../src/storage/repos/purge-events.ts';

let cwd: string;
let xdgHome: string;
let dbPath: string;
let outBuf: string[];
let errBuf: string[];
let originalXdg: string | undefined;
let originalHome: string | undefined;
const out = (s: string) => outBuf.push(s);
const err = (s: string) => errBuf.push(s);

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'forja-purge-'));
  xdgHome = mkdtempSync(join(tmpdir(), 'forja-purge-xdg-'));
  dbPath = join(xdgHome, 'test-sessions.db');
  outBuf = [];
  errBuf = [];
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = xdgHome;
  process.env.HOME = xdgHome;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(xdgHome, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

const writeFile = (rel: string, content: string): void => {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

// Materialize a minimally-initialized .agent/ — just permissions.yaml
// so the init-marker gate passes. Tests that need richer fixtures add
// their own files on top.
const seedMinimal = (): void => {
  writeFile('.agent/permissions.yaml', '# scaffolded\n');
};

describe('runPurge — init-marker gate', () => {
  test('refuses when .agent/ does not exist', async () => {
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('does not exist');
  });

  test('refuses when .agent/ exists but has no init markers', async () => {
    // Operator-planted .agent/ with content that doesn't match any
    // of the four canonical artifacts.
    writeFile('.agent/random.txt', 'not from init\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(1);
    const stderr = errBuf.join('');
    expect(stderr).toContain('no init markers');
    // Lists the four markers it looked for so the operator can
    // diagnose without grepping source.
    for (const m of INIT_MARKERS) {
      expect(stderr).toContain(m);
    }
  });

  // INIT_MARKERS enumerated explicitly (not `test.each`) — bun:test's
  // each typing rejects readonly string tuples in the current
  // toolchain, and naming each marker per-case keeps the test report
  // readable when one regresses.
  test('accepts when permissions.yaml is the only marker present', async () => {
    writeFile('.agent/permissions.yaml', '# fixture\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
  });

  test('accepts when .gitignore is the only marker present', async () => {
    writeFile('.agent/.gitignore', '# fixture\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
  });

  test('accepts when config.toml is the only marker present', async () => {
    writeFile('.agent/config.toml', '# fixture\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
  });

  test('accepts when agents/ is the only marker present', async () => {
    mkdirSync(join(cwd, '.agent', 'agents'), { recursive: true });
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
  });
});

describe('runPurge — symlink defense', () => {
  test('refuses when .agent/ itself is a symlink', async () => {
    // Create a real target dir somewhere outside .agent, then symlink.
    const realTarget = mkdtempSync(join(tmpdir(), 'forja-purge-target-'));
    try {
      symlinkSync(realTarget, join(cwd, '.agent'));
      const code = await runPurge({
        cwd,
        force: false,
        json: false,
        noAudit: false,
        out,
        err,
        dbPath,
      });
      expect(code).toBe(1);
      expect(errBuf.join('')).toContain('is a symlink');
      // The target outside .agent/ MUST remain intact.
      expect(existsSync(realTarget)).toBe(true);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
    }
  });

  test('--force unlinks symlink entries inside .agent/ without following them', async () => {
    seedMinimal();
    // External target the symlink points to — must survive.
    const external = mkdtempSync(join(tmpdir(), 'forja-purge-ext-'));
    const sentinel = join(external, 'sentinel.txt');
    writeFileSync(sentinel, 'must survive\n');
    try {
      symlinkSync(external, join(cwd, '.agent', 'leaked-link'));
      const code = await runPurge({
        cwd,
        force: true,
        json: false,
        noAudit: false,
        out,
        err,
        dbPath,
      });
      expect(code).toBe(0);
      // .agent/ is gone (with the symlink entry).
      expect(existsSync(join(cwd, '.agent'))).toBe(false);
      // External target is preserved.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe('runPurge — dry-run output', () => {
  test('does not mutate FS or DB in dry-run', async () => {
    seedMinimal();
    writeFile('.agent/config.toml', '# config\n');
    writeFile('.agent/memory/local/foo.md', '---\nname: foo\n---\nbody');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    // FS unchanged.
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'memory', 'local', 'foo.md'))).toBe(true);
    // DB not even created (dry-run probes but never inserts).
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      migrate(db);
      expect(listPurgeEventsByCwd(db, cwd)).toEqual([]);
      db.close();
    }
  });

  test('dry-run does NOT create the DB file (load-bearing — see bug report)', async () => {
    // Pre-fix-commit bug: probeAuditWritability called migrate(db)
    // unconditionally, which made openDb create the sessions.db
    // file even on dry-run. That violated the "DRY RUN (nothing
    // will be modified)" contract — operator inspecting purge
    // scope ended up with a fresh global DB they didn't ask for.
    // Pin the fix: dry-run uses probeAuditWritabilityNonMutating
    // which only checks FS access, never opens.
    seedMinimal();
    // dbPath points at a path that doesn't exist yet.
    expect(existsSync(dbPath)).toBe(false);
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    // The load-bearing assertion: NO DB file was created.
    expect(existsSync(dbPath)).toBe(false);
  });

  test('dry-run does NOT apply migrations to a pre-existing DB', async () => {
    // Companion to the prior test: when the DB already exists but
    // is partially migrated (or in some other intermediate state),
    // dry-run must NOT trigger migrate() — that would mutate the
    // schema before --force.
    seedMinimal();
    // Create a minimal DB file via raw SQLite — NO migrations applied.
    const db = openDb(dbPath);
    // Confirm empty schema (no _migrations table).
    const before = db
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_migrations'")
      .get() as { n: number };
    expect(before.n).toBe(0);
    db.close();

    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);

    // After dry-run, schema STILL untouched — no _migrations table,
    // no purge_events table, no anything.
    const dbAfter = openDb(dbPath);
    const after = dbAfter
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_migrations'")
      .get() as { n: number };
    expect(after.n).toBe(0);
    dbAfter.close();
  });

  test('human output lists scope, categories, totals, preserved, command', async () => {
    seedMinimal();
    writeFile('.agent/agents/foo.md', '---\nname: foo\n---\nbody');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const stdout = outBuf.join('');
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain(join(cwd, '.agent'));
    expect(stdout).toContain('permissions.yaml');
    expect(stdout).toContain('agents/');
    expect(stdout).toContain('Total:');
    expect(stdout).toContain('Preserved');
    expect(stdout).toContain('agent purge --force');
  });

  test('flags .gitignore as operator-owned with confirmation hint', async () => {
    seedMinimal();
    writeFile('.agent/.gitignore', 'sessions.db\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    expect(outBuf.join('')).toContain('operator-owned');
  });

  test('JSON dry-run shape includes scope, categories, totals, audit, command', async () => {
    seedMinimal();
    writeFile('.agent/config.toml', '# config\n');
    const code = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const line = outBuf.join('').trim();
    const parsed = JSON.parse(line) as {
      mode: string;
      repoRoot: string;
      scope: string;
      categories: Array<{ name: string; kind: string; files: number; bytes: number }>;
      totals: { files: number; dirs: number; bytes: number };
      preserved: string[];
      audit: { writable: boolean; dbPath: string };
      command: string;
    };
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.scope).toBe(join(cwd, '.agent'));
    expect(parsed.categories.length).toBeGreaterThanOrEqual(2);
    expect(parsed.totals.files).toBeGreaterThanOrEqual(2);
    expect(parsed.audit.writable).toBe(true);
    expect(parsed.audit.dbPath).toBe(dbPath);
    expect(parsed.command).toBe('agent purge --force');
  });

  test('handles empty .agent/ with init marker only', async () => {
    // Edge: .gitignore is the only init marker and is itself an
    // empty file. Walker reports 1 file, 0 dirs.
    writeFile('.agent/.gitignore', '');
    const code = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      totals: { files: number; dirs: number; bytes: number };
    };
    expect(parsed.totals.files).toBe(1);
    expect(parsed.totals.bytes).toBe(0);
  });
});

describe('runPurge — --force happy path', () => {
  test('removes .agent/ tree and writes audit row', async () => {
    seedMinimal();
    writeFile('.agent/config.toml', '# config\n');
    writeFile('.agent/agents/a.md', 'A');
    writeFile('.agent/agents/b.md', 'B');
    writeFile('.agent/memory/local/m.md', 'mem');
    writeFile('.agent/bg/log.txt', 'log');

    const now = () => 1_700_000_000_000;
    const code = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
      now,
    });
    expect(code).toBe(0);

    // .agent/ tree gone entirely.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);

    // Audit row landed with the expected counts.
    const db = openDb(dbPath);
    migrate(db);
    const rows = listPurgeEventsByCwd(db, cwd);
    expect(rows.length).toBe(1);
    expect(rows[0]?.ts).toBe(1_700_000_000_000);
    expect(rows[0]?.cwd).toBe(cwd);
    // 5 files + 1 marker = 6 entries; counts mirror the walker.
    expect(rows[0]?.files_present).toBeGreaterThanOrEqual(5);
    expect(rows[0]?.dirs_present ?? 0).toBeGreaterThanOrEqual(3); // .agent itself + memory/local + bg + agents
    // artifacts_present_json round-trips as a sorted string[].
    const arr = JSON.parse(rows[0]?.artifacts_present_json ?? '[]') as string[];
    expect(arr.length).toBeGreaterThan(0);
    const sorted = [...arr].sort();
    expect(arr).toEqual(sorted);
    db.close();
  });

  test('JSON force-mode output exposes auditId and removed totals', async () => {
    seedMinimal();
    writeFile('.agent/config.toml', '# c\n');
    const code = await runPurge({
      cwd,
      force: true,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      mode: string;
      removed: { files: number; dirs: number; bytes: number };
      auditId: number | null;
      auditWritable: boolean;
    };
    expect(parsed.mode).toBe('force');
    expect(parsed.removed.files).toBeGreaterThanOrEqual(2);
    expect(parsed.auditWritable).toBe(true);
    expect(parsed.auditId).toBeGreaterThan(0);
  });

  test('re-init after purge works (purge leaves no booby traps)', async () => {
    seedMinimal();
    const code1 = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code1).toBe(0);
    expect(existsSync(join(cwd, '.agent'))).toBe(false);

    // Operator re-runs `agent init` (simulated: just re-seed). The
    // directory recreates idempotently; a SECOND purge then works
    // exactly like the first.
    seedMinimal();
    outBuf = [];
    errBuf = [];
    const code2 = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code2).toBe(0);

    // Both purges recorded in the audit log under the same cwd.
    const db = openDb(dbPath);
    migrate(db);
    const rows = listPurgeEventsByCwd(db, cwd);
    expect(rows.length).toBe(2);
    db.close();
  });
});

describe('runPurge — --no-audit escape hatch', () => {
  test('--force aborts when DB is unwriteable and --no-audit is not passed', async () => {
    seedMinimal();
    // Point dbPath at a directory that doesn't exist AND can't be
    // created — passing a path whose parent is itself a regular file
    // makes openDb throw at the syscall boundary.
    const blockerPath = join(xdgHome, 'blocker');
    writeFileSync(blockerPath, 'not-a-dir');
    const impossibleDb = join(blockerPath, 'sub', 'db.sqlite');
    const code = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath: impossibleDb,
    });
    expect(code).toBe(1);
    // FS NOT touched — the audit gate fired before removal.
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(true);
    expect(errBuf.join('')).toContain('cannot write audit row');
  });

  test('--force --no-audit proceeds even when DB is unwriteable', async () => {
    seedMinimal();
    const blockerPath = join(xdgHome, 'blocker');
    writeFileSync(blockerPath, 'not-a-dir');
    const impossibleDb = join(blockerPath, 'sub', 'db.sqlite');
    const code = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: true,
      out,
      err,
      dbPath: impossibleDb,
    });
    expect(code).toBe(0);
    // FS removal happened despite no audit row.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    // stderr explains the bypass (uniform message — probe was
    // skipped, so we don't even know whether the DB is broken).
    expect(errBuf.join('')).toContain('audit row skipped (DB not probed)');
  });

  test('--force --no-audit on a HEALTHY DB skips both probe and audit row', async () => {
    // Two operator-reported bugs converge here:
    //   1. Pre-first-fix: --no-audit was only honored as an error
    //      bypass — writable DB still wrote a row.
    //   2. Pre-second-fix: even after gating the WRITE behind
    //      --no-audit, the PROBE (openDb + migrate) still ran
    //      first, so the DB got created/migrated on fresh installs
    //      despite "opt out of audit logging" intent.
    // Combined fix: --no-audit skips BOTH the probe AND the row
    // write. No DB side effects at all.
    seedMinimal();
    const code = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: true,
      out,
      err,
      dbPath, // healthy, writable path
    });
    expect(code).toBe(0);
    // FS removal happened.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    // stderr confirms opt-out — single uniform message regardless
    // of DB state (operator who passed --no-audit knows the DB
    // wasn't even queried).
    expect(errBuf.join('')).toContain('audit row skipped (DB not probed)');
    // The load-bearing assertion: NO purge_events row landed.
    // (Open + migrate the DB here, in the TEST, to inspect — the
    // production code path never opened it.)
    const db = openDb(dbPath);
    migrate(db);
    expect(listPurgeEventsByCwd(db, cwd)).toEqual([]);
    db.close();
  });

  test('--force --no-audit JSON output reflects no audit row and skipped probe', async () => {
    seedMinimal();
    const code = await runPurge({
      cwd,
      force: true,
      json: true,
      noAudit: true,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      mode: string;
      auditId: number | null;
      auditWritable: boolean;
    };
    expect(parsed.mode).toBe('force');
    // Both fields signal opt-out:
    //   auditId: null   — no row written
    //   auditWritable: false — probe skipped (NOT "DB broken")
    // Operator scripting distinguishes opt-out from DB-broken via
    // the audit.reason field (`'skipped (--no-audit; DB not probed)'`
    // for opt-out vs ENOENT/EACCES for real failures).
    expect(parsed.auditId).toBeNull();
    expect(parsed.auditWritable).toBe(false);
  });

  test('--force --no-audit on a FRESH install does not create sessions.db', async () => {
    // Load-bearing: combines --force + --no-audit + non-existent DB.
    // Pre-fix the mutating probe ran before the noAudit gate,
    // creating the file. Post-fix: probe is gated, DB never touched.
    seedMinimal();
    const freshDb = join(xdgHome, 'never-existed.db');
    expect(existsSync(freshDb)).toBe(false);
    const code = await runPurge({
      cwd,
      force: true,
      json: false,
      noAudit: true,
      out,
      err,
      dbPath: freshDb,
    });
    expect(code).toBe(0);
    // FS purge happened.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    // DB and sidecars NOT created.
    expect(existsSync(freshDb)).toBe(false);
    expect(existsSync(`${freshDb}-shm`)).toBe(false);
    expect(existsSync(`${freshDb}-wal`)).toBe(false);
  });
});

describe('runPurge — repoRoot resolution', () => {
  test('purge from <repo>/src/ targets <repo>/.agent/, not <repo>/src/.agent/', async () => {
    // git init at cwd so resolveRepoRoot can walk back from subdir.
    // Without git, resolveRepoRoot falls back to the passed-in cwd
    // and this test wouldn't exercise the resolution at all.
    const gitInit = Bun.spawnSync({
      cmd: ['git', 'init', '-q', cwd],
      env: process.env,
    });
    if (gitInit.exitCode !== 0) {
      // No git binary or sandboxed CI — skip rather than mis-pass.
      console.warn('skipping subdir-resolve test: git init returned', gitInit.exitCode);
      return;
    }
    seedMinimal();
    const subdir = join(cwd, 'src');
    mkdirSync(subdir, { recursive: true });

    const code = await runPurge({
      cwd: subdir, // <-- invocation cwd is the subdir
      force: true,
      json: false,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    // The .agent/ at the REPO ROOT (not at subdir) is gone.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    // subdir itself is intact (we didn't sweep into it).
    expect(existsSync(subdir)).toBe(true);

    // Audit row's `cwd` is the resolved repoRoot, not the subdir.
    const db = openDb(dbPath);
    migrate(db);
    const rows = listPurgeEventsByCwd(db, cwd);
    expect(rows.length).toBe(1);
    // And there's NO row under the subdir path.
    expect(listPurgeEventsByCwd(db, subdir).length).toBe(0);
    db.close();
  });
});

describe('runPurge — walker / removeTree parity', () => {
  test('dry-run totals match force-mode removed (files+bytes; dirs differs by 1 root)', async () => {
    // Deterministic fixture: known file/dir counts so the diff
    // between walker (no root) and remove (with root) is provable.
    // seedMinimal writes 13 bytes (`# scaffolded\n`) to
    // permissions.yaml — included in the byte total below.
    seedMinimal(); // permissions.yaml (13 bytes)
    writeFile('.agent/config.toml', 'X'); // 1 byte
    writeFile('.agent/agents/a.md', 'AA'); // 2 bytes
    writeFile('.agent/memory/local/m.md', 'MMM'); // 3 bytes
    // Expected pre-purge: 4 files, 19 bytes, 3 subdirs (agents/,
    // memory/, memory/local/) — root .agent/ NOT in walker totals.

    // Step 1: dry-run --json to capture walk.totals.
    const code1 = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code1).toBe(0);
    const dryParsed = JSON.parse(outBuf.join('').trim()) as {
      totals: { files: number; dirs: number; bytes: number };
    };
    expect(dryParsed.totals.files).toBe(4);
    expect(dryParsed.totals.bytes).toBe(19);
    expect(dryParsed.totals.dirs).toBe(3);

    // Step 2: --force --json to capture removeTree's actual counts.
    outBuf = [];
    errBuf = [];
    const code2 = await runPurge({
      cwd,
      force: true,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code2).toBe(0);
    const forceParsed = JSON.parse(outBuf.join('').trim()) as {
      removed: { files: number; dirs: number; bytes: number };
    };

    // Parity invariants — these are the contract:
    expect(forceParsed.removed.files).toBe(dryParsed.totals.files);
    expect(forceParsed.removed.bytes).toBe(dryParsed.totals.bytes);
    // removeTree counts the .agent/ root itself; walker does not.
    // The +1 is the documented divergence.
    expect(forceParsed.removed.dirs).toBe(dryParsed.totals.dirs + 1);
  });
});

describe('drift-guard — INIT_MARKERS ↔ init.DEFAULT_STEPS', () => {
  // The purge gate uses INIT_MARKERS to decide "was this project
  // initialized by Forja?". If init.ts adds a 5th scaffold step, the
  // purge gate must learn about its artifact too — otherwise an
  // operator who ran init AFTER the new step landed gets a project
  // that init can scaffold but purge refuses to recognize. This test
  // pairs the two so the failure surfaces in CI, not in operator
  // surprise.
  // Typed against the readonly INIT_MARKERS tuple so the Record's
  // VALUE union is exactly the four literal filenames purge knows.
  // A wider `string` here would let a typo ('permission.yaml')
  // pass the type check and only fail at runtime — defeats the
  // drift-guard intent.
  const STEP_TO_MARKER: Record<InitStep, (typeof INIT_MARKERS)[number]> = {
    permissions: 'permissions.yaml',
    gitignore: '.gitignore',
    config: 'config.toml',
    playbooks: 'agents',
  };

  test('every init step has a marker recognized by purge', () => {
    for (const step of DEFAULT_STEPS) {
      const marker = STEP_TO_MARKER[step];
      expect(INIT_MARKERS).toContain(marker);
    }
  });

  test('every purge marker maps to an init step (no orphan markers)', () => {
    const knownMarkers = new Set<string>(Object.values(STEP_TO_MARKER));
    for (const m of INIT_MARKERS) {
      expect(knownMarkers.has(m)).toBe(true);
    }
  });

  test('STEP_TO_MARKER covers every InitStep enum value', () => {
    // Defense against init.ts adding a new InitStep variant without
    // updating this map — TS already enforces the Record key set, but
    // a runtime check makes the failure mode explicit on test run.
    for (const step of DEFAULT_STEPS) {
      expect(STEP_TO_MARKER[step]).toBeDefined();
    }
  });
});

describe('verifySamePostReaddir — TOCTOU race detector', () => {
  // Operator-reported security bug: between lstat (confirming a
  // path is a real directory) and readdirSync (which follows
  // symlinks), an adversary can swap the directory for a symlink
  // to an external path. Without the post-readdir re-check, the
  // walker would recurse into and delete files outside .agent/.
  //
  // These pins exercise the detector directly (without simulating
  // the racy scheduling, which would be flaky). We CONSTRUCT the
  // race-outcome state — i.e., a path whose post-stat differs from
  // the pre-stat — and verify the function reports the mismatch.

  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'forja-purge-toctou-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test('returns true when path is the same real directory across calls', () => {
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const preStat = lstatSync(realDir);
    expect(verifySamePostReaddir(realDir, preStat)).toBe(true);
  });

  test('returns false when directory was replaced by a symlink (adversary swap)', () => {
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const preStat = lstatSync(realDir);
    // Simulate the post-race state: dir is now a symlink to /tmp.
    rmSync(realDir, { recursive: true, force: true });
    symlinkSync('/tmp', realDir);
    expect(verifySamePostReaddir(realDir, preStat)).toBe(false);
  });

  test('returns false when path was replaced by a different directory (inode change)', () => {
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const preStat = lstatSync(realDir);
    // Recreate at same path with a different inode.
    rmSync(realDir, { recursive: true, force: true });
    mkdirSync(realDir);
    const postStat = lstatSync(realDir);
    // Sanity: inodes must differ for the test to be meaningful.
    expect(postStat.ino).not.toBe(preStat.ino);
    expect(verifySamePostReaddir(realDir, preStat)).toBe(false);
  });

  test('returns false when path vanished entirely', () => {
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const preStat = lstatSync(realDir);
    rmSync(realDir, { recursive: true, force: true });
    expect(verifySamePostReaddir(realDir, preStat)).toBe(false);
  });

  test('returns false when path was replaced by a regular file', () => {
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const preStat = lstatSync(realDir);
    rmSync(realDir, { recursive: true, force: true });
    writeFileSync(realDir, 'now a file');
    expect(verifySamePostReaddir(realDir, preStat)).toBe(false);
  });

  test('returns false when dev differs (cross-device swap with same ino)', () => {
    // Operator-reported security follow-up: inode numbers are only
    // unique per filesystem. An adversary mounting a crafted FS at
    // the path with a directory whose ino collides with the
    // original would pass an ino-only check. The dev+ino pair is
    // the kernel-level unique identifier across all mounts.
    //
    // Real cross-device mount isn't feasible in a unit test (needs
    // root + loop device). Instead, forge a preStat with the same
    // ino as the real one but a different `dev`. The verifier's
    // post-stat (real lstat) returns the actual dev; if the
    // verifier only compared `ino`, this would return true.
    const realDir = join(workdir, 'real');
    mkdirSync(realDir);
    const realStat = lstatSync(realDir);
    // Construct a Stats-like with same ino but different dev.
    // Spread loses prototype methods, so re-attach the ones
    // verifySamePostReaddir doesn't actually consult on the
    // PRE-stat (it only reads .ino + .dev fields). Type cast.
    const forgedPreStat = {
      ...realStat,
      dev: realStat.dev + 1, // different device
    } as Stats;
    expect(forgedPreStat.ino).toBe(realStat.ino);
    expect(forgedPreStat.dev).not.toBe(realStat.dev);
    expect(verifySamePostReaddir(realDir, forgedPreStat)).toBe(false);
  });
});

describe('runPurge — dry-run suggestion preserves --no-audit', () => {
  // Operator-safety bug: dry-run with --no-audit suggested a bare
  // `agent purge --force` command. Copy-pasting in the emergency
  // case (DB broken — the exact reason --no-audit exists) would
  // hit the audit gate and abort, blocking the recovery workflow.
  // Fix: suggested command echoes --no-audit when set.

  test('no --no-audit → "agent purge --force" (baseline)', async () => {
    seedMinimal();
    const code = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: false,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command: string };
    expect(parsed.command).toBe('agent purge --force');
  });

  test('--no-audit set → suggestion preserves the flag', async () => {
    seedMinimal();
    const code = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: true,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command: string };
    expect(parsed.command).toBe('agent purge --force --no-audit');
  });

  test('human output echoes --no-audit suggestion', async () => {
    seedMinimal();
    const code = await runPurge({
      cwd,
      force: false,
      json: false,
      noAudit: true,
      out,
      err,
      dbPath,
    });
    expect(code).toBe(0);
    const stdout = outBuf.join('');
    expect(stdout).toContain('agent purge --force --no-audit');
    // Negative polarity: bare suggestion must NOT appear (would
    // indicate the flag was dropped — exact regression target).
    expect(stdout).not.toMatch(/agent purge --force\n/);
  });

  test('--no-audit + unwritable DB → suggestion still executable', async () => {
    // The motivating scenario: operator sees DB is broken, runs
    // dry-run with --no-audit to inspect what would be purged,
    // copy-pastes the suggested command. It MUST work.
    seedMinimal();
    const blockerPath = join(xdgHome, 'blocker');
    writeFileSync(blockerPath, 'not-a-dir');
    const impossibleDb = join(blockerPath, 'sub', 'db.sqlite');
    const code = await runPurge({
      cwd,
      force: false,
      json: true,
      noAudit: true,
      out,
      err,
      dbPath: impossibleDb,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command: string };
    // The suggestion includes --no-audit even when probe was
    // skipped — operator who copy-pastes this gets the correct
    // emergency-recovery command.
    expect(parsed.command).toBe('agent purge --force --no-audit');
  });
});
