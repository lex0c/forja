import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  getUpdateCheck,
  markNotified,
  recordUpdateProbe,
} from '../../src/storage/repos/update-check.ts';
import { fetchLatestVersion, refreshUpdateCache } from '../../src/update/refresh.ts';

const freshDb = () => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

// Spins up a fake GitHub releases endpoint on an ephemeral port for the body
// of `fn`, then tears it down (even if the assertion throws).
const withServer = async <T>(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (url: string) => Promise<T>,
): Promise<T> => {
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    return await fn(`http://127.0.0.1:${server.port}/`);
  } finally {
    server.stop(true);
  }
};

describe('update-check repo', () => {
  test('seeded singleton starts empty; probe + notify update it', () => {
    const db = freshDb();
    expect(getUpdateCheck(db)).toEqual({
      lastCheckedAt: null,
      latestSeen: null,
      notifiedVersion: null,
    });
    recordUpdateProbe(db, 12_345, '0.2.0');
    expect(getUpdateCheck(db)).toEqual({
      lastCheckedAt: 12_345,
      latestSeen: '0.2.0',
      notifiedVersion: null,
    });
    markNotified(db, '0.2.0');
    expect(getUpdateCheck(db).notifiedVersion).toBe('0.2.0');
    db.close();
  });
});

describe('fetchLatestVersion', () => {
  test('parses tag_name and strips the v', async () => {
    await withServer(
      () => new Response(JSON.stringify({ tag_name: 'v0.2.0' })),
      async (url) => expect(await fetchLatestVersion(url)).toBe('0.2.0'),
    );
  });
  test('non-2xx → null', async () => {
    await withServer(
      () => new Response('nope', { status: 404 }),
      async (url) => expect(await fetchLatestVersion(url)).toBeNull(),
    );
  });
  test('garbage body → null', async () => {
    await withServer(
      () => new Response('not json at all'),
      async (url) => expect(await fetchLatestVersion(url)).toBeNull(),
    );
  });
  test('non-semver tag → null', async () => {
    await withServer(
      () => new Response(JSON.stringify({ tag_name: 'nightly' })),
      async (url) => expect(await fetchLatestVersion(url)).toBeNull(),
    );
  });
  test('oversized body → null (untrusted response, capped)', async () => {
    const pad = 'x'.repeat(70 * 1024);
    await withServer(
      () => new Response(JSON.stringify({ tag_name: '0.2.0', pad })),
      async (url) => expect(await fetchLatestVersion(url)).toBeNull(),
    );
  });
  test('connection refused → null (fail-silent)', async () => {
    expect(await fetchLatestVersion('http://127.0.0.1:1/')).toBeNull();
  });
});

describe('refreshUpdateCache', () => {
  test('success records the probe; throttle skips within interval', async () => {
    const db = freshDb();
    await withServer(
      () => new Response(JSON.stringify({ tag_name: '0.2.0' })),
      async (url) => refreshUpdateCache(db, { now: 1000, url, intervalMs: 10_000 }),
    );
    expect(getUpdateCheck(db)).toMatchObject({ lastCheckedAt: 1000, latestSeen: '0.2.0' });
    // Within the interval: even though the server now offers 0.3.0, the
    // throttle skips the probe and the cache stays put.
    await withServer(
      () => new Response(JSON.stringify({ tag_name: '0.3.0' })),
      async (url) => refreshUpdateCache(db, { now: 6000, url, intervalMs: 10_000 }),
    );
    expect(getUpdateCheck(db).latestSeen).toBe('0.2.0');
    db.close();
  });
  test('failed probe records nothing (retry next boot)', async () => {
    const db = freshDb();
    await refreshUpdateCache(db, { now: 1000, url: 'http://127.0.0.1:1/' });
    expect(getUpdateCheck(db)).toEqual({
      lastCheckedAt: null,
      latestSeen: null,
      notifiedVersion: null,
    });
    db.close();
  });
});
