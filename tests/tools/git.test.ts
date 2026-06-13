import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeWrapSandboxArgv } from '../../src/permissions/index.ts';
import { buildModeArgs, gitTool } from '../../src/tools/builtin/git.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const GIT_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(['git', '--version']).exitCode === 0;
  } catch {
    return false;
  }
})();

// ── Security contract: pure argv construction, no spawn ────────────

describe('buildModeArgs — flag-injection rejection', () => {
  test("rejects ref starting with '-' (would be parsed as a flag)", () => {
    const r = buildModeArgs({ mode: 'log', ref: '--output=/tmp/pwned' });
    expect('error' in r).toBe(true);
  });

  test('rejects ref with shell/odd characters', () => {
    for (const ref of ['a b', 'a;rm', 'a$(x)', 'a|b', 'a&b']) {
      expect('error' in buildModeArgs({ mode: 'show', ref })).toBe(true);
    }
  });

  test("rejects path with '..', absolute path, and leading '-'", () => {
    expect('error' in buildModeArgs({ mode: 'diff', path: '../etc/passwd' })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'diff', path: '/etc/passwd' })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', path: '--all' })).toBe(true);
  });

  test('rejects git pathspec magic (leading ":") — `--` does not disable it', () => {
    for (const path of [':(top)', ':(exclude)src', ':!secret', ':/etc']) {
      expect('error' in buildModeArgs({ mode: 'diff', path })).toBe(true);
    }
    // a normal relative path is still accepted
    expect('args' in buildModeArgs({ mode: 'diff', path: 'src/a.ts' })).toBe(true);
  });

  test('blame requires a path', () => {
    expect('error' in buildModeArgs({ mode: 'blame' })).toBe(true);
    const ok = buildModeArgs({ mode: 'blame', path: 'src/a.ts' });
    expect('args' in ok).toBe(true);
  });

  test('max_count must be a positive integer', () => {
    expect('error' in buildModeArgs({ mode: 'log', max_count: 0 })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', max_count: -3 })).toBe(true);
    expect('error' in buildModeArgs({ mode: 'log', max_count: 1.5 })).toBe(true);
  });
});

describe('buildModeArgs — per-mode argv shape', () => {
  test('diff hardens against ext-diff/textconv and separates pathspec', () => {
    const r = buildModeArgs({ mode: 'diff', path: 'src/a.ts', staged: true });
    if (!('args' in r)) throw new Error('expected args');
    expect(r.args).toContain('--no-ext-diff');
    expect(r.args).toContain('--no-textconv');
    expect(r.args).toContain('--staged');
    // path is fenced behind `--` so it can never be read as a flag.
    const sep = r.args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(r.args[sep + 1]).toBe('src/a.ts');
  });

  test('log caps and carries a compact pretty format', () => {
    const r = buildModeArgs({ mode: 'log', max_count: 5000 });
    if (!('args' in r)) throw new Error('expected args');
    // capped to MAX_LOG_COUNT
    expect(r.args[r.args.indexOf('-n') + 1]).toBe('1000');
    expect(r.args.some((a) => a.startsWith('--pretty='))).toBe(true);
  });

  test('show defaults to HEAD, peeled to a commit (blocks blob/tree content dumps)', () => {
    const r = buildModeArgs({ mode: 'show' });
    if (!('args' in r)) throw new Error('expected args');
    expect(r.args).toContain('HEAD^{commit}');
  });
});

// ── Functional: against a real temp repo ───────────────────────────

