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

  test('skips user layer when userPolicyPath returns null (no absolute home)', () => {
    // Regression: when HOME is unset the user path used to fall
    // through to a relative `.config/agent/permissions.yaml` and
    // existsSync would check it against the cwd. A repo with such
    // a file could masquerade as the user layer and override
    // project-local policy. Resolver must skip when path is null.
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: acceptEdits\n');
    // Inject env with no HOME, no XDG — userPolicyPath returns null.
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      env: {},
    });
    expect(result.layers.map((l) => l.layer)).toEqual(['project']);
    expect(result.policy.defaults.mode).toBe('acceptEdits');
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

  test('locked-only layer (no mode) freezes the inherited mode and blocks lower overrides', async () => {
    // Regression: defaults.locked used to activate only inside the
    // branch that processed mode changes. A layer with
    // `defaults: { locked: true }` and no mode field silently
    // failed to lock anything, letting lower layers override
    // freely with no conflict reported. Lock must apply
    // independently of whether the same layer also set mode.
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(ent, 'defaults:\n  mode: bypass\n');
    // user freezes whatever mode it inherited (bypass), no mode field.
    writeFileSync(usr, 'defaults:\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: strict\n');

    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    // Inherited bypass survives; project's strict attempt is
    // dropped and recorded.
    expect(result.policy.defaults.mode).toBe('bypass');
    expect(result.policy.defaults.locked).toBe(true);
    expect(result.lockConflicts).toEqual([
      { section: 'defaults.mode', lockedBy: 'user', attemptedBy: 'project' },
    ]);
  });

  test('locked-only layer with no inherited mode locks the resolver default (strict)', async () => {
    // Edge case: nobody set mode anywhere; the FIRST locked layer
    // freezes the eventual default 'strict' applied at emit.
    const usr = projectFile('usr.yaml');
    writeFileSync(usr, 'defaults:\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: bypass\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    // Project's bypass attempt is rejected; merged mode falls
    // back to the resolver's strict default at emit.
    expect(result.policy.defaults.mode).toBe('strict');
    expect(result.lockConflicts).toEqual([
      { section: 'defaults.mode', lockedBy: 'user', attemptedBy: 'project' },
    ]);
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

describe('resolvePolicy — section provenance', () => {
  test('empty layers (no files) → defaults provenance is "default"', () => {
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: null });
    expect(result.provenance).toEqual({ defaults: 'default' });
  });

  test('single project layer writes per-section provenance', () => {
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'defaults:\n  mode: acceptEdits\ntools:\n  bash:\n    allow:\n      - "ls *"\n  read_file:\n    allow_paths:\n      - "src/**"\n',
    );
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
    });
    expect(result.provenance).toEqual({
      defaults: 'project',
      bash: 'project',
      read_file: 'project',
    });
  });

  test('multi-layer merge tracks last-writer per section', () => {
    // enterprise locks defaults.mode + writes bash. user writes
    // read_file. project writes write_file. Provenance reflects
    // the per-section last writer regardless of layer precedence
    // for OTHER sections.
    const ent = projectFile('ent.yaml');
    const usr = projectFile('usr.yaml');
    writeFileSync(
      ent,
      'defaults:\n  mode: strict\n  locked: true\ntools:\n  bash:\n    deny:\n      - "rm -rf *"\n',
    );
    writeFileSync(usr, 'tools:\n  read_file:\n    allow_paths:\n      - "src/**"\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  write_file:\n    allow_paths:\n      - "src/**"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.provenance).toEqual({
      defaults: 'enterprise',
      bash: 'enterprise',
      read_file: 'user',
      write_file: 'project',
    });
  });

  test('lower layer overriding a non-locked section updates provenance', () => {
    // user writes bash, project overrides bash. Final provenance
    // for bash points at project (last writer wins for non-locked
    // sections). The /perms why renderer shows the project YAML
    // as the location to edit, which matches the user's
    // expectation since the project rule is what's active.
    const usr = projectFile('usr.yaml');
    writeFileSync(usr, 'tools:\n  bash:\n    allow:\n      - "ls *"\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  bash:\n    deny:\n      - "rm *"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.tools.bash?.deny).toEqual(['rm *']);
    expect(result.provenance.bash).toBe('project');
  });

  test('locked section keeps provenance at the locking layer (lower-layer override rejected)', () => {
    // enterprise locks bash; project tries to override and the
    // override is dropped (with conflict logged). Provenance for
    // bash stays at enterprise — the active rule lives in
    // enterprise YAML.
    const ent = projectFile('ent.yaml');
    writeFileSync(ent, 'tools:\n  bash:\n    deny:\n      - "*"\n    locked: true\n');
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: null });
    expect(result.lockConflicts).toHaveLength(1);
    expect(result.provenance.bash).toBe('enterprise');
  });

  test('session-layer policy (runtime override) gets tracked as session', () => {
    const result = resolvePolicy({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
      session: {
        defaults: { mode: 'bypass' },
        tools: { bash: { allow: ['*'] } },
      },
    });
    expect(result.provenance).toEqual({
      defaults: 'session',
      bash: 'session',
    });
  });

  test('layer that sets locked:true without mode keeps prior writer for defaults', () => {
    // user writes mode='acceptEdits'. project sets locked:true
    // without changing mode. defaults.mode came from user;
    // provenance points at user (the actual last writer of
    // mode), not at project (which only set the lock).
    const usr = projectFile('usr.yaml');
    writeFileSync(usr, 'defaults:\n  mode: acceptEdits\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  locked: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.defaults.mode).toBe('acceptEdits');
    expect(result.policy.defaults.locked).toBe(true);
    expect(result.provenance.defaults).toBe('user');
  });
});

