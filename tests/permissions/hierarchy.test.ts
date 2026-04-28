import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePolicy } from '../../src/permissions/hierarchy.ts';

let workdir: string;

const writeYaml = (path: string, content: string): void => {
  mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(path, content);
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-perm-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const projectFile = (relPath: string): string => join(workdir, relPath);

describe('resolvePolicy — discovery', () => {
  test('returns default policy when no layer files exist', () => {
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
    });
    expect(result.layers).toEqual([]);
    expect(result.policy.defaults.mode).toBe('strict');
    expect(result.policy.tools).toEqual({});
    expect(result.lockConflicts).toEqual([]);
  });

  test('loads project layer only when only project file exists', () => {
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: acceptEdits\n');
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
    });
    expect(result.layers.map((l) => l.layer)).toEqual(['project']);
    expect(result.policy.defaults.mode).toBe('acceptEdits');
  });

  test('loads enterprise + user + project layers in precedence order', () => {
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'defaults:\n  mode: bypass\n');
    writeFileSync(usr, 'defaults:\n  mode: acceptEdits\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: strict\n');

    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.layers.map((l) => l.layer)).toEqual(['enterprise', 'user', 'project']);
    // Project (lowest of the three) wins on a non-locked field.
    expect(result.policy.defaults.mode).toBe('strict');
  });

  test('session layer takes precedence over project when injected', () => {
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: strict\n');
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
      session: { defaults: { mode: 'bypass' }, tools: {} },
    });
    expect(result.layers.map((l) => l.layer)).toEqual(['project', 'session']);
    expect(result.policy.defaults.mode).toBe('bypass');
  });
});

describe('resolvePolicy — locked semantics', () => {
  test('enterprise locked defaults.mode prevents user override', () => {
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'defaults:\n  mode: strict\n  locked: true\n');
    writeFileSync(usr, 'defaults:\n  mode: bypass\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.policy.defaults.mode).toBe('strict');
    expect(result.lockConflicts).toEqual([
      { section: 'defaults.mode', lockedBy: 'enterprise', attemptedBy: 'user' },
    ]);
  });

  test('enterprise locked tools.bash prevents user/project override', () => {
    const ent = projectFile('ent.yaml');
    writeFileSync(ent, 'tools:\n  bash:\n    deny:\n      - "rm -rf /*"\n    locked: true\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "rm -rf /*"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: null });
    // Enterprise wins; project's allow attempt rejected.
    expect(result.policy.tools.bash?.deny).toEqual(['rm -rf /*']);
    expect(result.policy.tools.bash?.allow).toBeUndefined();
    expect(result.lockConflicts).toEqual([
      { section: 'tools.bash', lockedBy: 'enterprise', attemptedBy: 'project' },
    ]);
  });

  test('user-locked section blocks project but not the locking layer itself', () => {
    const usr = projectFile('usr.yaml');
    writeFileSync(
      usr,
      'tools:\n  write_file:\n    deny_paths:\n      - "**/.env"\n    locked: true\n',
    );
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  write_file:\n    allow_paths:\n      - "**/.env"\n',
    );
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: usr,
    });
    expect(result.policy.tools.write_file?.deny_paths).toEqual(['**/.env']);
    expect(result.policy.tools.write_file?.allow_paths).toBeUndefined();
    expect(result.lockConflicts).toEqual([
      { section: 'tools.write_file', lockedBy: 'user', attemptedBy: 'project' },
    ]);
  });

  test('locked sections produce one conflict per attempting layer', () => {
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'tools:\n  bash:\n    deny:\n      - "rm *"\n    locked: true\n');
    writeFileSync(usr, 'tools:\n  bash:\n    allow:\n      - "git *"\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.lockConflicts).toEqual([
      { section: 'tools.bash', lockedBy: 'enterprise', attemptedBy: 'user' },
      { section: 'tools.bash', lockedBy: 'enterprise', attemptedBy: 'project' },
    ]);
  });

  test('non-locked sections REPLACE rather than extend', () => {
    const ent = projectFile('ent.yaml');
    writeFileSync(ent, 'tools:\n  bash:\n    allow:\n      - "git *"\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: null });
    // Project's allow fully replaces enterprise's allow (no merge).
    expect(result.policy.tools.bash?.allow).toEqual(['ls *']);
    expect(result.lockConflicts).toEqual([]);
  });

  test('lower-layer same-value mode does NOT generate a spurious conflict on locked defaults', () => {
    // Enterprise locks mode=strict; user happens to also set mode=strict.
    // No conflict — we only flag when the lower layer attempted to
    // change the value, not when it agreed.
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'defaults:\n  mode: strict\n  locked: true\n');
    writeFileSync(usr, 'defaults:\n  mode: strict\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.lockConflicts).toEqual([]);
  });

  test('lower layer that omits defaults entirely does NOT trip phantom conflict', () => {
    // Regression: parsePolicy used to inject mode='strict' as a
    // default when the YAML had no `defaults` section, which then
    // looked indistinguishable from "user explicitly said strict".
    // With locked enterprise mode != 'strict', the merge would log
    // a conflict against the silent user. Fix preserves
    // mode=undefined when the layer didn't set it.
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'defaults:\n  mode: bypass\n  locked: true\n');
    // user file has only tools, no defaults section.
    writeFileSync(usr, 'tools:\n  bash:\n    allow:\n      - "ls *"\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.lockConflicts).toEqual([]);
    expect(result.policy.defaults.mode).toBe('bypass');
    expect(result.policy.tools.bash?.allow).toEqual(['ls *']);
  });
});
