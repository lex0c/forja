// `agent gc` CLI handler tests. The orchestrator is already pinned
// by tests/audit/gc.test.ts — this file covers the CLI seam:
// rendering, JSON shape, table filter forwarding, exit codes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGcCli } from '../../src/cli/gc.ts';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createPin } from '../../src/storage/repos/context-pins.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let cwd: string;
let xdgHome: string;
let dbPath: string;
let outBuf: string[];
let errBuf: string[];
let originalXdg: string | undefined;
let originalHome: string | undefined;
const out = (s: string) => outBuf.push(s);
const err = (s: string) => errBuf.push(s);

const DAY_MS = 24 * 60 * 60 * 1000;
// Phase 2 added retention windows up to 365d (memory_events,
// failure_events, eviction_events). NOW must exceed the largest
// default so the cutoff (NOW - days * DAY_MS) stays positive —
// prune helpers reject non-positive cutoffs as a guard against
// nonsense config. Production passes Date.now() (~50 years in ms),
// so this is purely a test-fixture concern.
const NOW = 1000 * DAY_MS;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'forja-gc-cli-'));
  xdgHome = mkdtempSync(join(tmpdir(), 'forja-gc-cli-xdg-'));
  dbPath = join(xdgHome, 'sessions.db');
  outBuf = [];
  errBuf = [];
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = xdgHome;
  process.env.HOME = xdgHome;

  // Seed DB with one old + one fresh pin so the runs have
  // something to report on. The other Phase 1 tables stay empty;
  // the handler must still produce a complete report.
  const db = openDb(dbPath);
  migrate(db);
  const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  createPin(db, {
    sessionId,
    kind: 'invariant',
    text: 'old',
    createdBy: 'user',
    createdAt: NOW - 200 * DAY_MS,
  });
  createPin(db, {
    sessionId,
    kind: 'invariant',
    text: 'fresh',
    createdBy: 'user',
    createdAt: NOW - 1000,
  });
  db.close();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(xdgHome, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('runGcCli — dry-run', () => {
  test('human render lists all Phase 1 tables + execute hint', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const stdout = outBuf.join('');
    expect(stdout).toContain('DRY RUN');
    for (const t of ['recap_cache', 'retrieval_trace', 'context_pins', 'bg_processes']) {
      expect(stdout).toContain(t);
    }
    expect(stdout).toContain('agent gc --force');
  });

  test('JSON dry-run shape exposes mode, config, tables, command', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      mode: string;
      nowMs: number;
      config: { context_pins_days: number };
      tables: Array<{ table: string; beforeCount: number; deletedCount: number }>;
      command?: string;
    };
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.nowMs).toBe(NOW);
    expect(parsed.config.context_pins_days).toBe(90); // default
    // Phase 1 + Phase 2 + Phase 3 = 11 tables (outcome_signals enabled by default).
    expect(parsed.tables.length).toBe(11);
    expect(parsed.command).toBe('agent gc --force');
    // The "old" pin (200d back) is way past 90d default → 1 would-delete.
    const pinTable = parsed.tables.find((t) => t.table === 'context_pins');
    expect(pinTable?.beforeCount).toBe(2);
    expect(pinTable?.deletedCount).toBe(1);
  });

  test('--table filter restricts to one table', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: ['context_pins'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      tables: Array<{ table: string }>;
    };
    expect(parsed.tables.length).toBe(1);
    expect(parsed.tables[0]?.table).toBe('context_pins');
  });
});

