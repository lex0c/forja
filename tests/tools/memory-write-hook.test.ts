import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookChainResult, HookEventPayload, HookSpec } from '../../src/hooks/index.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { type MemoryWriteInput, memoryWriteTool } from '../../src/tools/builtin/memory-write.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

// Slice 4: MemoryWrite hook. Direct unit-test against the
// memory_write tool with a stubbed `fireHook` callback. We don't
// need to drive a full harness for this — the hook is the LAST
// gate before persist, isolated to the tool's execute method.

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mw-hook-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const validInput = (overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  name: 'no-console-log',
  scope: 'project_local',
  type: 'feedback',
  source: 'inferred',
  description: 'no console.log in src/',
  body: 'Do not use console.log in src/.\n\nWhy: structured logging.\nHow to apply: use logger.\n',
  ...overrides,
});

const fakeBlock = (reason: 'silent' | 'message', message: string | null): HookChainResult => ({
  blockedBy: {
    spec: {
      layer: 'project',
      sourcePath: '/etc/agent/hooks.toml',
      event: 'MemoryWrite',
      matcher: {},
      command: 'fake',
      timeoutMs: 5000,
      failClosed: false,
      locked: false,
    } as HookSpec,
    reason,
    message,
  },
  runs: [],
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory_write — MemoryWrite hook', () => {
  test('hook block_silent → write rejected, audit refused stage=hook', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const calls: HookEventPayload[] = [];
    const ctx = makeCtx({
      memoryRegistry: reg,
      sessionId,
      confirmMemoryWrite: async () => 'yes' as const,
      fireHook: async (payload) => {
        calls.push(payload);
        if (payload.event === 'MemoryWrite') return fakeBlock('silent', null);
        return null;
      },
    });

    const result = await memoryWriteTool.execute(validInput(), ctx);
    expect('outcome' in result && result.outcome).toBe('rejected');
    if ('reason' in result) expect(result.reason).toBe('denied by hook');

    // Hook saw the right payload shape
    const mwPayload = calls.find((c) => c.event === 'MemoryWrite');
    expect(mwPayload).toBeDefined();
    if (mwPayload?.event === 'MemoryWrite') {
      expect(mwPayload.data.scope).toBe('project_local');
      expect(mwPayload.data.name).toBe('no-console-log');
      expect(mwPayload.data.source).toBe('inferred');
    }

    // Audit row landed with stage=hook (the hook-stage event,
    // amid any other events the writer may have emitted as a
    // side effect of the call — we just want to confirm a hook-
    // stage refused row exists).
    const events = listMemoryEventsByName(db, 'no-console-log');
    const hookRefused = events.find((e) => e.action === 'refused' && e.details?.stage === 'hook');
    expect(hookRefused).toBeDefined();

    // No file on disk
    expect(existsSync(join(roots.projectLocal, 'no-console-log.md'))).toBe(false);
  });

  test('hook block_message → operator stdout becomes the rejection reason', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const ctx = makeCtx({
      memoryRegistry: reg,
      sessionId,
      confirmMemoryWrite: async () => 'yes' as const,
      fireHook: async () => fakeBlock('message', 'organization policy: secrets are not memorable'),
    });

    const result = await memoryWriteTool.execute(validInput(), ctx);
    if ('reason' in result) {
      expect(result.reason).toContain('organization policy: secrets are not memorable');
    }
  });

  test('hook allow → write proceeds, file lands, audit shows created', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const calls: HookEventPayload[] = [];
    const ctx = makeCtx({
      memoryRegistry: reg,
      sessionId,
      confirmMemoryWrite: async () => 'yes' as const,
      fireHook: async (payload) => {
        calls.push(payload);
        // Allow: chain ran, no block.
        return { blockedBy: null, runs: [] };
      },
    });

    const result = await memoryWriteTool.execute(validInput(), ctx);
    expect(isToolError(result)).toBe(false);
    if ('outcome' in result) expect(result.outcome).toBe('created');
    expect(existsSync(join(roots.projectLocal, 'no-console-log.md'))).toBe(true);

    expect(calls.some((c) => c.event === 'MemoryWrite')).toBe(true);
  });

  test('no hooks configured (fireHook returns null) → write proceeds', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const ctx = makeCtx({
      memoryRegistry: reg,
      sessionId,
      confirmMemoryWrite: async () => 'yes' as const,
      fireHook: async () => null,
    });

    const result = await memoryWriteTool.execute(validInput(), ctx);
    if ('outcome' in result) expect(result.outcome).toBe('created');
    expect(existsSync(join(roots.projectLocal, 'no-console-log.md'))).toBe(true);
  });

  test('hook gate fires AFTER modal confirm — modal yes + hook block still rejects', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });

    let modalCalls = 0;
    let hookCalls = 0;
    const ctx = makeCtx({
      memoryRegistry: reg,
      sessionId,
      confirmMemoryWrite: async () => {
        modalCalls += 1;
        return 'yes' as const;
      },
      fireHook: async () => {
        hookCalls += 1;
        return fakeBlock('silent', null);
      },
    });

    await memoryWriteTool.execute(validInput(), ctx);
    expect(modalCalls).toBe(1);
    expect(hookCalls).toBe(1);
    // Modal yes wasn't enough — hook overrode.
    expect(existsSync(join(roots.projectLocal, 'no-console-log.md'))).toBe(false);
  });
});
