import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMemoryCli } from '../../src/cli/memory.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';

// CLI-level tests for `agent --memory <verb>`. The registry
// itself is unit-tested in tests/memory/registry.test.ts; here we
// cover argument parsing, output shape (table vs NDJSON), exit
// codes, and audit emission for `show`.
//
// We override XDG_CONFIG_HOME in setup so the user scope lands in
// a tmpdir instead of the developer's real ~/.config/agent/memory/.
// This is the same seam `userScopeRoot` already honors.

let db: DB;
let cwd: string;
let xdgRoot: string;
let outBuf: string;
let errBuf: string;
let originalXdg: string | undefined;

const out = (s: string): void => {
  outBuf += s;
};
const err = (s: string): void => {
  errBuf += s;
};

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeMemory = (dir: string, name: string, frontmatter: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}---\n\n${body}`);
};

const fmUser = (name: string): string =>
  `name: ${name}\ndescription: hook for ${name}\ntype: user\nsource: user_explicit\n`;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  cwd = mkdtempSync(join(tmpdir(), 'forja-mem-cli-cwd-'));
  xdgRoot = mkdtempSync(join(tmpdir(), 'forja-mem-cli-xdg-'));
  outBuf = '';
  errBuf = '';
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgRoot;
});

afterEach(() => {
  for (const dir of [cwd, xdgRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    db.close();
  } catch {
    // ignore
  }
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg;
  }
});

const userScopeDir = (): string => join(xdgRoot, 'agent', 'memory');
const projectLocalDir = (): string => join(cwd, '.agent', 'memory', 'local');
const projectSharedDir = (): string => join(cwd, '.agent', 'memory', 'shared');

describe('runMemoryCli — list', () => {
  test('empty state → "no memories found" (table) / count=0 (json)', async () => {
    const codeTable = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(codeTable).toBe(0);
    expect(outBuf).toBe('no memories found.\n');
    expect(errBuf).toBe('');
    outBuf = '';

    const codeJson = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(codeJson).toBe(0);
    expect(outBuf).toBe('{"count":0}\n');
  });

  test('lists entries from all three scopes in precedence order (table)', async () => {
    writeIndex(userScopeDir(), '- [User](user-mem.md) — user-hook\n');
    writeIndex(projectSharedDir(), '- [Shared](shared-mem.md) — shared-hook\n');
    writeIndex(projectLocalDir(), '- [Local](local-mem.md) — local-hook\n');

    const code = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.trim().split('\n');
    // Header + 3 entries.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('scope');
    expect(lines[1]).toContain('project_local');
    expect(lines[2]).toContain('project_shared');
    expect(lines[3]).toContain('user');
  });

  test('NDJSON list emits one row per entry plus summary', async () => {
    writeIndex(projectLocalDir(), '- [A](a.md) — alpha\n- [B](b.md) — beta\n');
    const code = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.trim().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0] ?? '{}');
    expect(first).toMatchObject({ scope: 'project_local', name: 'a' });
    // Non-seed entries omit the `subdir` field — payload stays
    // additive (legacy script consumers see identical bytes).
    expect(first.subdir).toBeUndefined();
    const summary = JSON.parse(lines[2] ?? '{}');
    expect(summary).toEqual({ count: 2 });
  });

  test('vendor seeds surface `subdir:"seeds"` in JSON and ` [seed]` in table (spec §5.7.3)', async () => {
    // Parity with the slash `/memory list [seed]` marker. Without
    // a JSON discriminator, a script consuming `agent --memory list
    // --json` to inventory operator memories can't distinguish
    // vendor-curated meta-behavior from operator-authored entries
    // in the user scope. The marker also propagates to the table
    // form as a name-suffix so the operator inspecting the human-
    // readable output sees the same signal.
    const { installVendorSeeds } = await import('../../src/memory/seeds-installer.ts');
    const { resolveScopeRoots, resolveRepoRoot } = await import('../../src/memory/paths.ts');
    const { CANONICAL_SEEDS } = await import('../../src/cli/init-seeds/index.ts');
    const roots = resolveScopeRoots(resolveRepoRoot(cwd), process.env);
    installVendorSeeds({ roots });
    const sample = CANONICAL_SEEDS[0];
    if (sample === undefined) throw new Error('CANONICAL_SEEDS unexpectedly empty');

    // JSON path: every emitted row carries `subdir:"seeds"`.
    const codeJson = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(codeJson).toBe(0);
    const lines = outBuf.trim().split('\n');
    const dataLines = lines.slice(0, lines.length - 1);
    const summary = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(summary.count).toBe(CANONICAL_SEEDS.length);
    const first = JSON.parse(dataLines[0] ?? '{}');
    expect(first.subdir).toBe('seeds');
    // Sanity: at least one row carries the sample name we asserted on.
    const names = dataLines.map((l) => JSON.parse(l).name as string);
    expect(names).toContain(sample.name);
    outBuf = '';

    // Table path: every seed row carries the ` [seed]` suffix on
    // the name column.
    const codeTable = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(codeTable).toBe(0);
    expect(outBuf).toContain(`${sample.name} [seed]`);
  });

  test('honors scope positional', async () => {
    writeIndex(userScopeDir(), '- [User](user-mem.md) — user-hook\n');
    writeIndex(projectLocalDir(), '- [Local](local-mem.md) — local-hook\n');

    const code = await runMemoryCli({
      verb: 'list',
      positionals: ['user'],
      json: true,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}').scope).toBe('user');
    expect(JSON.parse(lines[1] ?? '{}').count).toBe(1);
  });

  test('rejects invalid scope', async () => {
    const code = await runMemoryCli({
      verb: 'list',
      positionals: ['bogus'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain("invalid scope 'bogus'");
  });

  test('rejects too many positionals', async () => {
    const code = await runMemoryCli({
      verb: 'list',
      positionals: ['user', 'extra'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('takes at most one scope positional');
  });
});

describe('runMemoryCli — show', () => {
  test('renders frontmatter + body and emits read audit event', async () => {
    writeIndex(projectLocalDir(), '- [Role](role.md) — role hook\n');
    writeMemory(projectLocalDir(), 'role', fmUser('role'), 'Body content here.\n');

    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['role'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(outBuf).toContain('scope: project_local');
    expect(outBuf).toContain('name: role');
    expect(outBuf).toContain('type: user');
    expect(outBuf).toContain('source: user_explicit');
    expect(outBuf).toContain('Body content here.');

    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
    expect(events[0]?.scope).toBe('project_local');
    expect(events[0]?.sessionId).toBeNull();
    expect(events[0]?.cwd).toBe(cwd);
  });

  test('NDJSON show emits a single JSON object with body', async () => {
    writeIndex(userScopeDir(), '- [Role](role.md) — role\n');
    writeMemory(userScopeDir(), 'role', fmUser('role'), 'Body.\n');
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['role'],
      json: true,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(outBuf.trim());
    expect(obj).toMatchObject({
      scope: 'user',
      name: 'role',
      type: 'user',
      body: 'Body.\n',
    });
  });

  test('returns 1 with clean error when name unknown', async () => {
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['ghost'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain("no memory named 'ghost'");
  });

  test('returns 1 when body file is missing', async () => {
    writeIndex(userScopeDir(), '- [Role](role.md) — role\n');
    // No body file.
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['role'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('body file is missing');
  });

  test('returns 1 when frontmatter is malformed', async () => {
    writeIndex(userScopeDir(), '- [Role](role.md) — role\n');
    writeMemory(
      userScopeDir(),
      'role',
      'name: role\ndescription: x\ntype: bogus\nsource: user_explicit\n',
      'b',
    );
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['role'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('failed to parse');
  });

  test('rejects invalid memory name (sandbox via validateName)', async () => {
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['../escape'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('invalid memory name');
  });

  test('strict scope refuses fallback', async () => {
    writeIndex(userScopeDir(), '- [Role](role.md) — role\n');
    writeMemory(userScopeDir(), 'role', fmUser('role'), 'b');
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['role', 'project_local'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('project_local');
  });

  test('handles empty body cleanly (regression: L2)', async () => {
    writeIndex(userScopeDir(), '- [Empty](empty.md) — empty\n');
    writeMemory(userScopeDir(), 'empty', fmUser('empty'), '');
    const code = await runMemoryCli({
      verb: 'show',
      positionals: ['empty'],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    // Plain mode emits metadata + blank line + body. Empty body
    // still produces a trailing newline so consumers piping into
    // `wc -l` get the expected count.
    expect(outBuf.endsWith('\n')).toBe(true);
    expect(outBuf).toContain('name: empty');
  });

  test('rejects empty positionals', async () => {
    const code = await runMemoryCli({
      verb: 'show',
      positionals: [],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('requires <name>');
  });
});

describe('runMemoryCli — repo-root resolution (regression: subdir blindspot)', () => {
  test('list from a subdir still finds project memories at the repo root', async () => {
    // Operator runs `agent --memory list` from a subdir of a
    // git repo. Memories live at <repo>/.agent/memory/...; the
    // CLI must resolve repo root via git rev-parse rather than
    // anchoring at the invocation cwd. Pre-fix this returned
    // an empty list silently.
    const proc = Bun.spawn({
      cmd: ['git', 'init', '-b', 'main'],
      cwd,
      env: { LC_ALL: 'C', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;

    writeIndex(projectLocalDir(), '- [Role](role.md) — repo memory\n');
    writeMemory(projectLocalDir(), 'role', fmUser('role'), 'b\n');

    const subdir = join(cwd, 'src', 'components');
    mkdirSync(subdir, { recursive: true });

    const code = await runMemoryCli({
      verb: 'list',
      positionals: [],
      json: true,
      cwd: subdir, // invocation from subdir, NOT repo root
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(0);
    const lines = outBuf.trim().split('\n');
    // 1 entry + summary.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}').name).toBe('role');
    expect(JSON.parse(lines[1] ?? '{}').count).toBe(1);
  });
});

describe('runMemoryCli — verbs', () => {
  test('rejects unknown verb', async () => {
    const code = await runMemoryCli({
      verb: 'pondered' as 'list',
      positionals: [],
      json: false,
      cwd,
      dbOverride: db,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(errBuf).toContain('unknown --memory subcommand');
  });
});
