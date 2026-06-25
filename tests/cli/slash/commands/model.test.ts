// /model <id> — switch + autosave the selection to
// `.forja/config.toml [providers].model` (model-pin autosave).
//
// The in-memory switch is covered by the harness's startTurn snapshot
// elsewhere; here we assert the NEW persistence side effect: a switch
// writes the pin, a no-op switch / read / unknown id does NOT, and the
// write preserves unrelated sections.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCommand } from '../../../../src/cli/slash/commands/model.ts';
import type { SlashContext } from '../../../../src/cli/slash/types.ts';
import { projectDirName } from '../../../../src/config/app-namespace.ts';
import { resolveRepoRoot } from '../../../../src/memory/paths.ts';
import { type ModelEntry, createRegistry } from '../../../../src/providers/registry.ts';
import type { Provider } from '../../../../src/providers/types.ts';

const mockProvider = (id: string): Provider =>
  ({
    id,
    family: 'anthropic',
    capabilities: { context_window: 200_000, output_max_tokens: 64_000 },
  }) as unknown as Provider;

const entry = (id: string): ModelEntry =>
  ({
    id,
    family: 'anthropic',
    modelName: id.replace(/^anthropic\//, ''),
    capabilities: { context_window: 200_000, output_max_tokens: 64_000 },
    factory: () => mockProvider(id),
  }) as unknown as ModelEntry;

let workdir: string;
let configPath: string;
let ctx: SlashContext;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-model-cmd-'));
  // Resolve the path exactly as the command does, so the assertion is
  // robust to the project-dir namespace (FORJA_DEV) and repo-root walk.
  configPath = join(resolveRepoRoot(workdir), projectDirName(), 'config.toml');
  const registry = createRegistry();
  registry.register(entry('test/current'));
  registry.register(entry('test/target'));
  ctx = {
    baseConfig: { cwd: workdir, provider: mockProvider('test/current') },
    modelRegistry: registry,
    isRunning: () => false,
  } as unknown as SlashContext;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('/model autosave', () => {
  test('switching pins the new model to .forja/config.toml', async () => {
    const r = await modelCommand.exec(['test/target'], ctx);
    expect(r.kind).toBe('ok');
    // In-memory switch landed.
    expect(ctx.baseConfig.provider.id).toBe('test/target');
    // Persisted.
    expect(existsSync(configPath)).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
    };
    expect(parsed.providers.model).toBe('test/target');
    if (r.kind === 'ok') {
      expect((r.notes ?? []).some((n) => n.includes('pinned in'))).toBe(true);
    }
  });

  test('preserves an unrelated [budget] section through the pin', async () => {
    mkdirSync(join(workdir, projectDirName()), { recursive: true });
    writeFileSync(configPath, '[budget]\nmax_steps = 200\n');
    const r = await modelCommand.exec(['test/target'], ctx);
    expect(r.kind).toBe('ok');
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
      budget: { max_steps: number };
    };
    expect(parsed.providers.model).toBe('test/target');
    expect(parsed.budget.max_steps).toBe(200);
  });

  test('read-only /model (no args) writes nothing', async () => {
    const r = await modelCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    expect(existsSync(configPath)).toBe(false);
  });

  test('unknown id errors and writes nothing', async () => {
    const r = await modelCommand.exec(['test/nope'], ctx);
    expect(r.kind).toBe('error');
    expect(existsSync(configPath)).toBe(false);
  });

  test('switching to the already-active model is a no-op (no file written)', async () => {
    const r = await modelCommand.exec(['test/current'], ctx);
    expect(r.kind).toBe('ok');
    // Handler short-circuits on same-id BEFORE the persist path.
    expect(existsSync(configPath)).toBe(false);
  });
});
