import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHookConfig } from '../../src/hooks/config.ts';
import type { HookConfigPaths } from '../../src/hooks/paths.ts';

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-hooks-config-'));
  tmpDirs.push(dir);
  return dir;
};
const writeToml = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const paths = (overrides: Partial<HookConfigPaths> = {}): HookConfigPaths => ({
  enterprise: null,
  user: null,
  project: '/never-exists',
  ...overrides,
});

describe('resolveHookConfig — happy path', () => {
  test('absent files yield empty hooks list with no warnings', () => {
    const tmp = makeTmp();
    const result = resolveHookConfig(paths({ project: join(tmp, 'hooks.toml') }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('parses a single project-layer hook', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "PostToolUse"
        command = "prettier --write {{tool.input.path}}"
        matcher = { tool = "write_file" }
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toHaveLength(1);
    const h = result.hooks[0];
    if (h === undefined) throw new Error('missing hook');
    expect(h.event).toBe('PostToolUse');
    expect(h.command).toBe('prettier --write {{tool.input.path}}');
    expect(h.matcher.tool).toBe('write_file');
    expect(h.layer).toBe('project');
    expect(h.timeoutMs).toBe(5000); // default
    expect(h.failClosed).toBe(false);
    expect(h.locked).toBe(false);
  });

  test('hooks ordered enterprise → user → project, declaration order within layer', () => {
    const tmp = makeTmp();
    const ent = join(tmp, 'enterprise.toml');
    const usr = join(tmp, 'user.toml');
    const prj = join(tmp, 'project.toml');
    writeToml(
      ent,
      `[[hooks]]
       event = "Stop"
       command = "ent1"

       [[hooks]]
       event = "Stop"
       command = "ent2"`,
    );
    writeToml(usr, `[[hooks]]\nevent = "Stop"\ncommand = "usr1"`);
    writeToml(prj, `[[hooks]]\nevent = "Stop"\ncommand = "prj1"`);
    const result = resolveHookConfig({ enterprise: ent, user: usr, project: prj });
    expect(result.hooks.map((h) => h.command)).toEqual(['ent1', 'ent2', 'usr1', 'prj1']);
    expect(result.hooks.map((h) => h.layer)).toEqual([
      'enterprise',
      'enterprise',
      'user',
      'project',
    ]);
  });

  test('entryIndex captures the hook position WITHIN its source file', () => {
    // entryIndex is the canonical identity for hook_runs.hook_index
    // (paired with sourcePath). Per-layer 0-based, NOT global flat
    // index — each layer's array is indexed independently. Keeps
    // operator references like `<sourcePath>#<index>` correct
    // regardless of how other layers shift the global ordering.
    const tmp = makeTmp();
    const ent = join(tmp, 'enterprise.toml');
    const prj = join(tmp, 'project.toml');
    writeToml(
      ent,
      `[[hooks]]
       event = "Stop"
       command = "ent_a"

       [[hooks]]
       event = "Stop"
       command = "ent_b"`,
    );
    writeToml(
      prj,
      `[[hooks]]
       event = "Stop"
       command = "prj_a"

       [[hooks]]
       event = "Stop"
       command = "prj_b"`,
    );
    const result = resolveHookConfig({ enterprise: ent, user: '/nope', project: prj });
    expect(result.hooks.map((h) => `${h.layer}:${h.command}:${h.entryIndex}`)).toEqual([
      'enterprise:ent_a:0',
      'enterprise:ent_b:1',
      // Project starts back at 0 — per-layer indexing.
      'project:prj_a:0',
      'project:prj_b:1',
    ]);
  });
});

describe('resolveHookConfig — validation', () => {
  test('drops entry with invalid event + warns', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "BogusEvent"
        command = "x"
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('invalid_entry');
    expect(result.warnings[0]?.message).toContain('event must be one of');
  });

  test('drops entry with empty command + warns', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "Stop"
        command = ""
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings[0]?.message).toContain('command must be a non-empty string');
  });

  test('clamps timeout out of range (and emits warning)', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "Stop"
        command = "x"
        timeout_ms = 99999999
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.timeoutMs).toBe(30000);
    expect(result.warnings[0]?.message).toContain('clamped to 30000');
  });

  test('rejects fractional timeout_ms (validator promised integer)', () => {
    // Sanity-revert: pre-fix, the check was
    // `Number.isFinite(rawTimeout)` + `>= 0` — accepting any
    // finite non-negative number including fractions.
    // `timeout_ms = 2500.5` silently propagated as a non-
    // integer setTimeout delay. Common operator mistakes:
    // accidental decimal from a unit-conversion pass, or
    // unit-mismatch (`0.5` intending half a second).
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "Stop"
        command = "x"
        timeout_ms = 2500.5
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings[0]?.message).toContain('timeout_ms must be a non-negative integer');
  });

  test('rejects unit-mismatch timeout (0.5 meaning seconds)', () => {
    // Same gate, different operator-mistake shape.
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "Stop"
        command = "x"
        timeout_ms = 0.5
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings[0]?.message).toContain('non-negative integer');
  });

  test('drops entry with malformed matcher + warns', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "PreToolUse"
        command = "x"
        matcher = "not-a-table"
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings[0]?.message).toContain('matcher must be an inline table');
  });

  test('valid + invalid entries side-by-side: valid survives', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'hooks.toml');
    writeToml(
      tomlPath,
      `
        [[hooks]]
        event = "Stop"
        command = "ok"

        [[hooks]]
        event = "Bogus"
        command = "skipped"

        [[hooks]]
        event = "Notification"
        command = "ok2"
      `,
    );
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks.map((h) => h.command)).toEqual(['ok', 'ok2']);
    expect(result.warnings).toHaveLength(1);
  });

  test('TOML parse error: empty layer + unreadable_file warning', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'broken.toml');
    // Bun.TOML.parse is lenient — `[[ name` doesn't throw. Use a
    // shape it consistently rejects (unterminated array).
    writeToml(tomlPath, 'hooks = [unterminated');
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings[0]?.kind).toBe('unreadable_file');
    expect(result.warnings[0]?.message).toContain('TOML parse failed');
  });

  test('absent `hooks` table is OK (empty config)', () => {
    const tmp = makeTmp();
    const tomlPath = join(tmp, 'empty.toml');
    writeToml(tomlPath, '# just a comment');
    const result = resolveHookConfig(paths({ project: tomlPath }));
    expect(result.hooks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('resolveHookConfig — locking semantics', () => {
  test('enterprise locked=true is honored', () => {
    const tmp = makeTmp();
    const ent = join(tmp, 'ent.toml');
    writeToml(
      ent,
      `[[hooks]]
       event = "PreToolUse"
       command = "audit.sh"
       locked = true`,
    );
    const result = resolveHookConfig({ enterprise: ent, user: null, project: '/never' });
    expect(result.hooks[0]?.locked).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('user locked=true is ignored + warned', () => {
    const tmp = makeTmp();
    const usr = join(tmp, 'usr.toml');
    writeToml(
      usr,
      `[[hooks]]
       event = "Stop"
       command = "x"
       locked = true`,
    );
    const result = resolveHookConfig({ enterprise: null, user: usr, project: '/never' });
    expect(result.hooks[0]?.locked).toBe(false);
    expect(result.warnings[0]?.kind).toBe('lock_ignored');
  });

  test('project locked=true is ignored + warned', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'prj.toml');
    writeToml(
      prj,
      `[[hooks]]
       event = "Stop"
       command = "x"
       locked = true`,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.hooks[0]?.locked).toBe(false);
    expect(result.warnings[0]?.kind).toBe('lock_ignored');
  });
});

describe('resolveHookConfig — Eviction event + matcher fields', () => {
  test('Eviction is accepted as a valid event', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `
        [[hooks]]
        event = "Eviction"
        command = "audit-eviction.sh"
      `,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.warnings).toEqual([]);
    expect(result.hooks[0]?.event).toBe('Eviction');
  });

  test('parses substrate / motivo / from_state / to_state / actor matcher fields', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `
        [[hooks]]
        event = "Eviction"
        command = "security-audit.sh"
        matcher = { substrate = "memory", motivo = "security", from_state = "active", to_state = "purged", actor = "hook" }
      `,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.warnings).toEqual([]);
    const h = result.hooks[0];
    if (h === undefined) throw new Error('missing hook');
    expect(h.matcher.substrate).toBe('memory');
    expect(h.matcher.motivo).toBe('security');
    expect(h.matcher.fromState).toBe('active'); // snake_case → camelCase
    expect(h.matcher.toState).toBe('purged');
    expect(h.matcher.actor).toBe('hook');
  });

  test('rejects empty-string matcher fields', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `
        [[hooks]]
        event = "Eviction"
        command = "x"
        matcher = { substrate = "" }
      `,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.hooks).toHaveLength(0);
    expect(result.warnings[0]?.kind).toBe('invalid_entry');
    expect(result.warnings[0]?.message).toContain('matcher.substrate');
  });

  test('rejects non-string matcher fields', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `
        [[hooks]]
        event = "Eviction"
        command = "x"
        matcher = { motivo = 42 }
      `,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.hooks).toHaveLength(0);
    expect(result.warnings[0]?.kind).toBe('invalid_entry');
    expect(result.warnings[0]?.message).toContain('matcher.motivo');
  });

  test('unknown matcher fields are silently ignored (forward-compat)', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `
        [[hooks]]
        event = "Eviction"
        command = "x"
        matcher = { substrate = "memory", future_field = "any" }
      `,
    );
    const result = resolveHookConfig({ enterprise: null, user: null, project: prj });
    expect(result.warnings).toEqual([]);
    expect(result.hooks[0]?.matcher.substrate).toBe('memory');
  });
});

