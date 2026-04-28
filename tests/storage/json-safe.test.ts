import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { StorageJsonError } from '../../src/storage/json-safe.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('storage JSON safety', () => {
  test('parse error in messages.content surfaces as StorageJsonError', () => {
    const session = createSession(db, { model: 'm', cwd: '/p' });
    // Inject a row whose content column is invalid JSON. The storage path
    // doesn't expose this — we reach for raw SQL to simulate FS-level
    // tampering or version-skew corruption.
    db.query(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', '{not json', 0)`,
    ).run('msg-1', session.id);

    let err: unknown = null;
    try {
      getMessage(db, 'msg-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StorageJsonError);
    if (err instanceof StorageJsonError) {
      expect(err.context).toContain('messages(msg-1).content');
      expect(err.message).toContain('corrupt JSON');
    }
  });
});
