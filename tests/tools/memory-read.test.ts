import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import type { DB } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { memoryReadTool } from '../../src/tools/builtin/memory-read.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-tool-read-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

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

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory_read tool', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('clean error when registry not wired', async () => {
    const result = await memoryReadTool.execute({ name: 'role' }, makeCtx());
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.registry_unavailable');
    }
  });

  test('returns body and emits read audit event', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'Body of role.\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const ctx = makeCtx({ memoryRegistry: reg, sessionId });
    const result = await memoryReadTool.execute({ name: 'role' }, ctx);
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    expect(result.scope).toBe('project_local');
    expect(result.name).toBe('role');
    expect(result.type).toBe('user');
    expect(result.body).toBe('Body of role.\n');
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
  });

  test('returns memory.not_found when name unknown', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryReadTool.execute({ name: 'nope' }, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.not_found');
    }
  });

  test('returns memory.body_missing when index has entry but file is gone', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    // No body file written.
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryReadTool.execute({ name: 'role' }, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.body_missing');
    }
  });

  test('returns memory.malformed for invalid frontmatter', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(
      roots.user,
      'role',
      'name: role\ndescription: x\ntype: bogus\nsource: user_explicit\n',
      'b',
    );
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryReadTool.execute({ name: 'role' }, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('memory.malformed');
    }
  });

  test('rejects path-traversal name (sandbox via validateName)', async () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryReadTool.execute({ name: '../escape' }, ctx);
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe('tool.invalid_arg');
    }
  });

  test('strict scope refuses fallback', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'b');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const explicitWrong = await memoryReadTool.execute(
      { name: 'role', scope: 'project_local' },
      ctx,
    );
    expect(isToolError(explicitWrong)).toBe(true);
    if (isToolError(explicitWrong)) {
      expect(explicitWrong.error_code).toBe('memory.not_found');
    }
    const explicitRight = await memoryReadTool.execute({ name: 'role', scope: 'user' }, ctx);
    expect(isToolError(explicitRight)).toBe(false);
  });

  test('audit row uses ctx.sessionId, not registry constructor session id (top-level path)', async () => {
    // Regression: bootstrap builds the registry without a
    // sessionId (the session doesn't exist at bootstrap time).
    // The tool MUST forward ctx.sessionId so audit rows attribute
    // to the active session, not NULL.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'body\n');
    // Registry constructed WITHOUT sessionId (bootstrap shape).
    const reg = createMemoryRegistry({ roots, db, cwd: '/p' });
    // ctx.sessionId is the active session — what bootstrap CAN'T
    // provide at construction but the harness DOES populate when
    // building ToolContext per step.
    const ctx = makeCtx({ memoryRegistry: reg, sessionId, cwd: '/p' });
    const result = await memoryReadTool.execute({ name: 'role' }, ctx);
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    // Pre-fix: events[0]?.sessionId === null. Post-fix: ctx.sessionId.
    expect(events[0]?.sessionId).toBe(sessionId);
    expect(events[0]?.cwd).toBe('/p');
  });

  test('preserves optional frontmatter fields when present', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Q](q.md) — q\n');
    writeMemory(
      roots.user,
      'q',
      'name: q\ndescription: deadline\ntype: project\nsource: user_explicit\nexpires: 2026-12-31\ntrust: trusted\ntriggers:\n  - git\n',
      'body\n',
    );
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const ctx = makeCtx({ memoryRegistry: reg });
    const result = await memoryReadTool.execute({ name: 'q' }, ctx);
    if (isToolError(result)) throw new Error(`unexpected: ${result.error_message}`);
    expect(result.expires).toBe('2026-12-31');
    expect(result.trust).toBe('trusted');
    expect(result.triggers).toEqual(['git']);
  });
});
