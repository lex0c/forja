import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderExplainPermissions,
  runExplainPermissionsCli,
} from '../../src/cli/explain-permissions.ts';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-explain-perms-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const writeYaml = (path: string, content: string): void => {
  mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(path, content);
};

describe('renderExplainPermissions', () => {
  test('empty policy with no layers surfaces the no-files notice', () => {
    const lines = renderExplainPermissions(
      { defaults: { mode: 'strict' }, tools: {} },
      { defaults: 'default' },
      [],
    );
    const text = lines.join('\n');
    expect(text).toContain('layers: (none');
    expect(text).toContain('mode=strict [from built-in default]');
    expect(text).toContain('every gated tool will be denied');
  });

  test('renders mode + section with layer attribution', () => {
    const lines = renderExplainPermissions(
      {
        defaults: { mode: 'acceptEdits' },
        tools: { bash: { allow: ['npm test*'], deny: ['rm -rf *'] } },
      },
      { defaults: 'project', bash: 'project' },
      [{ layer: 'project', path: '/r/.agent/permissions.yaml' }],
    );
    const text = lines.join('\n');
    // Layer header lists the loaded file paths.
    expect(text).toContain('- project /r/.agent/permissions.yaml');
    // Mode line carries the writer.
    expect(text).toContain('mode=acceptEdits [from project policy]');
    // Section block has the layer hint inline.
    expect(text).toContain('bash: [from project policy]');
    expect(text).toContain("allow: 'npm test*'");
    expect(text).toContain("deny: 'rm -rf *'");
  });

  test('locked enterprise section renders "(locked)" qualifier', () => {
    const lines = renderExplainPermissions(
      {
        defaults: { mode: 'strict', locked: true },
        tools: { bash: { deny: ['*'], locked: true } },
      },
      { defaults: 'enterprise', bash: 'enterprise' },
      [
        { layer: 'enterprise', path: '/etc/agent/permissions.yaml' },
        { layer: 'project', path: '/r/.agent/permissions.yaml' },
      ],
    );
    const text = lines.join('\n');
    // Mode lock + section lock both surface.
    expect(text).toContain('mode=strict [from enterprise policy] (locked)');
    expect(text).toContain('bash: [from enterprise policy] (locked)');
  });

  test('multi-section policy with mixed-layer provenance', () => {
    const lines = renderExplainPermissions(
      {
        defaults: { mode: 'strict' },
        tools: {
          bash: { allow: ['ls *'] },
          read_file: { allow_paths: ['src/**'] },
          write_file: { allow_paths: ['src/**'] },
        },
      },
      {
        defaults: 'enterprise',
        bash: 'enterprise',
        read_file: 'user',
        write_file: 'project',
      },
      [{ layer: 'enterprise' }, { layer: 'user' }, { layer: 'project' }],
    );
    const text = lines.join('\n');
    expect(text).toContain('bash: [from enterprise policy]');
    expect(text).toContain('read_file: [from user policy]');
    expect(text).toContain('write_file: [from project policy]');
  });

  test('elides large rule lists with a count', () => {
    const lines = renderExplainPermissions(
      {
        defaults: { mode: 'strict' },
        tools: {
          bash: {
            allow: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
          },
        },
      },
      { defaults: 'project', bash: 'project' },
      [{ layer: 'project' }],
    );
    expect(lines.some((l) => /allow:.*12 entries/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("'a'"))).toBe(false);
  });

  test('strict mode with sections appends the default-deny footer', () => {
    const lines = renderExplainPermissions(
      {
        defaults: { mode: 'strict' },
        tools: { bash: { allow: ['ls *'] } },
      },
      { defaults: 'project', bash: 'project' },
      [{ layer: 'project' }],
    );
    const text = lines.join('\n');
    expect(text).toContain('unlisted tools default-deny in strict mode');
  });

  test('acceptEdits mode with no sections does not panic-warn', () => {
    const lines = renderExplainPermissions(
      { defaults: { mode: 'acceptEdits' }, tools: {} },
      { defaults: 'project' },
      [{ layer: 'project' }],
    );
    const text = lines.join('\n');
    expect(text).toContain('no tool sections defined');
    expect(text).not.toContain('every gated tool will be denied');
  });
});

describe('runExplainPermissionsCli', () => {
  test('empty cwd → resolves to default policy + prints to out', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runExplainPermissionsCli({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('layers: (none');
    expect(text).toContain('mode=strict');
    expect(err.join('')).toBe('');
  });

  test('project YAML loaded → output names the file path', async () => {
    writeYaml(
      join(workdir, '.agent/permissions.yaml'),
      'defaults:\n  mode: acceptEdits\ntools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await runExplainPermissionsCli({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('mode=acceptEdits [from project policy]');
    expect(text).toContain('bash: [from project policy]');
    expect(text).toContain('.agent/permissions.yaml');
    expect(text).toContain("'ls *'");
  });

  test('lock conflict surfaces on stderr (warning-grade, not failure)', async () => {
    // Enterprise locks bash; project tries to override → conflict
    // logged. The merged policy is still valid so exit code is 0,
    // but operators auditing the policy benefit from seeing the
    // rejected override.
    const ent = join(workdir, 'ent.yaml');
    writeFileSync(ent, 'tools:\n  bash:\n    deny:\n      - "*"\n    locked: true\n');
    writeYaml(
      join(workdir, '.agent/permissions.yaml'),
      'tools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await runExplainPermissionsCli({
      cwd: workdir,
      enterprisePath: ent,
      userPath: null,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(err.join('')).toContain('lock conflicts');
    expect(err.join('')).toContain('tools.bash');
    expect(err.join('')).toContain('locked by enterprise');
    expect(err.join('')).toContain('override attempt by project');
  });

  test('malformed YAML surfaces as a non-zero exit + stderr message', async () => {
    writeYaml(join(workdir, '.agent/permissions.yaml'), 'defaults:\n  mode: bogus\n');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runExplainPermissionsCli({
      cwd: workdir,
      enterprisePath: null,
      userPath: null,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('failed to resolve permission policy');
  });
});