describe('runGcCli — --force', () => {
  test('deletes old rows; JSON output has no command field', async () => {
    const code = await runGcCli({
      cwd,
      force: true,
      json: true,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      mode: string;
      command?: string;
      tables: Array<{ table: string; deletedCount: number }>;
    };
    expect(parsed.mode).toBe('force');
    expect(parsed.command).toBeUndefined();
    const pinTable = parsed.tables.find((t) => t.table === 'context_pins');
    expect(pinTable?.deletedCount).toBe(1);

    // Verify FS state: the "old" pin gone, "fresh" remains.
    const db = openDb(dbPath);
    migrate(db);
    const remaining = db.query('SELECT COUNT(*) AS n FROM context_pins').get() as { n: number };
    expect(remaining.n).toBe(1);
    db.close();
  });

  test('human render shows deleted counts + remaining counts', async () => {
    const code = await runGcCli({
      cwd,
      force: true,
      json: false,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const stdout = outBuf.join('');
    expect(stdout).toContain('forja gc — done');
    expect(stdout).toContain('deleted');
    expect(stdout).toContain('remaining');
  });
});

describe('runGcCli — config provenance', () => {
  test('project config overrides default', async () => {
    // Write a project config that drops the retention window to 1d
    // so the "old" pin (200d back) AND the "fresh" pin (1s back?)
    // both stay below cutoff — no, fresh is 1s old, way under 1d.
    // So with 1d retention: old → deleted, fresh → kept. Same as
    // default 90d, but proves config is picked up.
    const projectConfigDir = join(cwd, '.agent');
    const projectConfigPath = join(projectConfigDir, 'config.toml');
    require('node:fs').mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(projectConfigPath, '[audit.retention]\ncontext_pins = 1\n');

    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: ['context_pins'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      config: { context_pins_days: number };
      configSources: { project: string | null };
    };
    expect(parsed.config.context_pins_days).toBe(1);
    expect(parsed.configSources.project).toContain('.agent/config.toml');
  });

  test('warnings surface on stderr', async () => {
    const projectConfigDir = join(cwd, '.agent');
    const projectConfigPath = join(projectConfigDir, 'config.toml');
    require('node:fs').mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(projectConfigPath, '[audit.retention]\nretreival_trace = 7\n');

    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(errBuf.join('')).toContain('retreival_trace');
    expect(errBuf.join('')).toContain('not a known retention key');
  });
});

describe('runGcCli — DB inaccessible', () => {
  test('dry-run on missing DB file: exit 0 + fresh-install message', async () => {
    // File absent is a legitimate "no rows to sweep yet" case
    // (operator just installed Forja, no session created the DB).
    // Downgrade to empty report + helpful pointer to force command.
    const missing = join(xdgHome, 'never-existed.db');
    expect(existsSync(missing)).toBe(false);
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: [],
      out,
      err,
      dbPath: missing,
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(errBuf.join('')).toContain('fresh install');
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      mode: string;
      tables: unknown[];
      errors: unknown[];
    };
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.tables).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  test('dry-run on EXISTING but unopenable DB: exit 1 + surface error', async () => {
    // Operator-reported bug: pre-fix, ALL open failures (including
    // corrupted file, perm denied, integrity_check refusal) were
    // treated as fresh-install and silently downgraded to exit 0.
    // That masked real operational failures for scripts/cron jobs.
    // Post-fix: file present but unopenable → exit 1 + stderr error.
    const corruptDb = join(xdgHome, 'corrupt.db');
    // Write garbage that isn't a valid SQLite file — SQLite will
    // refuse to open with "file is not a database" or similar.
    writeFileSync(corruptDb, 'NOT A SQLITE DATABASE - corrupt content');
    expect(existsSync(corruptDb)).toBe(true);
    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: [],
      out,
      err,
      dbPath: corruptDb,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('exists but cannot be opened');
    // No empty report on stdout — we DON'T know the row counts,
    // pretending we do would mask the failure.
    expect(outBuf.join('')).toBe('');
  });

  test('dry-run on ENOTDIR parent (path-resolution error) exits 1, NOT fresh-install', async () => {
    // Operator-reported follow-up: pre-fix used existsSync which
    // returns false for ENOENT, EACCES, ENOTDIR, ELOOP equally.
    // A blocker scenario (parent is a regular file, not a dir)
    // would lstatSync the path and get ENOTDIR — but existsSync
    // collapsed that to "file absent → fresh install", silently
    // masking a real path-resolution failure from automation.
    // Post-fix: lstatSync surfaces err.code; only ENOENT means
    // "truly absent". ENOTDIR (and EACCES, ELOOP, etc.) → exit 1.
    const blocker = join(xdgHome, 'blocker');
    writeFileSync(blocker, 'not-a-dir');
    const ENOTDIRPath = join(blocker, 'sub', 'db.sqlite');
    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: [],
      out,
      err,
      dbPath: ENOTDIRPath,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('cannot inspect DB path');
    // stdout empty — no empty-report fabrication that would hide
    // the failure from cron / CI.
    expect(outBuf.join('')).toBe('');
  });

  test('--force still exit 1 when DB cannot be opened (write path)', async () => {
    // Force mode must surface real errors — operator opted in to
    // mutation, so a broken DB is a stop-the-world failure, not
    // hygiene drift.
    const blocker = join(xdgHome, 'blocker');
    writeFileSync(blocker, 'not-a-dir');
    const impossibleDb = join(blocker, 'sub', 'db.sqlite');
    const code = await runGcCli({
      cwd,
      force: true,
      json: false,
      tables: [],
      out,
      err,
      dbPath: impossibleDb,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('cannot open DB');
  });
});

describe('runGcCli — dry-run no-mutation invariant', () => {
  test('dry-run does NOT create DB file or sidecars on a fresh path', async () => {
    // Operator-reported bug: openDb without readonly creates the
    // sessions.db file + -shm + -wal sidecars + applies WAL/
    // busy_timeout PRAGMAs + chmod 0600. That ran in dry-run
    // pre-fix, silently mutating operator state despite the
    // "DRY RUN" header. Fix uses openDb({readonly: true}) which
    // refuses to create the file.
    const freshDb = join(xdgHome, 'never-existed.db');
    expect(existsSync(freshDb)).toBe(false);
    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: [],
      out,
      err,
      dbPath: freshDb,
      now: () => NOW,
    });
    expect(code).toBe(0);
    // Load-bearing assertion: NO DB file created.
    expect(existsSync(freshDb)).toBe(false);
    // Sidecar files (WAL journal mode) also not created — those
    // only land if the file is opened RW.
    expect(existsSync(`${freshDb}-shm`)).toBe(false);
    expect(existsSync(`${freshDb}-wal`)).toBe(false);
  });

  test('dry-run on existing DB does NOT add sidecars or migrate', async () => {
    // Pre-existing DB without WAL sidecars; dry-run should not
    // create them (WAL pragma is RW-only) nor apply migrations.
    // The DB has no schema (just an empty file from openDb seed),
    // so per-table COUNT queries will fail and exit code = 2.
    // That's expected and orthogonal to the load-bearing
    // assertion: dry-run MUST NOT mutate the DB schema.
    const existingDb = join(xdgHome, 'existing.db');
    // Create a minimal empty DB (raw open + close — applies the
    // RW path's PRAGMAs which create -shm/-wal sidecars on first
    // write). Then close.
    const seed = openDb(existingDb);
    seed.close();
    // The seed openDb above sets WAL mode (persisted in DB
    // header), so subsequent opens — even readonly — may touch
    // sidecars. That's a SQLite-level behavior, not a gc-handler
    // mutation. The load-bearing assertion here is SCHEMA
    // INTEGRITY (no migrate ran), not file-system file inventory
    // (covered by the prior `fresh path` test where there's no
    // persisted WAL state to inherit).

    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: [],
      out,
      err,
      dbPath: existingDb,
      now: () => NOW,
    });
    // Per-table errors expected (no tables exist yet); handler
    // exits 2 when report.errors.length > 0.
    expect([0, 2]).toContain(code);

    // DB file still there (sanity).
    expect(existsSync(existingDb)).toBe(true);

    // Load-bearing: no _migrations table — dry-run never called migrate().
    const dbAfter = openDb(existingDb, { readonly: true, skipIntegrityCheck: true });
    const migCount = dbAfter
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_migrations'",
      )
      .get() as { n: number } | null;
    expect(migCount?.n ?? 0).toBe(0);
    dbAfter.close();
  });
});

