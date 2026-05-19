// `agent gc` CLI handler tests. The orchestrator is already pinned
// by tests/audit/gc.test.ts — this file covers the CLI seam:
// rendering, JSON shape, table filter forwarding, exit codes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // Phase 1 + Phase 2 = 10 tables (outcome_signals enabled by default).
    expect(parsed.tables.length).toBe(10);
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
  test('reports error and exits 1 when DB cannot be opened', async () => {
    const blocker = join(xdgHome, 'blocker');
    writeFileSync(blocker, 'not-a-dir');
    const impossibleDb = join(blocker, 'sub', 'db.sqlite');
    const code = await runGcCli({
      cwd,
      force: false,
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
