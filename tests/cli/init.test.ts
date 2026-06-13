import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.ts';
import { loadPolicyFromString } from '../../src/permissions/index.ts';

// Synthetic playbook fixture used everywhere a test exercises the
// playbooks step. Keeps test runtime stable and assertions surgical
// (expected counts, expected filenames) without depending on the
// full 10-entry canonical bundle. The orchestrator is agnostic to
// which set it consumes.
const FIXTURE_PLAYBOOKS = [
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

// Synthetic skill fixture — same role as FIXTURE_PLAYBOOKS for the
// skills step: surgical counts without depending on the 15-entry
// canonical catalog.
const FIXTURE_SKILLS = [
  {
    filename: 'fixture-skill-a.md',
    content: `---
name: fixture-skill-a
description: Stub skill A
---
Body A.
`,
  },
  {
    filename: 'fixture-skill-b.md',
    content: `---
name: fixture-skill-b
description: Stub skill B
---
Body B.
`,
  },
];

describe('runInit — permissions step', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-perm-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes .agent/permissions.yaml with strict mode by default', () => {
    const code = runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    expect(code).toBe(0);
    const target = join(cwd, '.agent', 'permissions.yaml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('mode: strict');
    expect(body).toContain('bash:');
    expect(body).toContain('read_file:');
  });

  test('written template parses as a valid Policy', () => {
    runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
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
    const allow = policy.tools.bash?.allow ?? [];
    expect(allow.length).toBeGreaterThan(0);
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
    // Allow MUST NOT admit mutating git ops (branch deletion,
    // commits, etc).
    expect(allow.some((r) => r === 'git branch*' || r === 'git branch')).toBe(false);
    expect(policy.tools.bash?.confirm).toEqual(['*']);
    expect(policy.tools.bash?.deny?.length ?? 0).toBeGreaterThan(0);
    expect(policy.tools.read_file?.deny_paths?.length ?? 0).toBeGreaterThan(0);
  });

  test('--mode acceptEdits emits matching defaults', () => {
    runInit({ cwd, mode: 'acceptEdits', only: ['permissions'], out, err });
    const body = readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8');
    expect(body).toContain('mode: acceptEdits');
    const policy = loadPolicyFromString(body);
    expect(policy.defaults.mode).toBe('acceptEdits');
  });

  test('skips existing file when not forced (idempotent re-run)', () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    const original = readFileSync(target, 'utf8');
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    expect(code).toBe(0);
    // File untouched on re-run — the operator's hand edits survive
    // a re-invocation. This is the spec promise behind the
    // "idempotent per file" claim in AGENTIC_CLI §2.1.
    expect(readFileSync(target, 'utf8')).toBe(original);
    const all = outBuf.join('');
    expect(all).toContain('skip');
    expect(all).toContain('1 skipped');
  });

  test("--force='all' overwrites the existing file", () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    writeFileSync(target, '# operator hand edit\n', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['permissions'],
      force: 'all',
      out,
      err,
    });
    expect(code).toBe(0);
    const body = readFileSync(target, 'utf8');
    expect(body).not.toContain('operator hand edit');
    expect(body).toContain('mode: strict');
    expect(outBuf.join('')).toContain('1 overwritten');
  });

  test("--force=['permissions'] overwrites only the permissions file", () => {
    const target = join(cwd, '.agent', 'permissions.yaml');
    runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    writeFileSync(target, '# operator hand edit\n', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['permissions'],
      force: ['permissions'],
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('mode: strict');
  });

  test('creates .agent/ directory if missing', () => {
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    const code = runInit({ cwd, mode: 'strict', only: ['permissions'], out, err });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent'))).toBe(true);
  });
});