describe('runGcCli — repoRoot resolution', () => {
  test('gc from <repo>/src/ honors <repo>/.agent/config.toml (not subdir defaults)', async () => {
    // Operator-reported bug: handler passed raw cwd to
    // loadRetentionConfig, so running from a subdir read
    // <subdir>/.agent/config.toml (non-existent) and silently used
    // defaults. In --force mode that pruned rows with the wrong
    // retention window — data-retention regression.
    //
    // git init the tempdir so resolveRepoRoot walks back to it
    // from the subdir invocation cwd.
    const gitInit = Bun.spawnSync({
      cmd: ['git', 'init', '-q', cwd],
      env: process.env,
    });
    if (gitInit.exitCode !== 0) {
      console.warn('skipping gc subdir-resolve test: git init returned', gitInit.exitCode);
      return;
    }
    // Write project config at REPO ROOT with a distinctive override.
    const projectConfigDir = join(cwd, '.agent');
    const projectConfigPath = join(projectConfigDir, 'config.toml');
    const { mkdirSync: mkdir } = await import('node:fs');
    mkdir(projectConfigDir, { recursive: true });
    writeFileSync(projectConfigPath, '[audit.retention]\nretrieval_trace = 7\n');

    // Create subdir, run gc from there.
    const subdir = join(cwd, 'src');
    mkdir(subdir, { recursive: true });

    const code = await runGcCli({
      cwd: subdir, // <-- invocation cwd is the subdir
      force: false,
      json: true,
      tables: ['retrieval_trace'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as {
      config: { retrieval_trace_days: number };
      configSources: { project: string | null };
    };
    // The load-bearing assertions:
    //   (a) retrieval_trace_days = 7 (from repo-root config),
    //       NOT 90 (default).
    //   (b) configSources.project points at the REPO-ROOT path,
    //       NOT a subdir path.
    expect(parsed.config.retrieval_trace_days).toBe(7);
    expect(parsed.configSources.project).toBe(projectConfigPath);
  });
});

describe('runGcCli — suggested force command preserves scope', () => {
  // Operator-reported safety bug: dry-run with --table=X suggested
  // a bare `agent gc --force` command. Copy-pasting widened the
  // sweep to ALL tables — data loss outside the inspected scope.
  // Fix: the suggested command echoes the same --table=X flags.

  test('no --table → "agent gc --force" (unscoped)', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: [],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command?: string };
    expect(parsed.command).toBe('agent gc --force');
  });

  test('single --table → preserved in suggestion', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: ['context_pins'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command?: string };
    expect(parsed.command).toBe('agent gc --force --table=context_pins');
  });

  test('multiple --table → all preserved, order maintained', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: ['memory_events', 'hook_runs', 'outcomes'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command?: string };
    expect(parsed.command).toBe(
      'agent gc --force --table=memory_events --table=hook_runs --table=outcomes',
    );
  });

  test('human output echoes scoped command', async () => {
    const code = await runGcCli({
      cwd,
      force: false,
      json: false,
      tables: ['retrieval_trace'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const stdout = outBuf.join('');
    expect(stdout).toContain('agent gc --force --table=retrieval_trace');
    // Negative polarity: bare suggestion must NOT appear (would
    // otherwise indicate the scope was dropped).
    expect(stdout).not.toMatch(/agent gc --force\n/);
  });

  test('force mode JSON omits command (no follow-up to suggest)', async () => {
    const code = await runGcCli({
      cwd,
      force: true,
      json: true,
      tables: ['context_pins'],
      out,
      err,
      dbPath,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command?: string };
    expect(parsed.command).toBeUndefined();
  });

  test('DB-unreadable dry-run path also preserves scope', async () => {
    // The empty-report emergency path (SQLITE_CANTOPEN catch) also
    // emits a suggested command; that path must preserve scope too.
    const code = await runGcCli({
      cwd,
      force: false,
      json: true,
      tables: ['bg_processes'],
      out,
      err,
      dbPath: join(xdgHome, 'never-existed.db'),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('').trim()) as { command?: string };
    expect(parsed.command).toBe('agent gc --force --table=bg_processes');
    expect(errBuf.join('')).toContain('agent gc --force --table=bg_processes');
  });
});