describe('resolveHookConfig — slice 181', () => {
  test('PostToolUseFailure is a valid event', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `[[hooks]]
       event = "PostToolUseFailure"
       command = "notify-send 'tool failed'"`,
    );
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.event).toBe('PostToolUseFailure');
    expect(result.warnings).toEqual([]);
  });

  test('if field is parsed from TOML', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `[[hooks]]
       event = "PreToolUse"
       command = "block-dangerous.sh"
       matcher = { tool = "bash" }
       if = "Bash(rm *)"`,
    );
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.if).toBe('Bash(rm *)');
  });

  test('if must be non-empty string when present', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(
      prj,
      `[[hooks]]
       event = "PreToolUse"
       command = "x"
       if = ""`,
    );
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.hooks).toHaveLength(0);
    expect(result.warnings[0]?.kind).toBe('invalid_entry');
    expect(result.warnings[0]?.message).toContain('if must be a non-empty string');
  });

  test('disable_all_hooks top-level flag parsed (project layer)', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(prj, 'disable_all_hooks = true\n');
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.disableAllHooks).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('disable_all_hooks default false when absent', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(prj, `[[hooks]]\nevent = "Stop"\ncommand = "x"`);
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.disableAllHooks).toBe(false);
  });

  test("disable_all_hooks OR'd across layers (enterprise alone disables)", () => {
    const tmp = makeTmp();
    const ent = join(tmp, 'ent.toml');
    const usr = join(tmp, 'usr.toml');
    writeToml(ent, 'disable_all_hooks = true\n');
    writeToml(usr, `[[hooks]]\nevent = "Stop"\ncommand = "still-here"`);
    const result = resolveHookConfig({ enterprise: ent, user: usr, project: '/never' });
    expect(result.disableAllHooks).toBe(true);
    // Hooks still parsed (dispatcher honors the kill switch).
    expect(result.hooks).toHaveLength(1);
  });

  test("disable_all_hooks OR'd across layers (user alone disables)", () => {
    const tmp = makeTmp();
    const usr = join(tmp, 'usr.toml');
    writeToml(usr, 'disable_all_hooks = true\n');
    const result = resolveHookConfig({ enterprise: null, user: usr, project: '/never' });
    expect(result.disableAllHooks).toBe(true);
  });

  test('disable_all_hooks non-boolean produces warning and is ignored', () => {
    const tmp = makeTmp();
    const prj = join(tmp, 'hooks.toml');
    writeToml(prj, `disable_all_hooks = "true"\n`);
    const result = resolveHookConfig(paths({ project: prj }));
    expect(result.disableAllHooks).toBe(false);
    expect(result.warnings[0]?.kind).toBe('invalid_entry');
    expect(result.warnings[0]?.message).toContain('disable_all_hooks must be a boolean');
  });
});