describe.if(GIT_AVAILABLE)('gitTool — against a real repo', () => {
  let dir: string;

  const run = (cmd: string[]) => {
    const p = Bun.spawnSync(['git', ...cmd], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(`git ${cmd.join(' ')} failed`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-git-'));
    run(['init', '-q']);
    run(['config', 'user.email', 't@t.t']);
    run(['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    run(['add', 'a.ts']);
    run(['commit', '-q', '-m', 'add a']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('log returns the commit', async () => {
    const out = await gitTool.execute({ mode: 'log' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.output).toContain('add a');
    expect(out.exit_code).toBe(0);
  });

  test('diff/status reflect the LIVE working tree (uncommitted)', async () => {
    // mutate the file WITHOUT committing — the whole point of isolation:none.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    const diff = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    if (isToolError(diff)) throw new Error(diff.error_message);
    expect(diff.output).toContain('-export const a = 1;');
    expect(diff.output).toContain('+export const a = 2;');

    const status = await gitTool.execute({ mode: 'status' }, makeCtx({ cwd: dir }));
    if (isToolError(status)) throw new Error(status.error_message);
    expect(status.output).toContain('a.ts');
  });

  test('blame attributes the line', async () => {
    const out = await gitTool.execute({ mode: 'blame', path: 'a.ts' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.output).toContain('export const a = 1;');
  });

  test('caps output at OUTPUT_CAP_BYTES and flags truncated', async () => {
    // A ~230 KB file → `git show HEAD` emits a diff well past the
    // 64 KiB cap, exercising the byte-slice + SIGTERM truncation path.
    const big = `${Array.from({ length: 5000 }, (_, i) => `line ${i} padding padding padding`).join('\n')}\n`;
    writeFileSync(join(dir, 'big.txt'), big);
    run(['add', 'big.txt']);
    run(['commit', '-q', '-m', 'add big']);
    const out = await gitTool.execute({ mode: 'show', ref: 'HEAD' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(out.truncated).toBe(true);
    // captured bytes never exceed the 64 KiB cap
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(out.output.length).toBeGreaterThan(0);
  });

  test('content modes refuse when output would include a policy-denied file', async () => {
    // Track + commit a secret, then modify both it and an allowed file
    // so a pathless `git diff` would emit BOTH file bodies.
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    run(['add', '.env']);
    run(['commit', '-q', '-m', 'add env']);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, '.env'), 'SECRET=2\n');

    // Policy that denies reading .env (mirrors the sensitive floor /
    // an operator deny_paths rule, surfaced through canReadPath).
    const denyEnv = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.endsWith('.env'),
      },
    });

    // Pathless diff would emit .env content → must refuse.
    const diff = await gitTool.execute({ mode: 'diff' }, denyEnv);
    expect(isToolError(diff)).toBe(true);
    if (isToolError(diff)) expect(diff.error_code).toBe('git.policy_denied');

    // Same for show of the commit that introduced .env.
    const show = await gitTool.execute({ mode: 'show', ref: 'HEAD' }, denyEnv);
    expect(isToolError(show)).toBe(true);

    // Scoped to the allowed file → runs fine (no denied file emitted).
    const scoped = await gitTool.execute({ mode: 'diff', path: 'a.ts' }, denyEnv);
    if (isToolError(scoped)) throw new Error(scoped.error_message);
    expect(scoped.output).toContain('+export const a = 2;');

    // And with an allow-all policy the pathless diff is unaffected.
    const allowAll = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    if (isToolError(allowAll)) throw new Error(allowAll.error_message);
    expect(allowAll.output).toContain('.env');
  });

  test('metadata modes drop policy-denied names (ls_files/status do not leak descendants)', async () => {
    // Allowed root with a denied descendant — the engine gates git on the
    // ROOT only, so ls_files/status would still emit the denied name.
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets/key.txt'), 'TOPSECRET\n');
    run(['add', 'secrets/key.txt']);
    run(['commit', '-q', '-m', 'add secret']);
    // Uncommitted edits in both subtrees so status reports both.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'secrets/key.txt'), 'TOPSECRET2\n');

    const denySecrets = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.includes('/secrets/'),
      },
    });

    const ls = await gitTool.execute({ mode: 'ls_files' }, denySecrets);
    if (isToolError(ls)) throw new Error(ls.error_message);
    expect(ls.output).toContain('a.ts');
    expect(ls.output).not.toContain('secrets/key.txt');

    const status = await gitTool.execute({ mode: 'status' }, denySecrets);
    if (isToolError(status)) throw new Error(status.error_message);
    expect(status.output).toContain('a.ts');
    expect(status.output).not.toContain('secrets/key.txt');

    // With an allow-all policy the denied name reappears (the drop is the
    // policy's doing, not a hardcoded hide).
    const allowAll = makeCtx({ cwd: dir });
    const lsAll = await gitTool.execute({ mode: 'ls_files' }, allowAll);
    if (isToolError(lsAll)) throw new Error(lsAll.error_message);
    expect(lsAll.output).toContain('secrets/key.txt');
  });

  test('status decomposes renames so the gate sees BOTH paths (no two-path record)', async () => {
    // Track a secret, then rename it to an allowed name + edit it. With
    // rename detection a status would emit `R secrets/s.txt -> a2.ts`,
    // hiding the denied SOURCE in a two-path record; --no-renames + the
    // per-path gate must drop the source side.
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets/s.txt'), 'SECRET\n');
    run(['add', 'secrets/s.txt']);
    run(['commit', '-q', '-m', 'add secret']);
    run(['mv', 'secrets/s.txt', 'a2.ts']);
    appendFileSync(join(dir, 'a2.ts'), 'tail\n');

    const denySecrets = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.includes('/secrets/'),
      },
    });
    const status = await gitTool.execute({ mode: 'status' }, denySecrets);
    if (isToolError(status)) throw new Error(status.error_message);
    // The allowed destination shows; the denied source name does not.
    expect(status.output).toContain('a2.ts');
    expect(status.output).not.toContain('secrets/s.txt');
  });

  test('metadata gate resolves against the REPO ROOT, not cwd — denied name does not leak from a subdir', async () => {
    // Regression for the relativity bug: `git status -z` emits ROOT-relative
    // names (porcelain ignores status.relativePaths under -z) and `ls-files
    // --full-name` likewise. Resolving those against ctx.cwd from a SUBDIR
    // would double the prefix (/repo/app/app/secrets/x) and mis-gate, so a
    // denied descendant's NAME would leak. The deny predicate keys on the
    // ABSOLUTE secrets path, so a doubled (wrong) resolution is NOT denied —
    // this test only passes if the gate resolves against the real root.
    mkdirSync(join(dir, 'app/secrets'), { recursive: true });
    writeFileSync(join(dir, 'app/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'app/secrets/key.txt'), 'SECRET\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'add app']);
    writeFileSync(join(dir, 'app/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'app/secrets/key.txt'), 'SECRET2\n');

    const secretsAbs = join(dir, 'app', 'secrets');
    const fromSubdir = makeCtx({
      cwd: join(dir, 'app'),
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        // Deny only the REAL absolute secrets subtree. A path doubled by a
        // cwd-relative mis-resolution (/repo/app/app/secrets/...) would NOT
        // start with this prefix → would wrongly pass → the test would catch
        // the leak.
        canReadPath: (p) => !p.startsWith(secretsAbs),
      },
    });

    const status = await gitTool.execute({ mode: 'status' }, fromSubdir);
    if (isToolError(status)) throw new Error(status.error_message);
    expect(status.output).toContain('a.ts');
    expect(status.output).not.toContain('key.txt');

    const ls = await gitTool.execute({ mode: 'ls_files' }, fromSubdir);
    if (isToolError(ls)) throw new Error(ls.error_message);
    expect(ls.output).toContain('a.ts');
    expect(ls.output).not.toContain('key.txt');
  });

  test('gates a denied file with a non-ASCII name (-z framing, not quotePath-escaped)', async () => {
    // Default core.quotePath would C-escape this name in --name-only
    // output; -z must frame it raw so the gate sees the real path.
    writeFileSync(join(dir, 'файл.env'), 'SECRET=1\n');
    run(['add', 'файл.env']);
    run(['commit', '-q', '-m', 'add unicode env']);
    writeFileSync(join(dir, 'файл.env'), 'SECRET=2\n');
    const denyEnv = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.endsWith('.env'),
      },
    });
    const out = await gitTool.execute({ mode: 'diff' }, denyEnv);
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('git.policy_denied');
  });

  test('show of a bare blob is refused (cannot dump ungated object content)', async () => {
    const blob = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'hash-object', join(dir, 'a.ts')], { cwd: dir }).stdout)
      .trim();
    // `show <blob>` would print the blob body; the tool peels `^{commit}`
    // so this resolves to a fatal error, not a content dump.
    const out = await gitTool.execute({ mode: 'show', ref: blob }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
  });

  test('refuses content modes when the file list overflows the capture cap', async () => {
    // Enough long-named tracked+modified files to push `--name-only -z`
    // output past OUTPUT_CAP_BYTES (64 KiB); a partial list must not be
    // gated and then leak the unseen tail.
    const prefix = 'f'.repeat(150);
    for (let i = 0; i < 500; i++) writeFileSync(join(dir, `${prefix}${i}.txt`), '1\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'many']);
    for (let i = 0; i < 500; i++) writeFileSync(join(dir, `${prefix}${i}.txt`), '2\n');
    // Permissive policy — the refusal must come from truncation, not denial.
    const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('git.policy_denied');
  });

  test('pathless modes scope to cwd, not the whole repo (no subdir metadata leak)', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'src/x.ts'), 'export const x = 1;\n');
    run(['add', 'src/x.ts']);
    run(['commit', '-q', '-m', 'add src']);
    // A docs-only commit — history that must NOT surface from src/.
    writeFileSync(join(dir, 'docs/y.md'), '# y\n');
    run(['add', 'docs/y.md']);
    run(['commit', '-q', '-m', 'docs only change']);
    // Uncommitted changes in BOTH subtrees.
    writeFileSync(join(dir, 'src/x.ts'), 'export const x = 2;\n');
    writeFileSync(join(dir, 'docs/y.md'), '# y2\n');

    const fromSrc = makeCtx({ cwd: join(dir, 'src') });
    // status from src/ must not report the docs sibling change.
    const status = await gitTool.execute({ mode: 'status' }, fromSrc);
    if (isToolError(status)) throw new Error(status.error_message);
    expect(status.output).toContain('x.ts');
    expect(status.output).not.toContain('docs');
    // log from src/ must not surface the docs-only commit.
    const log = await gitTool.execute({ mode: 'log' }, fromSrc);
    if (isToolError(log)) throw new Error(log.error_message);
    expect(log.output).toContain('add src');
    expect(log.output).not.toContain('docs only change');
  });

  test('rename detection cannot hide a denied source path from the content gate', async () => {
    // Commit a secret, then rename+edit it into an allowed path with
    // rename detection ON (the dangerous config). With detection on,
    // --name-only would report ONLY the destination; the tool forces
    // diff.renames=false so the gate still sees the denied source.
    writeFileSync(join(dir, 'secret.env'), 'TOPSECRET=1\n');
    run(['add', 'secret.env']);
    run(['commit', '-q', '-m', 'add secret']);
    run(['mv', 'secret.env', 'keep.txt']);
    writeFileSync(join(dir, 'keep.txt'), 'TOPSECRET=2\n');
    run(['add', 'keep.txt']);
    run(['config', 'diff.renames', 'true']);

    const denyEnv = makeCtx({
      cwd: dir,
      permissions: {
        mode: 'strict',
        posture: 'supervised',
        canReadPath: (p) => !p.endsWith('secret.env'),
      },
    });
    const out = await gitTool.execute({ mode: 'diff', staged: true }, denyEnv);
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('git.policy_denied');
  });

  test('forces short submodule diffs (config diff.submodule=diff cannot inline submodule content)', async () => {
    // A submodule whose tree holds a secret.
    const sub = mkdtempSync(join(tmpdir(), 'forja-sub-'));
    const shSub = (cmd: string[]) => Bun.spawnSync(['git', ...cmd], { cwd: sub });
    shSub(['init', '-q']);
    shSub(['config', 'user.email', 's@s']);
    shSub(['config', 'user.name', 'S']);
    writeFileSync(join(sub, '.env'), 'SECRET=1\n');
    shSub(['add', '-A']);
    shSub(['commit', '-q', '-m', 's1']);
    try {
      // Add it as a submodule of the test repo (local file protocol).
      const added = Bun.spawnSync(
        ['git', '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sm'],
        { cwd: dir },
      );
      // Some environments disable submodules; skip rather than false-fail.
      if (added.exitCode !== 0) return;
      run(['commit', '-q', '-m', 'add sm']);
      // Advance the submodule THROUGH the superproject's checkout (sm is
      // a clone of `sub`; editing `sub` would not move the gitlink) and
      // set the dangerous config that inlines submodule content.
      const smDir = join(dir, 'sm');
      const shSm = (cmd: string[]) => Bun.spawnSync(['git', ...cmd], { cwd: smDir });
      writeFileSync(join(smDir, '.env'), 'SECRET=2\n');
      shSm(['add', '-A']);
      shSm(['commit', '-q', '-m', 's2']);
      run(['config', 'diff.submodule', 'diff']);

      const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
      if (isToolError(out)) throw new Error(out.error_message);
      // The submodule body must NOT appear inline; only the subproject
      // commit SHAs (the short form) may show.
      expect(out.output).not.toContain('SECRET');
      expect(out.output).toContain('Subproject commit');
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test('fails closed when filter-config enumeration overflows the capture cap', async () => {
    // A hostile repo with more filter.<name>.clean entries than fit in
    // the 64 KiB key-list cap: a partial pin could leave the ACTIVE
    // driver undisabled, so the tool must refuse rather than proceed.
    const name = 'f'.repeat(150);
    let cfg = '';
    for (let i = 0; i < 600; i++) cfg += `[filter "${name}${i}"]\n\tclean = x\n`;
    appendFileSync(join(dir, '.git', 'config'), cfg);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 5;\n');
    const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('git.policy_denied');
  });

  test('neutralizes a repo-configured clean filter (no exec on a worktree diff)', async () => {
    const canary = join(dir, 'CANARY');
    const flt = join(dir, 'flt.sh');
    // A clean filter must passthrough content on stdout (cat); it also
    // writes the canary the moment git invokes it.
    writeFileSync(flt, `#!/bin/sh\necho pwned > "${canary}"\ncat\n`);
    chmodSync(flt, 0o755);
    writeFileSync(join(dir, '.gitattributes'), '* filter=pwn\n');
    run(['config', 'filter.pwn.clean', flt]);
    // Modify a tracked file so the worktree diff compares (and cleans).
    writeFileSync(join(dir, 'a.ts'), 'export const a = 7;\n');

    // Positive control: a raw worktree diff runs the filter.
    Bun.spawnSync(['git', 'diff'], { cwd: dir });
    expect(existsSync(canary)).toBe(true);

    // The tool pins clean/smudge/process to empty → no exec.
    rmSync(canary, { force: true });
    const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(existsSync(canary)).toBe(false);
  });

  test('does not exec a diff.external driver (repo-local config exec vector)', async () => {
    const canary = join(dir, 'CANARY');
    const drv = join(dir, 'drv.sh');
    writeFileSync(drv, `#!/bin/sh\necho pwned > "${canary}"\nexit 0\n`);
    chmodSync(drv, 0o755);
    run(['config', 'diff.external', drv]); // repo-local .git/config
    writeFileSync(join(dir, 'a.ts'), 'export const a = 9;\n');
    const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
    if (isToolError(out)) throw new Error(out.error_message);
    expect(existsSync(canary)).toBe(false);
  });

  test('ignores the operator global config (a hostile ~/.gitconfig cannot inject exec)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forja-home-'));
    const canary = join(dir, 'CANARY');
    const drv = join(dir, 'gdrv.sh');
    writeFileSync(drv, `#!/bin/sh\necho pwned > "${canary}"\nexit 0\n`);
    chmodSync(drv, 0o755);
    writeFileSync(join(home, '.gitconfig'), `[diff]\n\texternal = ${drv}\n`);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 8;\n');
    const prevHome = process.env.HOME;
    process.env.HOME = home; // safeGitEnv forwards HOME → ~/.gitconfig
    try {
      const out = await gitTool.execute({ mode: 'diff' }, makeCtx({ cwd: dir }));
      if (isToolError(out)) throw new Error(out.error_message);
      // GIT_CONFIG_GLOBAL=/dev/null makes git ignore ~/.gitconfig.
      expect(existsSync(canary)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('does not exec gpg.program via log.showSignature (config-driven exec vector)', async () => {
    const out = (cmd: string[], stdin?: string) =>
      new TextDecoder().decode(
        Bun.spawnSync(['git', ...cmd], {
          cwd: dir,
          stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
        }).stdout,
      );

    // A gpg.program canary that writes a marker the instant git asks it
    // to --verify a signature — i.e. the moment the read-only tool would
    // have fork-exec'd a repo-controlled program.
    const canary = join(dir, 'CANARY');
    const fakegpg = join(dir, 'fakegpg.sh');
    writeFileSync(
      fakegpg,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--verify" ]; then echo pwned > "${canary}"; fi; done\necho "[GNUPG:] GOODSIG 0 fake"\nexit 0\n`,
    );
    chmodSync(fakegpg, 0o755);

    // Forge a commit carrying a gpgsig header (no real gpg needed) so
    // `git log --show-signature` will attempt verification.
    const raw = out(['cat-file', 'commit', 'HEAD']);
    const [hdr, ...rest] = raw.split('\n\n');
    const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n FAKE\n -----END PGP SIGNATURE-----';
    const forged = `${hdr}\n${sig}\n\n${rest.join('\n\n')}`;
    const newHash = out(['hash-object', '-w', '-t', 'commit', '--stdin'], forged).trim();
    run(['update-ref', 'HEAD', newHash]);
    run(['config', 'log.showSignature', 'true']);
    run(['config', 'gpg.program', fakegpg]);

    // Positive control: a raw `git log` honors the repo config and DOES
    // fire the canary — proving the vector is live with this setup.
    Bun.spawnSync(['git', 'log', '-1'], { cwd: dir });
    expect(existsSync(canary)).toBe(true);

    // The tool forces `-c log.showSignature=false`, so verification is
    // never attempted: the canary must NOT reappear.
    rmSync(canary, { force: true });
    const result = await gitTool.execute({ mode: 'log' }, makeCtx({ cwd: dir }));
    if (isToolError(result)) throw new Error(result.error_message);
    expect(existsSync(canary)).toBe(false);
  });

  test('not-a-repo surfaces a clean error', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'forja-nogit-'));
    try {
      const out = await gitTool.execute({ mode: 'status' }, makeCtx({ cwd: nonRepo }));
      expect(isToolError(out)).toBe(true);
      if (isToolError(out)) expect(out.error_code).toBe('git.not_a_repo');
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test('invalid mode is rejected before spawn', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
    const out = await gitTool.execute({ mode: 'push' as any }, makeCtx({ cwd: dir }));
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.error_code).toBe('tool.invalid_arg');
  });
});

