import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, TCPSocketListener } from 'bun';
import { waitFor } from '../../src/wait/index.ts';

const tempRoots: string[] = [];

const mktemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'forja-wait-'));
  tempRoots.push(d);
  return d;
};

afterEach(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('wait_for: sleep', () => {
  test('matches at the requested duration', async () => {
    const start = Date.now();
    const r = await waitFor({ kind: 'sleep', durationMs: 200 }, { timeoutMs: 5000 });
    const elapsed = Date.now() - start;
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('sleep');
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(150);
  });

  test('respects abort signal mid-sleep', async () => {
    const ac = new AbortController();
    const promise = waitFor(
      { kind: 'sleep', durationMs: 30000 },
      { timeoutMs: 30000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    const r = await promise;
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('aborted');
    expect(r.elapsedMs).toBeLessThan(500);
  });

  test('reports timeout when sleep duration exceeds timeoutMs', async () => {
    const r = await waitFor({ kind: 'sleep', durationMs: 5000 }, { timeoutMs: 100 });
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });
});

describe('wait_for: file_exists', () => {
  test('matches immediately when file already present', async () => {
    const dir = mktemp();
    const path = join(dir, 'present.txt');
    writeFileSync(path, 'hi');
    const r = await waitFor({ kind: 'file_exists', path }, { timeoutMs: 5000, pollIntervalMs: 50 });
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('file_exists');
    expect(r.payload?.path).toBe(path);
    expect(r.elapsedMs).toBeLessThan(200);
  });

  test('matches when file is created during the wait', async () => {
    const dir = mktemp();
    const path = join(dir, 'will-appear.txt');
    setTimeout(() => writeFileSync(path, 'x'), 150);
    const r = await waitFor({ kind: 'file_exists', path }, { timeoutMs: 5000, pollIntervalMs: 50 });
    expect(r.matched).toBe(true);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  test('reports timeout when file never appears', async () => {
    const dir = mktemp();
    const path = join(dir, 'never.txt');
    const r = await waitFor({ kind: 'file_exists', path }, { timeoutMs: 200, pollIntervalMs: 50 });
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });
});

describe('wait_for: file_change', () => {
  test('matches when an existing file is modified', async () => {
    const dir = mktemp();
    const path = join(dir, 'mutated.txt');
    writeFileSync(path, 'original');
    setTimeout(() => writeFileSync(path, 'mutated'), 200);
    const r = await waitFor({ kind: 'file_change', path }, { timeoutMs: 5000, pollIntervalMs: 50 });
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('file_change');
    expect(r.payload?.path).toBe(path);
    expect(typeof r.payload?.mtimeMs).toBe('number');
  });

  test('matches when a missing file is created (mtime null → present)', async () => {
    const dir = mktemp();
    const path = join(dir, 'created.txt');
    setTimeout(() => writeFileSync(path, 'x'), 150);
    const r = await waitFor({ kind: 'file_change', path }, { timeoutMs: 5000, pollIntervalMs: 50 });
    expect(r.matched).toBe(true);
    expect(r.payload?.previousMtimeMs).toBeNull();
  });

  test('reports timeout when file mtime is unchanged', async () => {
    const dir = mktemp();
    const path = join(dir, 'stable.txt');
    writeFileSync(path, 'x');
    // Pin mtime to a known past value so jitter from the previous
    // write doesn't accidentally satisfy the condition.
    utimesSync(path, new Date('2020-01-01'), new Date('2020-01-01'));
    const r = await waitFor({ kind: 'file_change', path }, { timeoutMs: 200, pollIntervalMs: 50 });
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });
});

describe('wait_for: port_open', () => {
  let listener: TCPSocketListener<undefined> | null = null;

  afterEach(() => {
    if (listener !== null) {
      listener.stop(true);
      listener = null;
    }
  });

  test('matches once a TCP server starts accepting connections', async () => {
    // Open a listener on an ephemeral port immediately. The wait
    // should match on the first poll because the port is already
    // accepting. Latency is bounded by tryConnect's async path,
    // not by pollIntervalMs.
    listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {},
        open(s) {
          s.end();
        },
      },
    });
    const port = listener.port;
    expect(typeof port).toBe('number');

    const r = await waitFor(
      { kind: 'port_open', host: '127.0.0.1', port },
      { timeoutMs: 5000, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('port_open');
    expect(r.payload?.port).toBe(port);
    expect(r.elapsedMs).toBeLessThan(2000);
  });

  test('reports timeout when no server listens on the port', async () => {
    // High random port unlikely to be in use.
    const r = await waitFor(
      { kind: 'port_open', host: '127.0.0.1', port: 9 },
      { timeoutMs: 300, pollIntervalMs: 50 },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });

  test('honors abort mid-connect-attempt without waiting full timeout', async () => {
    // Probe a non-routable host (RFC5737 documentation prefix). The
    // OS connect() will hang for OS-level seconds without our floor;
    // with the signal cascade in place, abort settles tryConnect
    // immediately. Without the cascade, we'd wait the full
    // `MIN_CONNECT_TIMEOUT_MS` floor (200ms) before noticing.
    const ac = new AbortController();
    const start = Date.now();
    const promise = waitFor(
      { kind: 'port_open', host: '192.0.2.1', port: 81 },
      { timeoutMs: 30000, pollIntervalMs: 1000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    const r = await promise;
    const elapsed = Date.now() - start;
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('aborted');
    // Without the cascade, this would be ~MIN_CONNECT_TIMEOUT_MS+
    // pollIntervalMs (1200ms) at minimum. With it, < 500ms.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('wait_for: http_response', () => {
  let server: Server<unknown> | null = null;
  let baseUrl = '';

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/ok') return new Response(null, { status: 200 });
        if (url.pathname === '/teapot') return new Response(null, { status: 418 });
        if (url.pathname === '/redirect') {
          return new Response(null, { status: 301, headers: { Location: '/ok' } });
        }
        return new Response(null, { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    if (server !== null) {
      server.stop(true);
      server = null;
    }
  });

  test('matches any 2xx by default', async () => {
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/ok` },
      { timeoutMs: 5000, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(true);
    expect(r.conditionMet).toBe('http_response');
    expect(r.payload?.status).toBe(200);
  });

  test('matches the specified status code exactly', async () => {
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/teapot`, status: 418 },
      { timeoutMs: 5000, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(true);
    expect(r.payload?.status).toBe(418);
  });

  test('does NOT match unexpected status when one is specified', async () => {
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/ok`, status: 418 },
      { timeoutMs: 300, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });

  test('reports timeout when the server never responds matching', async () => {
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/missing`, status: 200 },
      { timeoutMs: 300, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });

  test('default redirect=follow traverses 3xx to the final 2xx', async () => {
    // /redirect → 301 Location: /ok → 200. With default follow,
    // the matched status is the FINAL 200, not the intermediate 301.
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/redirect` },
      { timeoutMs: 5000, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(true);
    expect(r.payload?.status).toBe(200);
  });

  test('redirect=manual surfaces the literal 3xx status', async () => {
    // Same endpoint, but redirect: 'manual' returns the literal 301.
    // Default 2xx check does NOT match — caller must opt in via
    // status: 301.
    const noMatch = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/redirect`, redirect: 'manual' },
      { timeoutMs: 200, pollIntervalMs: 100 },
    );
    expect(noMatch.matched).toBe(false);

    const matched = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/redirect`, status: 301, redirect: 'manual' },
      { timeoutMs: 5000, pollIntervalMs: 100 },
    );
    expect(matched.matched).toBe(true);
    expect(matched.payload?.status).toBe(301);
  });

  test('handles network error gracefully (server down)', async () => {
    // Stop the server before the wait — fetch should error each poll;
    // wait reports timeout.
    if (server !== null) {
      server.stop(true);
      server = null;
    }
    const r = await waitFor(
      { kind: 'http_response', url: `${baseUrl}/ok` },
      { timeoutMs: 300, pollIntervalMs: 100 },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('timeout');
  });
});

describe('wait_for: pre-aborted signal', () => {
  test('returns immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await waitFor(
      { kind: 'sleep', durationMs: 5000 },
      { timeoutMs: 5000, signal: ac.signal },
    );
    expect(r.matched).toBe(false);
    expect(r.conditionMet).toBe('aborted');
    expect(r.elapsedMs).toBe(0);
  });
});