describe('resolvePolicy — sandbox section (§6.5, slice 23)', () => {
  test('absent sandbox across all layers leaves policy.sandbox undefined', () => {
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: null });
    expect(result.policy.sandbox).toBeUndefined();
    expect(result.provenance.sandbox).toBeUndefined();
  });

  test('project-only sandbox surfaces in merged policy + provenance', () => {
    writeYaml(
      projectFile('.agent/permissions.yaml'),
      'sandbox:\n  required: true\n  host_allowed: true\n',
    );
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: null });
    expect(result.policy.sandbox).toEqual({ required: true, hostAllowed: true });
    expect(result.provenance.sandbox).toBe('project');
  });

  test('field-by-field last-writer wins across layers', () => {
    // user file sets required only; project file sets host_allowed only.
    // Merged result has both — project is the LAST writer (provenance).
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  host_allowed: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox).toEqual({ required: true, hostAllowed: true });
    expect(result.provenance.sandbox).toBe('project');
  });

  test('project explicitly overrides user', () => {
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  required: false\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox?.required).toBe(false);
    expect(result.provenance.sandbox).toBe('project');
  });

  test('a layer that omits sandbox does not move the writer trail', () => {
    // user sets sandbox; project is silent → provenance stays at user.
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'defaults:\n  mode: bypass\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox?.required).toBe(true);
    expect(result.provenance.sandbox).toBe('user');
  });
});

describe('resolvePolicy — sandbox section-level lock (§6.5, slice 34)', () => {
  test('user lock + project change to required → lockConflict, locked value preserved', () => {
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  required: false\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox).toEqual({ required: true, locked: true });
    expect(result.lockConflicts).toEqual([
      { section: 'sandbox', lockedBy: 'user', attemptedBy: 'project' },
    ]);
    // Provenance stays at the locking layer — the project layer's
    // change was discarded, so it did NOT write the section.
    expect(result.provenance.sandbox).toBe('user');
  });

  test('user lock + project re-asserts SAME required → silent (no conflict)', () => {
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  required: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox).toEqual({ required: true, locked: true });
    expect(result.lockConflicts).toEqual([]);
  });

  test('user lock + project change to host_allowed → lockConflict', () => {
    // Lock applies to BOTH fields, not just `required`. A project
    // attempting to flip `host_allowed` is also discarded.
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  host_allowed: false\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  host_allowed: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox).toEqual({ hostAllowed: false, locked: true });
    expect(result.lockConflicts).toEqual([
      { section: 'sandbox', lockedBy: 'user', attemptedBy: 'project' },
    ]);
  });

  test('lock-only layer (no field values) still freezes lower layers', () => {
    // User sets locked: true with no `required` / `host_allowed`.
    // Project's attempt to set `required` should conflict — even
    // though the locking layer didn't set any field value, the
    // INHERITED state (undefined → bootstrap default) is what's
    // frozen.
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  locked: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  required: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    // `required` stays undefined (no layer wrote it); the lock alone
    // surfaced in the merged sandbox.
    expect(result.policy.sandbox).toEqual({ locked: true });
    expect(result.lockConflicts).toEqual([
      { section: 'sandbox', lockedBy: 'user', attemptedBy: 'project' },
    ]);
    // The locking layer counts as the writer for provenance.
    expect(result.provenance.sandbox).toBe('user');
  });

  test('enterprise lock + user change + project change → both lower layers conflict', () => {
    const ent = join(workdir, 'enterprise.yaml');
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(ent, 'sandbox:\n  required: true\n  locked: true\n');
    writeYaml(usr, 'sandbox:\n  required: false\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  host_allowed: true\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: ent, userPath: usr });
    expect(result.policy.sandbox).toEqual({ required: true, locked: true });
    expect(result.lockConflicts).toEqual([
      { section: 'sandbox', lockedBy: 'enterprise', attemptedBy: 'user' },
      { section: 'sandbox', lockedBy: 'enterprise', attemptedBy: 'project' },
    ]);
  });

  test('no lock → field changes propagate normally (slice 23 baseline preserved)', () => {
    // Regression guard: making sure the lock path doesn't break the
    // unlocked case. user sets required=true; project flips to false
    // without any lock → project wins, no conflict.
    const usr = join(workdir, 'user-policy.yaml');
    writeYaml(usr, 'sandbox:\n  required: true\n');
    writeYaml(projectFile('.agent/permissions.yaml'), 'sandbox:\n  required: false\n');
    const result = resolvePolicy({ cwd: workdir, enterprisePath: null, userPath: usr });
    expect(result.policy.sandbox).toEqual({ required: false });
    expect(result.lockConflicts).toEqual([]);
    expect(result.provenance.sandbox).toBe('project');
  });
});
