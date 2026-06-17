// /memory governance enable | disable subcommand coverage (Slice Q).
//
// Writes `.forja/config.toml [memory]` keys. Verifies:
//   - fresh repo: creates `.forja/` + file with `[memory]` block.
//   - existing config with `[providers]` only: preserves verbatim,
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
import { loadMemoryConfig } from '../../../src/config/loaders.ts';
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
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
    memoryRegistry: registry,
  } as unknown as HarnessConfig;
  ctx = {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
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
  test('fresh repo: creates .forja/config.toml with ONLY the patched key (post-review)', async () => {
    // Post-review fix: untouched detectors are NOT materialized
    // as defaults — that would shadow any user-config opt-out the
    // operator set globally. Only the patched key lands.
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const configPath = join(workdir, '.forja', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    // Untouched keys MUST NOT land — would override user-config
    // values per project>user precedence.
    expect(raw).not.toContain('conflict_detect_llm');
    expect(raw).not.toContain('override_detect_llm');
  });

  test('disable conflict: only conflict_detect_llm lands (verify/override absent)', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).not.toContain('verify_semantic_llm');
    expect(raw).not.toContain('override_detect_llm');
  });

  test('disable override: only override_detect_llm lands (verify/conflict absent)', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'override'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('override_detect_llm = false');
    expect(raw).not.toContain('verify_semantic_llm');
    expect(raw).not.toContain('conflict_detect_llm');
  });

  test('disable all: all three flip to false', async () => {
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).toContain('override_detect_llm = false');
  });

  test('mutates ctx.baseConfig live so the next startTurn picks up the disable (post-review)', async () => {
    // Pre-fix, the toggle only wrote .forja/config.toml. startTurn
    // builds the next HarnessConfig from ctx.baseConfig, which still
    // carried the pre-disable values until process restart — the
    // scheduler kept firing for one or more turns despite the
    // command's "effect applies at next turn boundary" note. Live
    // mutation closes the gap.
    //
    // Cast to `unknown` then re-read through a HarnessConfig-typed
    // local so TS doesn't narrow the source field to the literal we
    // just assigned (otherwise `toBe('project-config')` trips
    // because the inferred expected type is the narrowed `'default'`).
    const cfg = ctx.baseConfig as unknown as HarnessConfig;
    cfg.memorySemanticVerify = true;
    cfg.memorySemanticVerifySource = 'default';
    cfg.memoryConflictDetect = true;
    cfg.memoryConflictDetectSource = 'default';
    cfg.memoryOverrideDetect = true;
    cfg.memoryOverrideDetectSource = 'default';
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const after = ctx.baseConfig as unknown as HarnessConfig;
    expect(after.memorySemanticVerify).toBe(false);
    expect(after.memorySemanticVerifySource).toBe('project-config');
    expect(after.memoryConflictDetect).toBe(false);
    expect(after.memoryConflictDetectSource).toBe('project-config');
    expect(after.memoryOverrideDetect).toBe(false);
    expect(after.memoryOverrideDetectSource).toBe('project-config');
  });

  test('mutates ctx.baseConfig back to true on enable (live re-enable round-trip)', async () => {
    // Symmetric pin: a re-enable after a disable in the same session
    // also flips the live value, so the operator can toggle without
    // restarting the REPL.
    const cfg = ctx.baseConfig as unknown as HarnessConfig;
    cfg.memorySemanticVerify = false;
    cfg.memorySemanticVerifySource = 'project-config';
    const r = await memoryCommand.exec(['governance', 'enable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const after = ctx.baseConfig as unknown as HarnessConfig;
    expect(after.memorySemanticVerify).toBe(true);
    expect(after.memorySemanticVerifySource).toBe('project-config');
  });

  test('targeted disable only mutates the targeted detector in ctx.baseConfig', async () => {
    // Verify the target.{verify|conflict|override} branches are
    // independent — disabling 'conflict' must NOT touch the
    // verify/override live values even though all three keys land
    // in the file.
    const cfg = ctx.baseConfig as unknown as HarnessConfig;
    cfg.memorySemanticVerify = true;
    cfg.memorySemanticVerifySource = 'default';
    cfg.memoryConflictDetect = true;
    cfg.memoryConflictDetectSource = 'default';
    cfg.memoryOverrideDetect = true;
    cfg.memoryOverrideDetectSource = 'default';
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const after = ctx.baseConfig as unknown as HarnessConfig;
    expect(after.memorySemanticVerify).toBe(true);
    expect(after.memorySemanticVerifySource).toBe('default');
    expect(after.memoryConflictDetect).toBe(false);
    expect(after.memoryConflictDetectSource).toBe('project-config');
    expect(after.memoryOverrideDetect).toBe(true);
    expect(after.memoryOverrideDetectSource).toBe('default');
  });

  test('preserves unrelated section data through round-trip (comments lost)', async () => {
    // Round-trip semantics: parse → mutate → canonical emit. Table
    // *data* survives (keys + values are re-emitted from the parsed
    // object); comments and original whitespace are intentionally
    // dropped — the trade-off is documented in src/cli/slash/
    // commands/memory.ts above `emitTomlDoc`. Uses [providers] as a
    // stand-in for "any section the toggle must not clobber".
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    const existing = `# operator-edited config
[providers]
model = "anthropic/claude-opus-4-7"
# model pinned post-eval
`;
    writeFileSync(join(workdir, '.forja', 'config.toml'), existing);
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('[providers]');
    expect(raw).toContain('model = "anthropic/claude-opus-4-7"');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    // Comments are dropped on rewrite (canonical emit).
    expect(raw).not.toContain('# operator-edited config');
    expect(raw).not.toContain('# model pinned post-eval');
  });

  test('replaces existing [memory] block in place (no duplicate)', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
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
    expect(existsSync(join(workdir, '.forja', 'config.toml'))).toBe(false);
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
  test('enable all reverses triply-disabled state', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = false
override_detect_llm = false
`,
    );
    const r = await memoryCommand.exec(['governance', 'enable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(true);
    expect(loaded.config.conflictDetectLlm).toBe(true);
    expect(loaded.config.overrideDetectLlm).toBe(true);
  });

  test('enable override: only override flips back, others stay', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = false
override_detect_llm = false
`,
    );
    const r = await memoryCommand.exec(['governance', 'enable', 'override'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    expect(loaded.config.conflictDetectLlm).toBe(false);
    expect(loaded.config.overrideDetectLlm).toBe(true);
  });
});

// Robustness of the parse → mutate → canonical-emit round-trip
// against shapes that defeat a regex-driven splice (A-H1/2/3 from
// the post-Slice-Q code review).
describe('/memory governance disable: round-trip robustness', () => {
  test('multi-line basic string in an unrelated section survives', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[providers]
model = "anthropic/claude-opus-4-7"
note = "line1\\n[memory]\\nverify_semantic_llm = true"
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    // Re-parsed: [providers].note retains its embedded payload.
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('[providers]');
    expect(raw).toContain('model = "anthropic/claude-opus-4-7"');
    // Embedded `[memory]` substring is inside a string, not a table.
    const tableHeaderCount = (raw.match(/^\[memory\]$/gm) ?? []).length;
    expect(tableHeaderCount).toBe(1);
  });

  test('whitespace inside [ memory ] header is normalized', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[  memory  ]
verify_semantic_llm = true
conflict_detect_llm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('[memory]');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(false);
    expect(loaded.config.conflictDetectLlm).toBe(false);
  });

  test('CRLF line endings parse + re-emit cleanly', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      '[providers]\r\nmodel = "anthropic/claude-opus-4-7"\r\n\r\n[memory]\r\nverify_semantic_llm = true\r\nconflict_detect_llm = true\r\n',
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const loaded = loadMemoryConfig({ cwd: workdir });
    expect(loaded.config.verifySemanticLlm).toBe(true);
    expect(loaded.config.conflictDetectLlm).toBe(false);
  });

  test('empty file gains [memory] block with only the patched key', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(join(workdir, '.forja', 'config.toml'), '');
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('[memory]');
    expect(raw).toContain('verify_semantic_llm = false');
    // Untouched detectors stay absent (post-review fix — don't
    // shadow user-config opt-outs).
    expect(raw).not.toContain('conflict_detect_llm');
  });

  test('camelCase aliases are normalized to snake_case on rewrite', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      `[memory]
verifySemanticLlm = false
conflictDetectLlm = true
`,
    );
    const r = await memoryCommand.exec(['governance', 'disable', 'conflict'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    // Snake-case keys are authoritative after re-emit.
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).not.toContain('verifySemanticLlm');
    expect(raw).not.toContain('conflictDetectLlm');
  });

  test('malformed TOML refuses to write', async () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    const broken = '[memory\nverify_semantic_llm = true\n';
    writeFileSync(join(workdir, '.forja', 'config.toml'), broken);
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('error');
    // File untouched.
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toBe(broken);
  });
});

