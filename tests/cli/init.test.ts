import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.ts';
import { loadPolicyFromString } from '../../src/permissions/index.ts';

describe('runInit', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes .agent/permissions.yaml with strict mode by default', () => {
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(0);
    const target = join(cwd, '.agent', 'permissions.yaml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('mode: strict');
    expect(body).toContain('bash:');
    expect(body).toContain('read_file:');
  });

  test('written template parses as a valid Policy', () => {
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const body = readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8');
    // Round-trip: the same loader the engine uses must accept the
    // template. Catches divergence between template syntax and
    // schema (e.g. a future deny rule format change that would
    // make `agent init` produce unparseable output).
    const policy = loadPolicyFromString(body);
    expect(policy.defaults.mode).toBe('strict');
    // Bash carries a conservative read-only allowlist (git
    // inspection, ls, version probes, pwd/whoami) plus the
    // catch-all confirm so anything not in the allow list still
    // pops a modal, plus the deny list for catastrophic patterns.
    // The allow list cuts modal fatigue on common dev-loop ops
    // without admitting writes.
    const allow = policy.tools.bash?.allow ?? [];
    expect(allow.length).toBeGreaterThan(0);
    // A few load-bearing entries: removal would silently revert
    // the modal-fatigue improvement.
    expect(allow).toContain('git status');
    expect(allow).toContain('pwd');
    expect(allow).toContain('git --version');
    // Allow MUST NOT contain commands that read arbitrary file
    // contents (cat/head/tail/rg) — they can target .env or
    // other secrets and bash doesn't honor fs.read's deny_paths.
    expect(allow.some((r) => r === 'cat *' || r.startsWith('cat '))).toBe(false);
    expect(allow.some((r) => r === 'head *' || r.startsWith('head '))).toBe(false);
    expect(allow.some((r) => r === 'tail *' || r.startsWith('tail '))).toBe(false);
    expect(allow.some((r) => r === 'rg*' || r.startsWith('rg '))).toBe(false);
    // Allow MUST NOT contain commands that mutate (git branch -d,
    // git commit, etc). git branch* would admit deletion, so it's
    // out of scope.
    expect(allow.some((r) => r === 'git branch*' || r === 'git branch')).toBe(false);
    expect(policy.tools.bash?.confirm).toEqual(['*']);
    expect(policy.tools.bash?.deny?.length ?? 0).toBeGreaterThan(0);
    expect(policy.tools.read_file?.deny_paths?.length ?? 0).toBeGreaterThan(0);
  });

  test('--mode acceptEdits emits matching defaults', () => {
    runInit({ cwd, force: false, mode: 'acceptEdits', out, err });
    const body = readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8');
    expect(body).toContain('mode: acceptEdits');
    const policy = loadPolicyFromString(body);
    expect(policy.defaults.mode).toBe('acceptEdits');
  });

  test('refuses when file exists and --force is false', () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const original = readFileSync(target, 'utf8');
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('already exists');
    expect(errBuf.join('')).toContain('--force');
    // File must be untouched on refuse — operator's hand edits
    // survive an accidental re-run.
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  test('--force overwrites existing file', () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, force: false, mode: 'strict', out, err });
    writeFileSync(target, '# operator hand edit\n', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, force: true, mode: 'strict', out, err });
    expect(code).toBe(0);
    const body = readFileSync(target, 'utf8');
    expect(body).not.toContain('operator hand edit');
    expect(body).toContain('mode: strict');
  });

  test('creates .agent/ directory if missing', () => {
    // mkdtempSync gives us a clean cwd with no .agent/ subtree —
    // the handler must mkdir -p before writing.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    const code = runInit({ cwd, force: false, mode: 'strict', out, err });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent'))).toBe(true);
  });

  test('success message points at next step', () => {
    runInit({ cwd, force: false, mode: 'strict', out, err });
    const all = outBuf.join('');
    expect(all).toContain('wrote');
    expect(all).toContain("run 'agent'");
  });
});