describe('runInit — gitignore step', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-gitignore-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes default .agent/.gitignore on clean cwd', () => {
    const code = runInit({ cwd, mode: 'strict', only: ['gitignore'], out, err });
    expect(code).toBe(0);
    const target = join(cwd, '.agent', '.gitignore');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    // Pins the default content surface — sessions.db,
    // sessions.db-*, traces/, checkpoints/, memory/local/, *.log
    // (per MEMORY.md §2.5).
    expect(body).toContain('sessions.db');
    expect(body).toContain('sessions.db-*');
    expect(body).toContain('traces/');
    expect(body).toContain('checkpoints/');
    expect(body).toContain('memory/local/');
    expect(body).toContain('*.log');
  });

  test('never overwrites an existing .agent/.gitignore (operator-owned)', () => {
    const dir = join(cwd, '.agent');
    const target = join(dir, '.gitignore');
    runInit({ cwd, mode: 'strict', only: ['gitignore'], out, err });
    const operatorEdit = '# operator owns this file\nsomething-custom\n';
    writeFileSync(target, operatorEdit, { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    // Even with --force='all', the gitignore step is supposed to
    // be a no-op on existing files. This pins the spec promise
    // (MEMORY.md §2.5) at the orchestrator layer.
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['gitignore'],
      force: 'all',
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(operatorEdit);
    expect(outBuf.join('')).toContain('skip');
  });

  test('regeneration path: delete + re-run materializes the default again', () => {
    const target = join(cwd, '.agent', '.gitignore');
    runInit({ cwd, mode: 'strict', only: ['gitignore'], out, err });
    rmSync(target);
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, mode: 'strict', only: ['gitignore'], out, err });
    expect(code).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('sessions.db');
  });
});