describe('/memory governance disable: user-config preservation (post-review)', () => {
  // Pre-fix: when ANY detector was disabled in
  // ~/.config/forja/config.toml (user scope), running `/memory
  // governance disable verify` at project scope wrote
  // `conflict_detect_llm = true` + `override_detect_llm = true`
  // into the project config because the mutator initialized
  // untouched keys to `true`. Project precedence then beat the
  // user-level disable — detectors silently re-enabled, LLM
  // spend resumed. Operator saw `/memory governance status`
  // showing `yes (.forja/config.toml)` for detectors they had
  // never touched through that command.
  //
  // Post-fix: the mutator only writes the patched key. Untouched
  // keys stay absent → user-config values still resolve via the
  // precedence chain.

  test('user-disabled conflict is NOT shadowed when operator runs `disable verify` at project', async () => {
    // Simulate a user-config opt-out by writing to a temp dir we
    // pass via XDG_CONFIG_HOME, then run the project-level
    // toggle. The end-state assertion is the project config
    // file's shape: conflict_detect_llm MUST be absent so the
    // user-level disable still wins.
    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    // Patch landed.
    expect(raw).toContain('verify_semantic_llm = false');
    // Crucial: untouched keys are NOT in the file. Without this,
    // the precedence chain would surface project's `true` for
    // conflict / override and beat the user-level disable.
    expect(raw).not.toContain('conflict_detect_llm');
    expect(raw).not.toContain('override_detect_llm');
  });

  test('targeted enable on already-present key does NOT materialize the others', async () => {
    // Operator first disables verify (only verify_semantic_llm
    // lands), then re-enables it. The re-enable should NOT
    // suddenly add conflict / override keys that were never
    // present in this file.
    await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    let raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).not.toContain('conflict_detect_llm');

    await memoryCommand.exec(['governance', 'enable', 'verify'], ctx);
    raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = true');
    // Still no conflict / override keys — re-enable doesn't
    // materialize defaults.
    expect(raw).not.toContain('conflict_detect_llm');
    expect(raw).not.toContain('override_detect_llm');
  });

  test('existing [memory] keys are preserved across toggle of a different detector', async () => {
    // Operator previously disabled conflict via the toggle
    // (conflict_detect_llm = false is present in project). Then
    // disables verify. Both keys must end up in the file —
    // existing conflict value is preserved, verify patch is
    // applied, override stays absent.
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      join(workdir, '.forja', 'config.toml'),
      '[memory]\nconflict_detect_llm = false\n',
    );
    await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).not.toContain('override_detect_llm');
  });

  test('disable all explicit DOES write all three keys (operator typed all three)', async () => {
    // `disable all` is the legitimate "I want all three off at
    // project scope" path — every key is part of the patch, so
    // every key lands. This is the inverse case of the
    // user-config preservation: the operator was explicit about
    // all three.
    const r = await memoryCommand.exec(['governance', 'disable', 'all'], ctx);
    expect(r.kind).toBe('ok');
    const raw = readFileSync(join(workdir, '.forja', 'config.toml'), 'utf8');
    expect(raw).toContain('verify_semantic_llm = false');
    expect(raw).toContain('conflict_detect_llm = false');
    expect(raw).toContain('override_detect_llm = false');
  });
});

