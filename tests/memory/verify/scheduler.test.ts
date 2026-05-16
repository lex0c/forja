// Verify scheduler end-to-end tests (S2/T2.4). Exercises the
// provenance-poll → enqueue → verifier dispatch → state-machine
// transition path against a real registry + db + tmpdir.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../../src/memory/registry.ts';
import type { MemoryType } from '../../../src/memory/types.ts';
import { createProjectVerifier } from '../../../src/memory/verify/project-verifier.ts';
import { createVerifyScheduler } from '../../../src/memory/verify/scheduler.ts';
import type { MemoryVerifier, VerifyResult } from '../../../src/memory/verify/types.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { getLastQuarantineEvent } from '../../../src/storage/repos/eviction-events.ts';
import { recordProvenance } from '../../../src/storage/repos/memory-provenance.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-verify-sched-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, '.agent/memory/user'),
  projectShared: join(repo, '.agent/memory/shared'),
  projectLocal: join(repo, '.agent/memory/local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeProjectMemory = (
  dir: string,
  name: string,
  body: string,
  source = 'user_explicit',
): void => {
  mkdirSync(dir, { recursive: true });
  const fm = [
    `name: ${name}`,
    `description: hook for ${name}`,
    'type: project',
    `source: ${source}`,
  ].join('\n');
  writeFileSync(join(dir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`);
};

let db: DB;
let sessionId: string;
let repo: string;
let roots: ScopeRoots;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  repo = makeTmp();
  roots = makeRoots(repo);
  sessionId = createSession(db, { model: 'm', cwd: repo }).id;
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const buildDeps = (errLog: string[]) => {
  const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
  const verifiers: Map<MemoryType, MemoryVerifier> = new Map();
  verifiers.set('project', createProjectVerifier());
  return createVerifyScheduler({
    db,
    sessionId,
    registry,
    repoRoot: repo,
    verifiers,
    errSink: (m) => errLog.push(m),
  });
};

describe('createVerifyScheduler — passed verdict (silent)', () => {
  test('does NOT quarantine when claimed path exists', async () => {
    // Memory claims src/foo.ts exists; we create the file so the
    // verifier returns 'passed'.
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/foo.ts'), '');
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'see src/foo.ts');
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'mem');
    await scheduler.drain();

    // No eviction events; no stderr noise.
    expect(getLastQuarantineEvent(db, 'memory', 'mem', 'user')).toBeNull();
    expect(errs.join('')).toBe('');
  });
});

describe('createVerifyScheduler — contradicted verdict (quarantines)', () => {
  test('quarantines memory when path does not exist', async () => {
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'memory at src/never-existed.ts');
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'mem');
    await scheduler.drain();

    const event = getLastQuarantineEvent(db, 'memory', 'mem', 'user');
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event.toState).toBe('quarantined');
    expect(event.motivo).toBe('conflict');
    expect(event.trigger).toBe('verify_failed');
    expect(event.actor).toBe('loop_cold');
    // Stderr line for operator visibility.
    expect(errs.join('')).toMatch(/verify_failed quarantined user\/mem/);
  });

  test('evidence carries claim + expected + observed', async () => {
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'see src/gone.ts and src/also-gone.ts');
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'mem');
    await scheduler.drain();

    const event = getLastQuarantineEvent(db, 'memory', 'mem', 'user');
    expect(event).not.toBeNull();
    if (event === null) return;
    // Evidence is JSON-stringified at INSERT; parse to inspect
    // structured fields. The repo's appendEvictionEvent runs
    // redaction over the JSON before persist, so non-string
    // values (e.g., the `failures` counter) survive intact.
    const evidence = JSON.parse(event.evidenceJson) as Record<string, unknown>;
    expect(typeof evidence.claim).toBe('string');
    expect(typeof evidence.observed).toBe('string');
    expect(evidence.verifier_id).toBe('project-fs');
    expect(evidence.failures).toBe(1);
  });
});

describe('createVerifyScheduler — unknown verdict (forensic stderr only)', () => {
  test('prose-only memory produces verify_unknown stderr, no state change', async () => {
    writeIndex(roots.user, '- [Pref](pref.md) — h\n');
    writeProjectMemory(roots.user, 'pref', 'we use TypeScript strict mode');
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'pref');
    await scheduler.drain();

    expect(getLastQuarantineEvent(db, 'memory', 'pref', 'user')).toBeNull();
    expect(errs.join('')).toMatch(/verify_unknown.*user\/pref/);
  });
});

describe('createVerifyScheduler — type gating', () => {
  test('non-factual memory (type=feedback) is skipped silently', async () => {
    writeIndex(roots.user, '- [Fb](fb.md) — h\n');
    mkdirSync(roots.user, { recursive: true });
    writeFileSync(
      join(roots.user, 'fb.md'),
      [
        '---',
        'name: fb',
        'description: feedback rule',
        'type: feedback',
        'source: user_explicit',
        '---',
        '',
        'src/missing.ts is mentioned but type=feedback gates the verifier',
      ].join('\n'),
    );
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'fb');
    await scheduler.drain();

    // No state change AND no verify_unknown — the type filter
    // short-circuits before the verifier runs.
    expect(getLastQuarantineEvent(db, 'memory', 'fb', 'user')).toBeNull();
    expect(errs.join('')).toBe('');
  });

  test('type=reference is skipped (no reference verifier in v1)', async () => {
    writeIndex(roots.user, '- [Ref](ref.md) — h\n');
    mkdirSync(roots.user, { recursive: true });
    writeFileSync(
      join(roots.user, 'ref.md'),
      [
        '---',
        'name: ref',
        'description: external pointer',
        'type: reference',
        'source: user_explicit',
        '---',
        '',
        'see Linear project FOO',
      ].join('\n'),
    );
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'ref');
    await scheduler.drain();

    expect(getLastQuarantineEvent(db, 'memory', 'ref', 'user')).toBeNull();
    expect(errs.join('')).toBe('');
  });
});

describe('createVerifyScheduler — idempotency + dedupe', () => {
  test('enqueue twice runs verifier once', async () => {
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'see src/missing.ts');
    let calls = 0;
    const verifiers: Map<MemoryType, MemoryVerifier> = new Map();
    verifiers.set('project', {
      id: 'count-verifier',
      verify: async () => {
        calls += 1;
        return { kind: 'unknown', reason: 'counter' } satisfies VerifyResult;
      },
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const scheduler = createVerifyScheduler({
      db,
      sessionId,
      registry,
      repoRoot: repo,
      verifiers,
      errSink: () => {},
    });

    scheduler.enqueue('user', 'mem');
    scheduler.enqueue('user', 'mem');
    scheduler.enqueue('user', 'mem');
    await scheduler.drain();
    expect(calls).toBe(1);
  });

  test('pollAndEnqueue picks up new provenance rows added since last poll', async () => {
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeProjectMemory(roots.user, 'a', 'see src/missing-a.ts');
    writeProjectMemory(roots.user, 'b', 'see src/missing-b.ts');
    // Seed provenance for memory 'a' only — initial poll should
    // verify 'a' but not 'b'.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'a',
      surface: 'eager',
    });
    const errs: string[] = [];
    const scheduler = buildDeps(errs);
    scheduler.pollAndEnqueue();
    await scheduler.drain();
    expect(getLastQuarantineEvent(db, 'memory', 'a', 'user')).not.toBeNull();
    expect(getLastQuarantineEvent(db, 'memory', 'b', 'user')).toBeNull();

    // Now seed 'b' and re-poll. The scheduler picks up the new
    // (scope, name) but the dedupe set keeps 'a' from re-firing.
    recordProvenance(db, {
      sessionId,
      toolCallId: null,
      memoryScope: 'user',
      memoryName: 'b',
      surface: 'eager',
    });
    scheduler.pollAndEnqueue();
    await scheduler.drain();
    expect(getLastQuarantineEvent(db, 'memory', 'a', 'user')).not.toBeNull(); // unchanged
    expect(getLastQuarantineEvent(db, 'memory', 'b', 'user')).not.toBeNull();
  });
});

describe('createVerifyScheduler — failure isolation', () => {
  test('verifier throws → stderr log, no state change, no propagation', async () => {
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'see src/foo.ts');
    const verifiers: Map<MemoryType, MemoryVerifier> = new Map();
    verifiers.set('project', {
      id: 'throwing',
      verify: async () => {
        throw new Error('synthetic verifier failure');
      },
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const errs: string[] = [];
    const scheduler = createVerifyScheduler({
      db,
      sessionId,
      registry,
      repoRoot: repo,
      verifiers,
      errSink: (m) => errs.push(m),
    });

    scheduler.enqueue('user', 'mem');
    // Drain MUST resolve cleanly even when the verifier threw.
    await scheduler.drain();

    expect(getLastQuarantineEvent(db, 'memory', 'mem', 'user')).toBeNull();
    expect(errs.join('')).toMatch(/verify error for user\/mem.*synthetic verifier failure/);
  });

  test('missing memory body → silent skip', async () => {
    // Memory is in the index but no body file. peek returns
    // 'missing'; scheduler returns silently (no state change, no
    // stderr noise — operator sees the missing-body condition via
    // /memory list flags).
    writeIndex(roots.user, '- [Ghost](ghost.md) — h\n');
    // No body file.
    const errs: string[] = [];
    const scheduler = buildDeps(errs);

    scheduler.enqueue('user', 'ghost');
    await scheduler.drain();

    expect(getLastQuarantineEvent(db, 'memory', 'ghost', 'user')).toBeNull();
    expect(errs.join('')).toBe('');
  });
});

describe('createVerifyScheduler — drain timeout', () => {
  test('drain returns within the timeout even if verifier hangs', async () => {
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeProjectMemory(roots.user, 'mem', 'see src/missing.ts');
    const verifiers: Map<MemoryType, MemoryVerifier> = new Map();
    verifiers.set('project', {
      id: 'hanging',
      verify: () => new Promise(() => {}), // never resolves
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const scheduler = createVerifyScheduler({
      db,
      sessionId,
      registry,
      repoRoot: repo,
      verifiers,
      errSink: () => {},
    });

    scheduler.enqueue('user', 'mem');
    const start = Date.now();
    await scheduler.drain(50); // tight timeout for the test
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // generous CI bound
  });
});