describe('runInit --playbooks', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  // Synthetic fixture so tests do not depend on the full canonical
  // bundle. Keeps the test runtime stable and the assertions
  // surgical (expected counts, expected filenames). The handler is
  // agnostic to which set it consumes.
  const fixture = [
    {
      filename: 'fixture-a.md',
      content: `---
name: fixture-a
description: Stub A
tools: []
budget: { max_steps: 1, max_cost_usd: 0.01 }
---
Body A.`,
    },
    {
      filename: 'fixture-b.md',
      content: `---
name: fixture-b
description: Stub B
tools: []
budget: { max_steps: 1, max_cost_usd: 0.01 }
---
Body B.`,
    },
  ];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-playbooks-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('copies every fixture into .agent/agents/ on a clean cwd', () => {
    const code = runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent', 'agents', 'fixture-a.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'agents', 'fixture-b.md'))).toBe(true);
    expect(readFileSync(join(cwd, '.agent', 'agents', 'fixture-a.md'), 'utf8')).toContain(
      'name: fixture-a',
    );
    const summary = outBuf.join('');
    expect(summary).toContain('2 copied, 0 overwritten, 0 skipped');
    expect(errBuf.join('')).toBe('');
  });

  test('skips existing playbook files without --force', () => {
    // First run lays the canonical content down.
    runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    // Author hand-edits one of the targets. Re-running without
    // --force must NOT clobber their change. The other file
    // already exists from the first run and gets skipped too.
    const dir = join(cwd, '.agent', 'agents');
    const initialContent = '# pre-existing edit';
    writeFileSync(join(dir, 'fixture-a.md'), initialContent, { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'fixture-a.md'), 'utf8')).toBe(initialContent);
    const summary = outBuf.join('');
    expect(summary).toContain('0 copied, 0 overwritten, 2 skipped');
  });

  test('--force overwrites existing playbooks', () => {
    const dir = join(cwd, '.agent', 'agents');
    runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    writeFileSync(join(dir, 'fixture-a.md'), '# hand edit', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      force: true,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'fixture-a.md'), 'utf8')).toContain('name: fixture-a');
    const summary = outBuf.join('');
    expect(summary).toContain('0 copied, 2 overwritten, 0 skipped');
  });

  test('creates .agent/agents/ if missing', () => {
    expect(existsSync(join(cwd, '.agent', 'agents'))).toBe(false);
    const code = runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent', 'agents'))).toBe(true);
  });

  test('does NOT touch .agent/permissions.yaml on the playbooks path', () => {
    runInit({
      cwd,
      force: false,
      mode: 'strict',
      playbooks: true,
      playbookSource: fixture,
      out,
      err,
    });
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(false);
  });

  test('every bundled canonical playbook loads cleanly through the loader', async () => {
    // Sanity check on the production asset bundle. If a future
    // edit to one of the canonical .md files breaks frontmatter,
    // this test catches it before the binary ships. Goes through
    // the same `loadSubagentFromString` that the runtime uses.
    const { CANONICAL_PLAYBOOKS } = await import('../../src/cli/init-playbooks/index.ts');
    const { loadSubagentFromString } = await import('../../src/subagents/index.ts');
    expect(CANONICAL_PLAYBOOKS.length).toBe(10);
    for (const playbook of CANONICAL_PLAYBOOKS) {
      const def = loadSubagentFromString(
        playbook.content,
        'project',
        `bundled/${playbook.filename}`,
      );
      // Every canonical playbook MUST have whenToUse + slash —
      // those are the operator surfaces. A bundled playbook without
      // either is a regression in the asset author's intent.
      expect(def.whenToUse).toBeDefined();
      expect(def.slash).toBeDefined();
      // meta should be empty: the typed surface covers every
      // PLAYBOOKS.md §1.1 field, so a leftover key signals a typo
      // in the .md (e.g., `outputs_schema:` instead of `output_schema:`).
      expect(def.meta).toEqual({});
    }
  });
});