describe('runInit — config step', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-config-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes .agent/config.toml with active values for all four sections', () => {
    const code = runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    expect(code).toBe(0);
    const target = join(cwd, '.agent', 'config.toml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    // Rich-scaffold posture (AGENTIC_CLI.md §2.1.1, post-rewrite):
    // the file ships with literal values from the code defaults so
    // the operator opens it and sees the running config in front of
    // them. Section/value-level pins live in the template's own test
    // (init-config-template.test.ts); here we just confirm the
    // orchestrator wired the right renderer and produced parseable
    // TOML with all three expected sections.
    const parsed = Bun.TOML.parse(body) as Record<string, unknown>;
    expect(parsed.providers).toBeDefined();
    expect(parsed.budget).toBeDefined();
    expect(parsed.memory).toBeDefined();
  });

  test('scaffolded config contains NO comments (slash round-trip would kill them)', () => {
    runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    const body = readFileSync(join(cwd, '.agent', 'config.toml'), 'utf8');
    // `/memory governance enable|disable` rewrites this file via
    // TOML round-trip and Bun.TOML.parse drops comments. The
    // scaffold MUST NOT emit any `#`-prefixed line or the file's
    // initial documentation would silently vanish on the first
    // governance toggle.
    for (const line of body.split('\n').filter((l) => l.length > 0)) {
      expect(line).not.toMatch(/^\s*#/);
    }
  });

  test('skips existing config.toml when not forced', () => {
    const target = join(cwd, '.agent', 'config.toml');
    runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    const operatorEdit = '[memory]\nverify_semantic_llm = false\n';
    writeFileSync(target, operatorEdit, { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    expect(code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(operatorEdit);
  });

  test("--force=['config'] overwrites the config file", () => {
    const target = join(cwd, '.agent', 'config.toml');
    runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    writeFileSync(target, '# operator edit\n', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['config'],
      force: ['config'],
      out,
      err,
    });
    expect(code).toBe(0);
    // Force overwrites — operator's `# operator edit\n` is gone,
    // replaced by the rich scaffold's [providers] / [budget] /
    // [memory] sections.
    const body = readFileSync(target, 'utf8');
    expect(body).not.toContain('operator edit');
    expect(body).toContain('[budget]');
    expect(body).toContain('[providers]');
  });
});

describe('runInit — playbooks step', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

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
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
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
    expect(summary).toContain('2 wrote');
    expect(errBuf.join('')).toBe('');
  });

  test('skips existing playbook files without --force', () => {
    runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    const dir = join(cwd, '.agent', 'agents');
    const initialContent = '# pre-existing edit';
    writeFileSync(join(dir, 'fixture-a.md'), initialContent, { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'fixture-a.md'), 'utf8')).toBe(initialContent);
    expect(outBuf.join('')).toContain('2 skipped');
  });

  test("--force=['playbooks'] overwrites existing playbooks", () => {
    const dir = join(cwd, '.agent', 'agents');
    runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    writeFileSync(join(dir, 'fixture-a.md'), '# hand edit', { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      force: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'fixture-a.md'), 'utf8')).toContain('name: fixture-a');
    expect(outBuf.join('')).toContain('2 overwritten');
  });

  test('--force=all (no playbooks in only) does NOT touch playbooks', () => {
    // Selectivity check: --force scoped to its step. Asking for
    // --only=permissions with --force=all overwrites permissions
    // but never reaches the playbooks loop, so an existing
    // playbook with operator edits stays put.
    runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    const playbookTarget = join(cwd, '.agent', 'agents', 'fixture-a.md');
    const operatorEdit = '# operator owns this playbook';
    writeFileSync(playbookTarget, operatorEdit, { encoding: 'utf8' });
    outBuf = [];
    errBuf = [];
    runInit({ cwd, mode: 'strict', only: ['permissions'], force: 'all', out, err });
    expect(readFileSync(playbookTarget, 'utf8')).toBe(operatorEdit);
  });

  test('creates .agent/agents/ if missing', () => {
    expect(existsSync(join(cwd, '.agent', 'agents'))).toBe(false);
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent', 'agents'))).toBe(true);
  });

  test('mid-loop write failure aborts and preserves prior writes', () => {
    // Mid-loop failure scenario: entries 1 and 2 write successfully,
    // entry 3 has a filename pointing at a non-existent subdir so
    // its write fails with ENOENT (we deliberately don't mkdir the
    // subdir), entry 4 is never reached (scaffolder early-returns
    // on the first failure). Pins: prior writes survive, exit 1,
    // err carries the diagnostic, subsequent entries don't appear,
    // and the atomicWrite helper leaves no .tmp orphan on the
    // failure path.
    const partialFixture = [
      { filename: 'good-1.md', content: '---\nname: a\n---\n' },
      { filename: 'good-2.md', content: '---\nname: b\n---\n' },
      // ENOENT trigger: parent `missing-subdir/` is not pre-created,
      // and the scaffolder only mkdirs `.agent/agents/`, not nested
      // paths inside filenames.
      { filename: 'missing-subdir/bad.md', content: '---\nname: c\n---\n' },
      { filename: 'never-written.md', content: '---\nname: d\n---\n' },
    ];
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['playbooks'],
      playbookSource: partialFixture,
      out,
      err,
    });
    expect(code).toBe(1);
    // First two survive at their final paths.
    expect(existsSync(join(cwd, '.agent', 'agents', 'good-1.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'agents', 'good-2.md'))).toBe(true);
    // Failed entry: no file at the target subpath, no leaked temp
    // sibling either (atomicWrite cleans up on write-throw).
    expect(existsSync(join(cwd, '.agent', 'agents', 'missing-subdir'))).toBe(false);
    // Entry after the failure was never attempted — scaffolder
    // early-returns the moment any single playbook fails.
    expect(existsSync(join(cwd, '.agent', 'agents', 'never-written.md'))).toBe(false);
    // Operator-visible diagnostic on stderr.
    expect(errBuf.join('')).toContain('failed to write');
    expect(errBuf.join('')).toContain('missing-subdir/bad.md');
    // No `.tmp-PID-TS` orphans anywhere in .agent/agents/.
    const fs = require('node:fs') as typeof import('node:fs');
    const agentsDir = join(cwd, '.agent', 'agents');
    const entries = fs.readdirSync(agentsDir);
    for (const e of entries) {
      expect(e).not.toMatch(/\.tmp-\d+-\d+$/);
    }
  });

  test('every bundled canonical playbook loads cleanly through the loader', async () => {
    // Sanity check on the production asset bundle. If a future
    // edit to one of the canonical .md files breaks frontmatter,
    // this test catches it before the binary ships. Goes through
    // the same `loadSubagentFromString` that the runtime uses.
    const { CANONICAL_PLAYBOOKS } = await import('../../src/cli/init-playbooks/index.ts');
    const { loadSubagentFromString } = await import('../../src/subagents/index.ts');
    expect(CANONICAL_PLAYBOOKS.length).toBe(9);
    for (const playbook of CANONICAL_PLAYBOOKS) {
      const def = loadSubagentFromString(
        playbook.content,
        'project',
        `bundled/${playbook.filename}`,
      );
      expect(def.whenToUse).toBeDefined();
      expect(def.slash).toBeDefined();
      expect(def.meta).toEqual({});
    }
  });
});

