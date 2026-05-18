// /memory governance enable | disable subcommand coverage (Slice Q).
//
// Writes `.agent/config.toml [memory]` keys. Verifies:
//   - fresh repo: creates `.agent/` + file with `[memory]` block.
//   - existing config with `[critique]` only: preserves verbatim,
//     appends `[memory]`.
//   - round-trip: disable → loadMemoryConfig reads false.
//   - target parsing: verify | conflict | all + invalid.
//   - argument shape: extra positional rejected.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCommand } from '../../../src/cli/slash/commands/memory.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import { loadMemoryConfig } from '../../../src/critique/config-loader.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import type { ScopeRoots } from '../../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../../src/memory/registry.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let workdir: string;
let ctx: SlashContext;
let db: DB;

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-gov-toggle-'));
  db = openMemoryDb();
  migrate(db);
  const sessionId = createSession(db, { model: 'test/m', cwd: workdir }).id;
  const registry = createMemoryRegistry({ roots: makeRoots(workdir), db, sessionId, cwd: workdir });
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const baseConfig = {
    cwd: workdir,
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
    memoryRegistry: registry,
  } as unknown as HarnessConfig;
  ctx = {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0, critiqueRuns: 0 },
    now: () => 1,
    requestShutdown: () => {},
    isRunning: () => false,
    currentSessionId: () => sessionId,
    replSessionIds: () => [sessionId],
    modelRegistry: createModelRegistry(),
  } as SlashContext;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  db.close();
});

describe('/memory governance disable', () => {
  test('fresh repo: creates .agent/config.toml with [memory] block (disable verify)', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const configPath = join(workdir, '.agent', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = true');
  });

  test('disable conflict: only conflict flips, verify stays true', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = true');
    expect(raw).toContain('conflict_detect_llm = false');
  });

  test('disable all: both flip to false', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
  });

  test('preserves [critique] section data through round-trip (comments lost)', async () => {
    // Round-trip semantics: parse → mutate → canonical emit. Table
    // *data* survives (keys + values are re-emitted from the parsed
    // object); comments and original whitespace are intentionally
    // dropped — the trade-off is documented in src/cli/slash/
    // commands/memory.ts above `emitTomlDoc`.
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    const existing = `# operator-edited config
[critique]
mode = "on_writes"
threshold = 0.85
# threshold tuned post-eval
`;
    writeFileSync(join(workdir, '.agent', 'config.toml'), existing);
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('[critique]');
    expect(raw).toContain('mode = "on_writes"');
    expect(raw).toContain('threshold = 0.85');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    // Comments are dropped on rewrite (canonical emit).
    expect(raw).not.toContain('# operator-edited config');
    expect(raw).not.toContain('# threshold tuned post-eval');
  });

  test('replaces existing [memory] block in place (no duplicate)', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    const occurrences = (raw.match(/^\[memory\]$/gm) ?? []).length;
    expect(occurrences).toBe(1);
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
  });

  test('round-trip via loadMemoryConfig: disable verify → resolved false', async () => {
    await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    expect(loaded.config.conflictDetectLlm).toBe(true);
    expect(loaded.projectHadField.verifySemanticLlm).toBe(true);
  });

  test('invalid target: rejected, no file written', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'foo'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('expected');
    }
    expect(existsSync(join(workdir, '.agent', 'config.toml'))).toBe(false);
  });

  test('extra positional: rejected', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'verify', 'oops'], ctx);
    expect(r.kind).toBe('error');
  });

  test('missing target: rejected', async () => {
    const r = await memoryCommand.exec(['governance', 'disable'], ctx);
    expect(r.kind).toBe('error');
  });
});

describe('/memory governance enable', () => {
  test('enable all reverses doubly-disabled state', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = false
`,
    );
    const r = await memoryCommand.exec(['governance', 'enable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(true);
    expect(loaded.config.conflictDetectLlm).toBe(true);
  });
});

// Robustness of the parse → mutate → canonical-emit round-trip
// against shapes that defeat a regex-driven splice (A-H1/2/3 from
// the post-Slice-Q code review).
describe('/memory governance disable: round-trip robustness', () => {
  test('multi-line basic string in [critique] survives', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[critique]
mode = "on_writes"
prompt_version = "v1\\n[memory]\\nverify_semantic_llm = true"
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    // Re-parsed: [critique].prompt_version retains its embedded payload.
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('[critique]');
    expect(raw).toContain('mode = "on_writes"');
    // Embedded `[memory]` substring is inside a string, not a table.
    const tableHeaderCount = (raw.match(/^\[memory\]$/gm) ?? []).length;
    expect(tableHeaderCount).toBe(1);
  });

  test('whitespace inside [ memory ] header is normalized', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[  memory  ]
verify_semantic_llm = true
conflict_detect_llm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('[memory]');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    expect(loaded.config.conflictDetectLlm).toBe(false);
  });

  test('CRLF line endings parse + re-emit cleanly', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      '[critique]\r\nmode = "on_writes"\r\n\r\n[memory]\r\nverify_semantic_llm = true\r\nconflict_detect_llm = true\r\n',
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(true);
    expect(loaded.config.conflictDetectLlm).toBe(false);
  });

  test('empty file gains [memory] block', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(join(workdir, '.agent', 'config.toml'), '');
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = true');
  });

  test('camelCase aliases are normalized to snake_case on rewrite', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verifySemanticLlm = false
conflictDetectLlm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    // Snake-case keys are authoritative after re-emit.
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).not.toContain('verifySemanticLlm');
    expect(raw).not.toContain('conflictDetectLlm');
  });

  test('malformed TOML refuses to write', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    const broken = '[memory\nverify_semantic_llm = true\n';
    writeFileSync(join(workdir, '.agent', 'config.toml'), broken);
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('error');
    // File untouched.
    const raw = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    expect(raw).toBe(broken);
  });
});
