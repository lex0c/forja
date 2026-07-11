import { beforeEach, describe, expect, test } from 'bun:test';
import { canonicalHash, canonicalize } from '../../src/permissions/canonical.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  archivePolicy,
  countPolicyArchive,
  getPolicyArchive,
  listPolicyArchive,
} from '../../src/storage/repos/policy-archive.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('policy_archive — archivePolicy', () => {
  test('first call inserts a fresh row with first_seen_ms = last_seen_ms = now', () => {
    const r = archivePolicy(db, {
      policy_hash: 'sha256:fixture-a',
      canonical_json: '{"defaults":{"mode":"strict"}}',
      now: 1000,
    });
    expect(r.policy_hash).toBe('sha256:fixture-a');
    expect(r.canonical_json).toBe('{"defaults":{"mode":"strict"}}');
    expect(r.first_seen_ms).toBe(1000);
    expect(r.last_seen_ms).toBe(1000);
  });

  test('upsert on same hash keeps first_seen, advances last_seen', () => {
    archivePolicy(db, {
      policy_hash: 'sha256:fixture-b',
      canonical_json: '{"x":1}',
      now: 1000,
    });
    const r = archivePolicy(db, {
      policy_hash: 'sha256:fixture-b',
      canonical_json: '{"x":1}',
      now: 5000,
    });
    expect(r.first_seen_ms).toBe(1000);
    expect(r.last_seen_ms).toBe(5000);
  });

  test('different hash inserts a second row, both queryable', () => {
    archivePolicy(db, {
      policy_hash: 'sha256:fixture-1',
      canonical_json: '{"a":1}',
      now: 100,
    });
    archivePolicy(db, {
      policy_hash: 'sha256:fixture-2',
      canonical_json: '{"a":2}',
      now: 200,
    });
    expect(countPolicyArchive(db)).toBe(2);
    expect(getPolicyArchive(db, 'sha256:fixture-1')?.canonical_json).toBe('{"a":1}');
    expect(getPolicyArchive(db, 'sha256:fixture-2')?.canonical_json).toBe('{"a":2}');
  });

  test('repeated upserts do NOT duplicate rows', () => {
    for (let i = 0; i < 5; i += 1) {
      archivePolicy(db, {
        policy_hash: 'sha256:same',
        canonical_json: '{"a":1}',
        now: 1000 + i,
      });
    }
    expect(countPolicyArchive(db)).toBe(1);
  });

  test('roundtrip invariant: canonicalHash(JSON.parse(canonical_json)) === policy_hash', () => {
    // Pin the §17 prerequisite: the archived bytes regenerate the
    // hash they were stored under. Without this invariant, replay
    // can't reconstruct the policy deterministically.
    const policy = { defaults: { mode: 'strict' as const }, tools: { bash: { allow: ['ls *'] } } };
    const canonical = canonicalize(policy);
    const hash = `sha256:${canonicalHash(policy)}`;
    archivePolicy(db, { policy_hash: hash, canonical_json: canonical, now: 1 });

    const stored = getPolicyArchive(db, hash);
    expect(stored).not.toBeNull();
    if (stored === null) return;
    const parsed = JSON.parse(stored.canonical_json) as typeof policy;
    expect(`sha256:${canonicalHash(parsed)}`).toBe(hash);
  });
});

describe('policy_archive — read-side', () => {
  test('getPolicyArchive returns null for unknown hash', () => {
    expect(getPolicyArchive(db, 'sha256:never-stored')).toBeNull();
  });

  test('listPolicyArchive returns chronological by first_seen_ms', () => {
    archivePolicy(db, {
      policy_hash: 'sha256:b',
      canonical_json: '{}',
      now: 200,
    });
    archivePolicy(db, {
      policy_hash: 'sha256:a',
      canonical_json: '{}',
      now: 100,
    });
    archivePolicy(db, {
      policy_hash: 'sha256:c',
      canonical_json: '{}',
      now: 300,
    });
    const list = listPolicyArchive(db);
    expect(list.map((r) => r.policy_hash)).toEqual(['sha256:a', 'sha256:b', 'sha256:c']);
  });

  test('countPolicyArchive starts at 0', () => {
    expect(countPolicyArchive(db)).toBe(0);
  });
});
