// Boot-probe tests for the shared-corpus trust orchestrator
// (S5/T5.2 + T5.3). Exercises the probe's four-way state machine
// against a real registry + DB + filesystem:
//
//   - seeded: no prior trust row → silent seed of current hash.
//   - unchanged: prior row matches current hash → no-op.
//   - reconfirmed: prior row differs + modal returns 'yes' → re-stamp.
//   - revoked: prior row differs + modal returns 'no' → clear row,
//     bulk-invalidate every state=active shared memory.
//
// Plus selectivity assertions: revoke only touches shared/active
// memories — user-scope and project_local stay untouched, and
// already-quarantined shared memories are skipped (not re-counted).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { probeSharedTrust } from '../../src/memory/trust-corpus-probe.ts';
import {
  computeSharedFingerprint,
  getSharedTrust,
  setSharedTrust,
} from '../../src/memory/trust-corpus.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-trust-probe-'));
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

const writeBody = (
  dir: string,
  name: string,
  body: string,
  state: 'active' | 'quarantined' = 'active',
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    'type: feedback',
    'source: user_explicit',
    `state: ${state}`,
  ];
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

let db: DB;
let repo: string;
let roots: ScopeRoots;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  repo = makeTmp();
  roots = makeRoots(repo);
});

afterEach(() => {
  db.close();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('probeSharedTrust — state machine', () => {
  test('seeded: no prior row → silent stamp, no modal fired', async () => {
    writeIndex(roots.projectShared, '- [Alpha](alpha.md) — hook\n');
    writeBody(roots.projectShared, 'alpha', 'body A');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    let modalCalls = 0;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCalls++;
        return 'yes';
      },
      now: () => 1_700_000_000_000,
    });

    expect(modalCalls).toBe(0);
    expect(result.kind).toBe('seeded');
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
    expect(stored?.lastConfirmedAtMs).toBe(1_700_000_000_000);
  });

  test('unchanged: prior row matches current hash → no-op, no modal', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const currentHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, currentHash, 999);

    let modalCalls = 0;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCalls++;
        return 'no';
      },
    });

    expect(modalCalls).toBe(0);
    expect(result.kind).toBe('unchanged');
    // Trust row remains pinned to the original timestamp — no-op
    // doesn't bump it.
    expect(getSharedTrust(db, roots.projectShared)?.lastConfirmedAtMs).toBe(999);
  });

  test('reconfirmed: hash differs + modal yes → re-stamp', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'old body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);

    // Simulate corpus drift (operator pulled a commit modifying a.md).
    writeBody(roots.projectShared, 'a', 'new body — modified after trust');
    const newHash = computeSharedFingerprint(roots.projectShared) as string;
    expect(newHash).not.toBe(oldHash);

    let modalArgs: {
      path: string;
      corpusFiles: readonly { name: string; bytes: number }[];
    } | null = null;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async (args) => {
        modalArgs = args;
        return 'yes';
      },
      now: () => 2_000,
    });

    const captured = modalArgs as null | {
      path: string;
      corpusFiles: readonly { name: string; bytes: number }[];
    };
    expect(captured).not.toBeNull();
    if (captured !== null) {
      expect(captured.path).toBe(roots.projectShared);
      expect(captured.corpusFiles.length).toBeGreaterThan(0);
    }
    expect(result.kind).toBe('reconfirmed');
    if (result.kind === 'reconfirmed') {
      expect(result.oldHash).toBe(oldHash);
      expect(result.newHash).toBe(newHash);
    }
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(newHash);
    expect(stored?.lastConfirmedAtMs).toBe(2_000);
  });

  test('revoked: hash differs + modal no → clear row + bulk-invalidate active shared', async () => {
    writeIndex(roots.projectShared, '- [Alpha](alpha.md) — h\n- [Beta](beta.md) — h\n');
    writeBody(roots.projectShared, 'alpha', 'body A');
    writeBody(roots.projectShared, 'beta', 'body B');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);

    // Simulate corpus drift.
    writeBody(roots.projectShared, 'alpha', 'tampered body');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
      now: () => 5_000,
    });

    expect(result.kind).toBe('revoked');
    if (result.kind === 'revoked') {
      expect(result.failed).toEqual([]);
      const names = result.invalidated.map((q) => q.name).sort();
      expect(names).toEqual(['alpha', 'beta']);
    }

    // Trust row cleared so the NEXT boot re-prompts.
    expect(getSharedTrust(db, roots.projectShared)).toBeNull();

    // Both memories now report state=invalidated when re-read via
    // the registry's state filter.
    const stillActive = registry.list({ scope: 'project_shared', states: ['active'] });
    expect(stillActive).toEqual([]);
    const invalidated = registry.list({ scope: 'project_shared', states: ['invalidated'] });
    expect(invalidated.map((l) => l.name).sort()).toEqual(['alpha', 'beta']);
  });

  test('revoked: cancel answer is treated identically to no', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'cancel',
    });
    expect(result.kind).toBe('revoked');
    expect(getSharedTrust(db, roots.projectShared)).toBeNull();
  });
});

describe('probeSharedTrust — selectivity', () => {
  test('revoke does NOT touch user-scope or project_local memories', async () => {
    // Memories in every scope.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'shared body');
    writeIndex(roots.user, '- [U](u.md) — h\n');
    writeBody(roots.user, 'u', 'user body');
    writeIndex(roots.projectLocal, '- [L](l.md) — h\n');
    writeBody(roots.projectLocal, 'l', 'local body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(registry.list({ scope: 'user', states: ['active'] }).map((l) => l.name)).toEqual(['u']);
    expect(
      registry.list({ scope: 'project_local', states: ['active'] }).map((l) => l.name),
    ).toEqual(['l']);
    expect(registry.list({ scope: 'project_shared', states: ['active'] })).toEqual([]);
  });

  test('revoke does not invalidate already-quarantined shared memories', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n- [B](b.md) — h\n');
    // a starts active; b starts quarantined.
    writeBody(roots.projectShared, 'a', 'body A');
    writeBody(roots.projectShared, 'b', 'body B', 'quarantined');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(result.kind).toBe('revoked');
    if (result.kind === 'revoked') {
      // Only `a` (the only active one) transitioned this round.
      expect(result.invalidated.map((q) => q.name)).toEqual(['a']);
      expect(result.failed).toEqual([]);
    }
  });

  test('empty corpus (no shared memories) still seeds/probes without error', async () => {
    // No writeIndex / no writeBody — sharedRoot doesn't even exist yet.
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });
    expect(result.kind).toBe('seeded');
  });
});