describe('runInit — full bundle (default order)', () => {
  let cwd: string;
  let outBuf: string[];
  let errBuf: string[];
  const out = (s: string) => outBuf.push(s);
  const err = (s: string) => errBuf.push(s);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'forja-init-full-'));
    outBuf = [];
    errBuf = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('scaffolds all five project artifacts on a clean cwd', () => {
    // Pin to the five project-scope steps (permissions, gitignore,
    // config, playbooks, skills) by `only=`. The full DEFAULT_STEPS
    // list includes `seeds` (user-scope install), which the
    // dedicated init-seeds.test.ts exercises under an isolated
    // XDG_CONFIG_HOME. Mixing it in here would either pollute the
    // developer's real ~/.config/agent or force a tmpdir XDG
    // override on every test — both unnecessary because the seed
    // step is unrelated to the project-artifact scaffold this test
    // pins.
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['permissions', 'gitignore', 'config', 'playbooks', 'skills'],
      playbookSource: FIXTURE_PLAYBOOKS,
      skillSource: FIXTURE_SKILLS,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', '.gitignore'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'config.toml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'agents', 'fixture-a.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'agents', 'fixture-b.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'skills', 'shared', 'fixture-skill-a.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'skills', 'shared', 'fixture-skill-b.md'))).toBe(true);
    // Aggregate count = 1 perm + 1 gitignore + 1 config + 2 playbooks + 2 skills
    expect(outBuf.join('')).toContain('7 wrote');
    expect(outBuf.join('')).toContain('5 steps');
    expect(outBuf.join('')).toContain("review .agent/ and run 'agent'");
  });

  test('atomic-write preserves the existing file mode on force-overwrite', () => {
    // Operator who tightened `.agent/config.toml` to 0600 for
    // security keeps that mode after `init --force=config`.
    // Without preservation, the temp+rename adopts the temp's
    // default (0644 modulated by umask) and silently relaxes the
    // restriction. Pin via a config-only scaffold so we don't
    // depend on the playbooks fixture or .gitignore.
    runInit({ cwd, mode: 'strict', only: ['config'], out, err });
    const target = join(cwd, '.agent', 'config.toml');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.chmodSync(target, 0o600);
    outBuf = [];
    errBuf = [];
    runInit({ cwd, mode: 'strict', only: ['config'], force: ['config'], out, err });
    const modeAfter = fs.statSync(target).mode & 0o777;
    expect(modeAfter).toBe(0o600);
  });

  test('atomic-write leaves no `.tmp-*` orphan in .agent/ after a successful scaffold', () => {
    // Pin for the atomic-write contract: temp+rename succeeded, the
    // temp file should be gone (rename moved it to the target). A
    // future refactor that drops the rename in favor of a direct
    // write would still pass the existence checks above but would
    // leak the temp pattern at higher rates if the writer crashed
    // mid-write. We check no leaked temps directly to defend the
    // crash-safe property.
    runInit({ cwd, mode: 'strict', playbookSource: FIXTURE_PLAYBOOKS, out, err });
    const fs = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else out.push(p);
      }
      return out;
    };
    const allFiles = walk(join(cwd, '.agent'));
    const tmps = allFiles.filter((p) => /\.tmp-\d+-\d+$/.test(p));
    expect(tmps).toEqual([]);
  });

  test('idempotent re-run leaves operator edits intact', () => {
    runInit({ cwd, mode: 'strict', playbookSource: FIXTURE_PLAYBOOKS, out, err });
    // Touch each artifact with operator-distinguishable content.
    const edits = {
      perm: '# operator perm edit',
      gitignore: '# operator gitignore edit',
      config: '# operator config edit',
      playbook: '# operator playbook edit',
    };
    writeFileSync(join(cwd, '.agent', 'permissions.yaml'), edits.perm);
    writeFileSync(join(cwd, '.agent', '.gitignore'), edits.gitignore);
    writeFileSync(join(cwd, '.agent', 'config.toml'), edits.config);
    writeFileSync(join(cwd, '.agent', 'agents', 'fixture-a.md'), edits.playbook);
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8')).toBe(edits.perm);
    expect(readFileSync(join(cwd, '.agent', '.gitignore'), 'utf8')).toBe(edits.gitignore);
    expect(readFileSync(join(cwd, '.agent', 'config.toml'), 'utf8')).toBe(edits.config);
    expect(readFileSync(join(cwd, '.agent', 'agents', 'fixture-a.md'), 'utf8')).toBe(
      edits.playbook,
    );
    // Footer suppressed when nothing was written — re-runs are
    // quiet by design.
    expect(outBuf.join('')).not.toContain("run 'agent' to start");
  });

  test("--force='all' overwrites every force-eligible artifact but NOT .gitignore", () => {
    runInit({ cwd, mode: 'strict', playbookSource: FIXTURE_PLAYBOOKS, out, err });
    const edits = {
      perm: '# operator perm edit',
      gitignore: '# operator gitignore edit',
      config: '# operator config edit',
      playbook: '# operator playbook edit',
    };
    writeFileSync(join(cwd, '.agent', 'permissions.yaml'), edits.perm);
    writeFileSync(join(cwd, '.agent', '.gitignore'), edits.gitignore);
    writeFileSync(join(cwd, '.agent', 'config.toml'), edits.config);
    writeFileSync(join(cwd, '.agent', 'agents', 'fixture-a.md'), edits.playbook);
    outBuf = [];
    errBuf = [];
    runInit({
      cwd,
      mode: 'strict',
      force: 'all',
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    // Force-eligible artifacts got rewritten.
    expect(readFileSync(join(cwd, '.agent', 'permissions.yaml'), 'utf8')).toContain('mode: strict');
    expect(readFileSync(join(cwd, '.agent', 'config.toml'), 'utf8')).toContain('[budget]');
    expect(readFileSync(join(cwd, '.agent', 'agents', 'fixture-a.md'), 'utf8')).toContain(
      'name: fixture-a',
    );
    // .gitignore stayed — operator-owned per MEMORY.md §2.5.
    expect(readFileSync(join(cwd, '.agent', '.gitignore'), 'utf8')).toBe(edits.gitignore);
  });

  test("--only=['permissions','config'] writes only those two", () => {
    const code = runInit({
      cwd,
      mode: 'strict',
      only: ['permissions', 'config'],
      out,
      err,
    });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'config.toml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', '.gitignore'))).toBe(false);
    expect(existsSync(join(cwd, '.agent', 'agents'))).toBe(false);
    expect(outBuf.join('')).toContain('2 steps');
  });

  test('partial failure exits 1 and preceding writes survive', () => {
    // First run lays everything down.
    runInit({ cwd, mode: 'strict', playbookSource: FIXTURE_PLAYBOOKS, out, err });
    // Replace the .agent/agents directory with a regular file —
    // the playbooks step's mkdirSync(targetDir, {recursive:true})
    // will throw ENOTDIR. Permissions / gitignore / config already
    // exist from the first run, so they skip. The playbooks step
    // is the one that fails.
    rmSync(join(cwd, '.agent', 'agents'), { recursive: true, force: true });
    writeFileSync(join(cwd, '.agent', 'agents'), 'sentinel');
    outBuf = [];
    errBuf = [];
    const code = runInit({
      cwd,
      mode: 'strict',
      playbookSource: FIXTURE_PLAYBOOKS,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('failed');
    // Surviving artifacts from earlier still on disk — no rollback
    // is the spec posture so the operator can iterate.
    expect(existsSync(join(cwd, '.agent', 'permissions.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', '.gitignore'))).toBe(true);
    expect(existsSync(join(cwd, '.agent', 'config.toml'))).toBe(true);
  });
});