describe('git sandbox env forwarding', () => {
  // The git GIT_* guards live OUTSIDE SANDBOX_SAFE_ENV_VARS, so under
  // bwrap's --clearenv they only survive if threaded via passthroughEnv
  // — which is exactly what captureGit now passes. This pins that the
  // wrapper emits them as --setenv so sandboxed git is still hardened.
  const hasSetenv = (argv: readonly string[], key: string, val: string): boolean => {
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === '--setenv' && argv[i + 1] === key && argv[i + 2] === val) return true;
    }
    return false;
  };

  test('GIT_* guards survive the --clearenv boundary as --setenv flags', () => {
    const gitEnv: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: '/home/op',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const argv = maybeWrapSandboxArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/git', 'status'],
      env: gitEnv,
      passthroughEnv: gitEnv,
      // Deterministic seams: fake bwrap present, identity realpath (no
      // fs canonicalization of cwd/home), skip hide_paths mkdir.
      platform: 'linux',
      which: () => '/usr/bin/bwrap',
      realpath: (p) => p,
      pathExists: () => false,
    });
    // Sanity: we actually got a bwrap wrap (not the host passthrough).
    expect(argv).toContain('--clearenv');
    expect(hasSetenv(argv, 'GIT_CONFIG_GLOBAL', '/dev/null')).toBe(true);
    expect(hasSetenv(argv, 'GIT_CONFIG_NOSYSTEM', '1')).toBe(true);
    expect(hasSetenv(argv, 'GIT_LITERAL_PATHSPECS', '1')).toBe(true);
    expect(hasSetenv(argv, 'GIT_OPTIONAL_LOCKS', '0')).toBe(true);
    expect(hasSetenv(argv, 'GIT_PAGER', 'cat')).toBe(true);
  });
});