describe('/memory governance disable: repo-root anchoring (post-review)', () => {
  // Pre-fix: the toggle wrote `<ctx.baseConfig.cwd>/.forja/config
  // .toml`. When the REPL was launched from a subdir, the file
  // landed in the subdir but bootstrap reads from the REPO root
  // (via resolveRepoRoot, fixed in commit 734a262). Process
  // restart → next bootstrap doesn't see the persisted disable →
  // detector silently re-enables despite a successful slash
  // return.
  //
  // Post-fix: toggle ALSO resolves repo root before writing, so
  // both writer + reader anchor on the same file.

  test('REPL launched from repo subdir writes config to repo root, not subdir', async () => {
    // Set up workdir as a git repo via `git init`. ctx points at a
    // subdir under it (mimicking `forja` launched from `src/`).
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q', workdir], { stdio: 'ignore' });
    const subdir = join(workdir, 'src', 'components');
    mkdirSync(subdir, { recursive: true });
    // Mutate the ctx baseConfig to point at the subdir as the
    // active cwd — same shape the REPL passes from an `forja`
    // invocation in a subdir.
    (ctx.baseConfig as { cwd: string }).cwd = subdir;

    const r = await memoryCommand.exec(['governance', 'disable', 'verify'], ctx);
    expect(r.kind).toBe('ok');

    // File MUST land at the repo root, NOT the subdir.
    const repoConfig = join(workdir, '.forja', 'config.toml');
    const subdirConfig = join(subdir, '.forja', 'config.toml');
    expect(existsSync(repoConfig)).toBe(true);
    expect(existsSync(subdirConfig)).toBe(false);
    const raw = readFileSync(repoConfig, 'utf8');
    expect(raw).toContain('verify_semantic_llm = false');
  });
});
