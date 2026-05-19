// [audit.retention] config loader tests. Pins the per-key
// validation, the project-overrides-user layering, the silent
// acceptance of Phase 2+ keys for forward compat, and the typo
// warning for unknown keys.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RETENTION,
  loadRetentionConfig,
  parseDays,
  parseTtlMs,
} from '../../src/audit/config-loader.ts';

let workdir: string;
let userPath: string;
let projectPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-gc-config-'));
  userPath = join(workdir, 'user.toml');
  projectPath = join(workdir, 'project.toml');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('parseTtlMs', () => {
  test('accepts "1h" → 3600000ms', () => {
    expect(parseTtlMs('1h')).toBe(3_600_000);
  });
  test('accepts "30m" → 1800000ms', () => {
    expect(parseTtlMs('30m')).toBe(1_800_000);
  });
  test('accepts "5s" → 5000ms', () => {
    expect(parseTtlMs('5s')).toBe(5000);
  });
  test('accepts "500ms" → 500ms', () => {
    expect(parseTtlMs('500ms')).toBe(500);
  });
  test('accepts positive integer (raw ms)', () => {
    expect(parseTtlMs(60000)).toBe(60000);
  });
  test('rejects zero / negative / non-integer numbers', () => {
    expect(parseTtlMs(0)).toBeNull();
    expect(parseTtlMs(-1)).toBeNull();
    expect(parseTtlMs(1.5)).toBeNull();
    expect(parseTtlMs(Number.NaN)).toBeNull();
  });
  test('rejects float duration strings ("1.5h")', () => {
    expect(parseTtlMs('1.5h')).toBeNull();
  });
  test('rejects unknown units', () => {
    expect(parseTtlMs('1d')).toBeNull();
    expect(parseTtlMs('1y')).toBeNull();
  });
  test('rejects bare numbers as strings', () => {
    expect(parseTtlMs('60')).toBeNull();
  });
});

describe('parseDays', () => {
  test('accepts positive integers', () => {
    expect(parseDays(90)).toBe(90);
    expect(parseDays(1)).toBe(1);
  });
  test('rejects zero / negative / float / non-number', () => {
    expect(parseDays(0)).toBeNull();
    expect(parseDays(-1)).toBeNull();
    expect(parseDays(90.5)).toBeNull();
    expect(parseDays('90')).toBeNull();
  });
});

describe('loadRetentionConfig', () => {
  test('returns DEFAULT_RETENTION when no files exist', () => {
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath: null });
    expect(r.config).toEqual(DEFAULT_RETENTION);
    expect(r.warnings).toEqual([]);
  });

  test('user layer overrides defaults', () => {
    writeFileSync(userPath, '[audit.retention]\nretrieval_trace = 30\nrecap_cache = "5m"\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath, projectPath: null });
    expect(r.config.retrieval_trace_days).toBe(30);
    expect(r.config.recap_cache_ttl_ms).toBe(5 * 60 * 1000);
    // Untouched keys fall through to defaults.
    expect(r.config.context_pins_days).toBe(DEFAULT_RETENTION.context_pins_days);
    expect(r.config.bg_processes_days).toBe(DEFAULT_RETENTION.bg_processes_days);
    expect(r.warnings).toEqual([]);
  });

  test('project layer overrides user (per-key)', () => {
    writeFileSync(userPath, '[audit.retention]\nretrieval_trace = 30\ncontext_pins = 60\n');
    writeFileSync(projectPath, '[audit.retention]\nretrieval_trace = 7\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath, projectPath });
    // retrieval_trace: project wins (7), even though user set 30.
    expect(r.config.retrieval_trace_days).toBe(7);
    // context_pins: only user set it → user wins.
    expect(r.config.context_pins_days).toBe(60);
    expect(r.warnings).toEqual([]);
  });

  test('warns on unknown retention key', () => {
    writeFileSync(
      projectPath,
      '[audit.retention]\nretreival_trace = 30\n', // typo
    );
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    expect(r.warnings.some((w) => w.includes('retreival_trace'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('not a known retention key'))).toBe(true);
    // Misconfig doesn't break loader — defaults fill in.
    expect(r.config.retrieval_trace_days).toBe(DEFAULT_RETENTION.retrieval_trace_days);
  });

  test('accepts Phase 2+ keys silently (forward compat)', () => {
    writeFileSync(projectPath, '[audit.retention]\napprovals_log = 365\nmemory_events = 365\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    // No warnings: both keys are in KNOWN_SCHEMA_KEYS.
    expect(r.warnings).toEqual([]);
    // No effect on Phase 1 config either.
    expect(r.config).toEqual(DEFAULT_RETENTION);
  });

  test('warns on invalid value type but falls back to default', () => {
    writeFileSync(
      projectPath,
      '[audit.retention]\nretrieval_trace = "ninety"\nbg_processes = -1\n',
    );
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    expect(r.warnings.some((w) => w.includes('retrieval_trace'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('bg_processes'))).toBe(true);
    expect(r.config.retrieval_trace_days).toBe(DEFAULT_RETENTION.retrieval_trace_days);
    expect(r.config.bg_processes_days).toBe(DEFAULT_RETENTION.bg_processes_days);
  });

  test('handles [audit] without [audit.retention] subsection', () => {
    writeFileSync(projectPath, '[audit]\nsomething_else = "x"\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    expect(r.config).toEqual(DEFAULT_RETENTION);
    expect(r.warnings).toEqual([]);
  });

  test('warns on [audit.retention] that is not a table', () => {
    writeFileSync(projectPath, '[audit]\nretention = "broken"\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    expect(r.warnings.some((w) => w.includes('must be a table'))).toBe(true);
    expect(r.config).toEqual(DEFAULT_RETENTION);
  });

  test('TOML parse error warns and falls back', () => {
    // Triple-bracket header is unambiguously malformed TOML.
    writeFileSync(projectPath, '[[[broken\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath: null, projectPath });
    expect(r.warnings.some((w) => w.toLowerCase().includes('parse'))).toBe(true);
    expect(r.config).toEqual(DEFAULT_RETENTION);
  });

  test('sources reflect file EXISTENCE — present files return the path', () => {
    writeFileSync(userPath, '[audit.retention]\ncontext_pins = 10\n');
    writeFileSync(projectPath, '[audit.retention]\nretrieval_trace = 1\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath, projectPath });
    expect(r.sources.user).toBe(userPath);
    expect(r.sources.project).toBe(projectPath);
  });

  test('sources are null when paths resolve but the files do NOT exist', () => {
    // Both paths are valid strings but no file was written. Resolver
    // helpers always return a path string when XDG is set, but the
    // renderer should NOT claim a non-existent file is the active
    // source — that would mislead the operator into thinking their
    // config is being honored when in fact defaults are used.
    const r = loadRetentionConfig({ cwd: workdir, userPath, projectPath });
    expect(r.sources.user).toBeNull();
    expect(r.sources.project).toBeNull();
  });

  test('mixed: project file exists, user file does not → only project source returned', () => {
    writeFileSync(projectPath, '[audit.retention]\nbg_processes = 7\n');
    const r = loadRetentionConfig({ cwd: workdir, userPath, projectPath });
    expect(r.sources.user).toBeNull();
    expect(r.sources.project).toBe(projectPath);
  });
});
