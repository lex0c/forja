import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type InsertServerInput,
  type RecordManifestDecisionInput,
  bumpServerCounters,
  deleteServer,
  getManifestDecision,
  getServer,
  insertServer,
  latestTrustedManifest,
  listManifestHistory,
  listServers,
  patchServer,
  recordManifestDecision,
  updateManifestDecision,
} from '../../src/storage/repos/mcp-servers.ts';

let db: DB;

const serverInput = (overrides: Partial<InsertServerInput> = {}): InsertServerInput => ({
  name: 'postgres',
  transport: 'stdio',
  command: '["mcp-server-postgres","--dsn","$DATABASE_URL"]',
  url: null,
  source: 'user',
  state: 'trust_pending',
  ...overrides,
});

const manifestInput = (
  overrides: Partial<RecordManifestDecisionInput> = {},
): RecordManifestDecisionInput => ({
  server_name: 'postgres',
  hash: 'h1',
  previous_hash: null,
  manifest_json: '{"tools":[]}',
  protocol_version: '2024-11-05',
  server_version: '1.2.3',
  decision: 'granted',
  decided_by: 'user',
  decided_at: 1000,
  approval_id: null,
  ...overrides,
});

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('mcp_servers repo: insert + read', () => {
  test('insertServer materializes a row with DB-default counters/version', () => {
    insertServer(db, serverInput());
    const row = getServer(db, 'postgres');
    expect(row).not.toBeNull();
    expect(row?.transport).toBe('stdio');
    expect(row?.command).toBe('["mcp-server-postgres","--dsn","$DATABASE_URL"]');
    expect(row?.url).toBeNull();
    expect(row?.source).toBe('user');
    expect(row?.state).toBe('trust_pending');
    expect(row?.current_manifest_hash).toBeNull();
    expect(row?.total_calls).toBe(0);
    expect(row?.total_tokens_in).toBe(0);
    expect(row?.audit_schema_version).toBe(1);
  });

  test('getServer returns null for an unknown name', () => {
    expect(getServer(db, 'nope')).toBeNull();
  });

  test('listServers returns every server ordered by name', () => {
    insertServer(db, serverInput({ name: 'zulu' }));
    insertServer(db, serverInput({ name: 'alpha' }));
    insertServer(db, serverInput({ name: 'mike' }));
    expect(listServers(db).map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu']);
  });
});

describe('mcp_servers repo: patch + counters + delete', () => {
  beforeEach(() => insertServer(db, serverInput()));

  test('patchServer writes the mutable columns', () => {
    patchServer(db, 'postgres', {
      state: 'active',
      current_manifest_hash: 'abc',
      protocol_version: '2024-11-05',
      server_version: '9.9',
      last_connected_at: 4242,
    });
    const row = getServer(db, 'postgres');
    expect(row?.state).toBe('active');
    expect(row?.current_manifest_hash).toBe('abc');
    expect(row?.last_connected_at).toBe(4242);
  });

  test('patchServer can set a column back to null (clearing last_error on recover)', () => {
    patchServer(db, 'postgres', { state: 'degraded', last_error: 'boom' });
    expect(getServer(db, 'postgres')?.last_error).toBe('boom');
    patchServer(db, 'postgres', { state: 'active', last_error: null });
    expect(getServer(db, 'postgres')?.last_error).toBeNull();
  });

  test('patchServer with an empty patch is a no-op (does not throw)', () => {
    expect(() => patchServer(db, 'postgres', {})).not.toThrow();
    expect(getServer(db, 'postgres')?.state).toBe('trust_pending');
  });

  test('bumpServerCounters accumulates', () => {
    bumpServerCounters(db, 'postgres', { calls: 1, tokensIn: 500 });
    bumpServerCounters(db, 'postgres', { calls: 2, tokensIn: 250 });
    const row = getServer(db, 'postgres');
    expect(row?.total_calls).toBe(3);
    expect(row?.total_tokens_in).toBe(750);
  });

  test('deleteServer removes the row', () => {
    deleteServer(db, 'postgres');
    expect(getServer(db, 'postgres')).toBeNull();
  });
});

describe('mcp_servers schema: CHECK constraints', () => {
  test('rejects an unknown transport', () => {
    expect(() => insertServer(db, serverInput({ transport: 'ftp' }))).toThrow();
  });

  test('rejects an unknown state', () => {
    expect(() => insertServer(db, serverInput({ state: 'bogus' }))).toThrow();
  });

  test('accepts every declared state', () => {
    const states = [
      'disconnected',
      'handshaking',
      'trust_pending',
      'trusted',
      'active',
      'degraded',
      'denied',
      'error',
    ];
    for (const [i, state] of states.entries()) {
      expect(() => insertServer(db, serverInput({ name: `s${i}`, state }))).not.toThrow();
    }
  });
});

describe('mcp_manifest_history repo: record + lookup', () => {
  test('recordManifestDecision returns an autoincrement id and round-trips', () => {
    const id = recordManifestDecision(db, manifestInput());
    expect(id).toBeGreaterThan(0);
    const row = getManifestDecision(db, 'postgres', 'h1');
    expect(row?.id).toBe(id);
    expect(row?.decision).toBe('granted');
    expect(row?.manifest_json).toBe('{"tools":[]}');
    expect(row?.previous_hash).toBeNull();
  });

  test('getManifestDecision returns null for an unrecorded hash', () => {
    recordManifestDecision(db, manifestInput());
    expect(getManifestDecision(db, 'postgres', 'other')).toBeNull();
  });

  test('latestTrustedManifest returns the newest granted hash and ignores denials', () => {
    recordManifestDecision(db, manifestInput({ hash: 'h1', decided_at: 1000 }));
    recordManifestDecision(
      db,
      manifestInput({ hash: 'h2', previous_hash: 'h1', decided_at: 2000 }),
    );
    recordManifestDecision(db, manifestInput({ hash: 'h3', decision: 'denied', decided_at: 3000 }));
    expect(latestTrustedManifest(db, 'postgres')?.hash).toBe('h2');
  });

  test('latestTrustedManifest is null when nothing was ever granted', () => {
    recordManifestDecision(db, manifestInput({ hash: 'hx', decision: 'denied' }));
    expect(latestTrustedManifest(db, 'postgres')).toBeNull();
  });

  test('listManifestHistory returns all rows newest-first', () => {
    recordManifestDecision(db, manifestInput({ hash: 'h1', decided_at: 1000 }));
    recordManifestDecision(db, manifestInput({ hash: 'h2', decided_at: 2000 }));
    expect(listManifestHistory(db, 'postgres').map((r) => r.hash)).toEqual(['h2', 'h1']);
  });

  test('updateManifestDecision flips an existing (server, hash) decision in place', () => {
    // The (server, hash) pair is UNIQUE, so a decline the operator later approves
    // can't be appended — it must update the existing row so latestTrustedManifest
    // sees the grant on the next boot.
    recordManifestDecision(db, manifestInput({ hash: 'h1', decision: 'denied', decided_at: 1000 }));
    expect(latestTrustedManifest(db, 'postgres')).toBeNull();

    const changed = updateManifestDecision(db, 'postgres', 'h1', {
      decision: 'granted',
      decided_by: 'auto_approve',
      decided_at: 2000,
    });
    expect(changed).toBe(true);
    const row = getManifestDecision(db, 'postgres', 'h1');
    expect(row?.decision).toBe('granted');
    expect(row?.decided_by).toBe('auto_approve');
    expect(row?.decided_at).toBe(2000);
    expect(latestTrustedManifest(db, 'postgres')?.hash).toBe('h1'); // now durable
  });

  test('updateManifestDecision returns false when no row matches', () => {
    expect(
      updateManifestDecision(db, 'postgres', 'missing', {
        decision: 'granted',
        decided_by: 'user',
        decided_at: 1,
      }),
    ).toBe(false);
  });
});

describe('mcp_manifest_history schema: unique + CHECK', () => {
  test('(server_name, hash) is unique', () => {
    recordManifestDecision(db, manifestInput({ hash: 'dup' }));
    expect(() => recordManifestDecision(db, manifestInput({ hash: 'dup' }))).toThrow();
  });

  test('the same hash under a different server is allowed', () => {
    recordManifestDecision(db, manifestInput({ server_name: 'a', hash: 'shared' }));
    expect(() =>
      recordManifestDecision(db, manifestInput({ server_name: 'b', hash: 'shared' })),
    ).not.toThrow();
  });

  test('rejects an unknown decision', () => {
    expect(() => recordManifestDecision(db, manifestInput({ decision: 'maybe' }))).toThrow();
  });
});
