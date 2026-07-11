// `forja init` model_providers step: materialize the catalog seed into
// the user scope, skip-if-exists, and `--force=model_providers` re-sync.
// The written file must be a valid catalog the loader accepts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.ts';
import { loadModelProvidersFile, modelProvidersPath } from '../../src/providers/catalog-io.ts';

let workdir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-init-mp-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

const collect = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sinks: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe('forja init — model_providers step', () => {
  test('writes a catalog the loader accepts', () => {
    const { out, sinks } = collect();
    const code = runInit({
      cwd: workdir,
      mode: 'strict',
      only: ['model_providers'],
      out: sinks.out,
      err: sinks.err,
    });
    expect(code).toBe(0);
    const path = modelProvidersPath();
    expect(path).not.toBeNull();
    expect(existsSync(path as string)).toBe(true);
    expect(out.join('')).toContain('wrote');
    // The freshly written file is a valid, loadable catalog.
    const r = loadModelProvidersFile();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries.length).toBeGreaterThan(0);
  });

  test('skip-if-exists on a second run without force', () => {
    const first = collect();
    runInit({ cwd: workdir, mode: 'strict', only: ['model_providers'], ...first.sinks });
    const before = readFileSync(modelProvidersPath() as string, 'utf-8');
    const second = collect();
    runInit({ cwd: workdir, mode: 'strict', only: ['model_providers'], ...second.sinks });
    expect(second.out.join('')).toContain('skip');
    // Untouched.
    expect(readFileSync(modelProvidersPath() as string, 'utf-8')).toBe(before);
  });

  test('--force=model_providers re-syncs (overwrites)', () => {
    const first = collect();
    runInit({ cwd: workdir, mode: 'strict', only: ['model_providers'], ...first.sinks });
    const forced = collect();
    runInit({
      cwd: workdir,
      mode: 'strict',
      only: ['model_providers'],
      force: ['model_providers'],
      ...forced.sinks,
    });
    expect(forced.out.join('')).toContain('overwrote');
  });
});
