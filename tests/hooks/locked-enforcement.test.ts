// Locked enforcement end-to-end (spec AGENTIC_CLI.md §10.4 +
// CONTRACTS.md §10).
//
// Verifies the three semantics of `locked`:
//   1. Only the enterprise layer can declare `locked: true`.
//      User/project declarations are downgraded with a
//      `lock_ignored` warning — the spec loads, the lock flag
//      doesn't.
//   2. Resolution order is enterprise → user → project. An
//      enterprise hook ALWAYS runs first; lower layers append.
//   3. First-block-wins from the dispatcher means an enterprise
//      blocking hook short-circuits the chain BEFORE any
//      user/project hook gets a chance to override the decision.
//      That's the meaningful enforcement — corp policy can
//      guarantee execution and decision precedence regardless
//      of what the operator's own files say.
//
// Three-layer fixtures live on real disk so the loader exercises
// the real fs path; no mocks for hooks.toml resolution.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchChain, resolveHookConfig } from '../../src/hooks/index.ts';
import type { HookConfigPaths } from '../../src/hooks/paths.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let scratch: string;
let enterpriseFile: string;
let userFile: string;
let projectFile: string;
let db: DB;
let sessionId: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'forja-locked-'));
  // Distinct subdirs so each layer has its own hooks.toml. We
  // pass them explicitly to resolveHookConfig — that way the
  // test isn't polluted by any /etc/forja or ~/.config/forja
  // file the runner machine happens to have.
  await mkdir(join(scratch, 'enterprise'), { recursive: true });
  await mkdir(join(scratch, 'user'), { recursive: true });
  await mkdir(join(scratch, 'project'), { recursive: true });
  enterpriseFile = join(scratch, 'enterprise', 'hooks.toml');
  userFile = join(scratch, 'user', 'hooks.toml');
  projectFile = join(scratch, 'project', 'hooks.toml');
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'test/m', cwd: '/p' }).id;
});

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  db.close();
});

const paths = (): HookConfigPaths => ({
  enterprise: enterpriseFile,
  user: userFile,
  project: projectFile,
});

describe('locked enforcement — config layer', () => {
  test('enterprise layer can declare locked=true', async () => {
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"', 'locked = true'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.hooks[0]?.layer).toBe('enterprise');
    expect(resolved.hooks[0]?.locked).toBe(true);
    expect(resolved.warnings).toEqual([]);
  });

  test('user layer locked=true downgraded to false + lock_ignored warning', async () => {
    await writeFile(
      userFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"', 'locked = true'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.hooks[0]?.layer).toBe('user');
    // Downgraded — only enterprise can lock.
    expect(resolved.hooks[0]?.locked).toBe(false);
    const ignored = resolved.warnings.find((w) => w.kind === 'lock_ignored');
    expect(ignored).toBeDefined();
    expect(ignored?.layer).toBe('user');
  });

  test('project layer locked=true downgraded + lock_ignored warning', async () => {
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"', 'locked = true'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.hooks[0]?.locked).toBe(false);
    expect(resolved.warnings.find((w) => w.kind === 'lock_ignored')?.layer).toBe('project');
  });
});

describe('locked enforcement — resolution order', () => {
  test('enterprise → user → project ordering preserved', async () => {
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "ent"'].join('\n'),
    );
    await writeFile(userFile, ['[[hooks]]', 'event = "PreToolUse"', 'command = "user"'].join('\n'));
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "proj"'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks.map((h) => `${h.layer}:${h.command}`)).toEqual([
      'enterprise:ent',
      'user:user',
      'project:proj',
    ]);
  });

  test('multiple entries within a layer keep declaration order', async () => {
    await writeFile(
      enterpriseFile,
      [
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "ent_a"',
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "ent_b"',
      ].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks.map((h) => h.command)).toEqual(['ent_a', 'ent_b']);
  });
});

describe('locked enforcement — dispatcher first-block-wins', () => {
  test('enterprise blocking hook short-circuits the chain BEFORE user/project run', async () => {
    // Enterprise: blocks (exit 1 = block_silent).
    // User + project: would-allow (true). Should NEVER execute.
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "exit 1"', 'locked = true'].join('\n'),
    );
    await writeFile(userFile, ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'));
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());
    expect(resolved.hooks).toHaveLength(3);

    const result = await dispatchChain(
      resolved.hooks,
      {
        schema: 'v1',
        event: 'PreToolUse',
        sessionId,
        data: { tool: { name: 'echo', input: {} } },
      },
      scratch,
      { db, sessionId },
    );

    // First-block-wins: enterprise blocked, user + project never ran.
    expect(result.blockedBy?.spec.layer).toBe('enterprise');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.spec.layer).toBe('enterprise');
    expect(result.runs[0]?.result.kind).toBe('block_silent');
  });

  test('enterprise allowing → user runs next; user blocking → project never runs', async () => {
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'),
    );
    await writeFile(
      userFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "exit 1"'].join('\n'),
    );
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());

    const result = await dispatchChain(
      resolved.hooks,
      {
        schema: 'v1',
        event: 'PreToolUse',
        sessionId,
        data: { tool: { name: 'echo', input: {} } },
      },
      scratch,
      { db, sessionId },
    );

    expect(result.blockedBy?.spec.layer).toBe('user');
    // Enterprise + user ran; project never started.
    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((r) => r.spec.layer)).toEqual(['enterprise', 'user']);
  });

  test('all-allow → entire chain runs in order', async () => {
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'),
    );
    await writeFile(userFile, ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'));
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PreToolUse"', 'command = "true"'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());

    const result = await dispatchChain(
      resolved.hooks,
      {
        schema: 'v1',
        event: 'PreToolUse',
        sessionId,
        data: { tool: { name: 'echo', input: {} } },
      },
      scratch,
      { db, sessionId },
    );

    expect(result.blockedBy).toBeNull();
    expect(result.runs).toHaveLength(3);
    expect(result.runs.map((r) => r.spec.layer)).toEqual(['enterprise', 'user', 'project']);
  });
});

describe('locked enforcement — non-blocking events run all layers', () => {
  test('PostToolUse: every layer runs independently (no first-block semantics)', async () => {
    await writeFile(
      enterpriseFile,
      ['[[hooks]]', 'event = "PostToolUse"', 'command = "exit 2"'].join('\n'),
    );
    await writeFile(
      userFile,
      ['[[hooks]]', 'event = "PostToolUse"', 'command = "true"'].join('\n'),
    );
    await writeFile(
      projectFile,
      ['[[hooks]]', 'event = "PostToolUse"', 'command = "true"'].join('\n'),
    );
    const resolved = resolveHookConfig(paths());

    const result = await dispatchChain(
      resolved.hooks,
      {
        schema: 'v1',
        event: 'PostToolUse',
        sessionId,
        data: {
          tool: { name: 'echo', input: {}, output: { ok: true }, failed: false },
        },
      },
      scratch,
      { db, sessionId },
    );

    // Non-blocking event: all 3 ran regardless of any "would block"
    // exit code. blockedBy stays null because the event isn't in
    // BLOCKING_EVENTS.
    expect(result.blockedBy).toBeNull();
    expect(result.runs).toHaveLength(3);
  });
});
