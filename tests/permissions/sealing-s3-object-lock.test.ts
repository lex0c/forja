// Slice 89 — S3 Object Lock sealing backend. Tests cover:
//   - object-key composition (with + without prefix);
//   - retain-until ISO date math (deterministic via `now` seam);
//   - SealStore flow (submit + append seal.log);
//   - error mapping (submit failure, invalid entry, ensure-dir failure);
//   - listing (uses the seal.log line format, same as other backends);
//   - factory wiring + dispatcher.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type S3SubmitParams,
  type S3Submitter,
  createS3ObjectLockSealer,
  defaultS3ObjectLockFactory,
} from '../../src/permissions/sealing-s3-object-lock.ts';

const SHA256_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

// ─── happy path ───────────────────────────────────────────────────────────

describe('createS3ObjectLockSealer — append flow', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-s3lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('successful submit: seal.log appended + submitter received expected params', () => {
    const captured: { params: S3SubmitParams | null } = { params: null };
    const submit: S3Submitter = (params) => {
      captured.params = params;
      return { ok: true };
    };
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'forja-seals',
      retentionDays: 365,
      keyPrefix: 'install-id/seals',
      region: 'us-east-1',
      submit,
      now: () => Date.UTC(2026, 0, 1, 0, 0, 0), // 2026-01-01T00:00:00Z
    });
    const entry = { seq: 1, ts: 1_700_000_000, hash: SHA256_HASH };
    const r = sealer.append(entry);
    expect(r.ok).toBe(true);
    const p = captured.params;
    if (p === null) throw new Error('submit not called');
    expect(p.bucket).toBe('forja-seals');
    expect(p.key).toBe(`install-id/seals/1-${entry.ts}.seal`);
    expect(p.region).toBe('us-east-1');
    expect(p.endpoint).toBeUndefined();
    // RetainUntil = 2026-01-01 + 365 days = 2027-01-01
    expect(p.retainUntilIso).toBe('2027-01-01T00:00:00.000Z');
    // Body is the seal-log line bytes verbatim.
    const expectedLine = `seq=1\tts=${entry.ts}\thash=${SHA256_HASH}\n`;
    expect(new TextDecoder().decode(p.body)).toBe(expectedLine);
    // seal.log gets the line written too.
    const log = readFileSync(join(dir, 'seal.log'), 'utf-8');
    expect(log).toBe(expectedLine);
  });

  test('omitted keyPrefix: object key has no prefix (bucket-root)', () => {
    const captured: { params: S3SubmitParams | null } = { params: null };
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 10,
      submit: (p) => {
        captured.params = p;
        return { ok: true };
      },
      now: () => 0,
    });
    sealer.append({ seq: 5, ts: 100, hash: SHA256_HASH });
    expect(captured.params?.key).toBe('5-100.seal');
  });

  test('endpoint passed through when configured (MinIO scenario)', () => {
    const captured: { params: S3SubmitParams | null } = { params: null };
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      endpoint: 'http://minio:9000',
      submit: (p) => {
        captured.params = p;
        return { ok: true };
      },
      now: () => 0,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(captured.params?.endpoint).toBe('http://minio:9000');
  });

  test('multiple appends produce distinct object keys', () => {
    const keys: string[] = [];
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: (p) => {
        keys.push(p.key);
        return { ok: true };
      },
      now: () => 0,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    sealer.append({ seq: 2, ts: 200, hash: OTHER_HASH });
    expect(keys).toEqual(['1-100.seal', '2-200.seal']);
  });

  test('retention math: now=epoch, retention=1 day → 1970-01-02', () => {
    const captured: { params: S3SubmitParams | null } = { params: null };
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: (p) => {
        captured.params = p;
        return { ok: true };
      },
      now: () => 0,
    });
    sealer.append({ seq: 1, ts: 0, hash: SHA256_HASH });
    expect(captured.params?.retainUntilIso).toBe('1970-01-02T00:00:00.000Z');
  });
});

// ─── error mapping ────────────────────────────────────────────────────────

describe('createS3ObjectLockSealer — error mapping', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-s3lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('submitter ok:false → S3-put-failed reason with the underlying message', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: false, reason: 'AccessDenied: assumed-role' }),
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('S3 put failed: AccessDenied: assumed-role');
    // No seal.log line on failure (submit failed BEFORE the local
    // append).
    expect(existsSync(join(dir, 'seal.log'))).toBe(false);
  });

  test('invalid entry shape (negative seq) rejected pre-submit', () => {
    let submitCalled = false;
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => {
        submitCalled = true;
        return { ok: true };
      },
    });
    const r = sealer.append({ seq: -1, ts: 100, hash: SHA256_HASH });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('invalid seal entry');
    expect(submitCalled).toBe(false);
  });

  test('hash containing whitespace rejected', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: 'aa bb' });
    expect(r.ok).toBe(false);
  });

  test('ensureDir failure → mapped to ok:false with ensure-dir-failed reason', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      ensureDir: () => {
        throw new Error('EACCES');
      },
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ensure seal dir failed: EACCES');
  });

  test('append-seal.log failure after S3 put succeeded → ok:false (best-effort)', () => {
    // S3 already accepted the object but the local index write
    // failed (disk full, permissions). Operator sees the local
    // diagnostic; the seal exists in S3 regardless.
    let submitCalled = false;
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => {
        submitCalled = true;
        return { ok: true };
      },
      append: () => {
        throw new Error('ENOSPC');
      },
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(submitCalled).toBe(true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('append seal.log failed: ENOSPC');
  });
});

// ─── list() ───────────────────────────────────────────────────────────────

describe('createS3ObjectLockSealer — list()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-s3lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('empty dir → empty list', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
    });
    expect(sealer.list()).toEqual([]);
  });

  test('appended entries listed in order', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    sealer.append({ seq: 2, ts: 200, hash: OTHER_HASH });
    expect(sealer.list()).toEqual([
      { seq: 1, ts: 100, hash: SHA256_HASH },
      { seq: 2, ts: 200, hash: OTHER_HASH },
    ]);
  });

  test('malformed line throws on list() (no silent skip)', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    writeFileSync(join(dir, 'seal.log'), 'garbage line\n');
    expect(() => sealer.list()).toThrow('malformed seal entry');
  });
});

// ─── factory + dispatcher ─────────────────────────────────────────────────

describe('defaultS3ObjectLockFactory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-s3lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('throws when path missing', () => {
    expect(() =>
      defaultS3ObjectLockFactory({
        mode: 's3-object-lock',
        bucket: 'b',
        retention_days: 1,
      }),
    ).toThrow('config.path is required');
  });

  test('throws when bucket missing', () => {
    expect(() =>
      defaultS3ObjectLockFactory({
        mode: 's3-object-lock',
        path: dir,
        retention_days: 1,
      }),
    ).toThrow('config.bucket is required');
  });

  test('throws when retention_days missing', () => {
    expect(() =>
      defaultS3ObjectLockFactory({
        mode: 's3-object-lock',
        path: dir,
        bucket: 'b',
      }),
    ).toThrow('config.retention_days is required');
  });

  test('returns a SealStore with full optional fields plumbed through', () => {
    const store = defaultS3ObjectLockFactory({
      mode: 's3-object-lock',
      path: dir,
      bucket: 'b',
      retention_days: 30,
      region: 'eu-west-1',
      endpoint: 'https://s3.example.com',
      key_prefix: 'forja/install-id',
    });
    expect(typeof store.append).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.close).toBe('function');
    store.close();
  });
});

describe('factoryForSealMode — s3-object-lock dispatch', () => {
  test('returns the s3-object-lock factory', async () => {
    const { factoryForSealMode } = await import('../../src/permissions/sealing.ts');
    const factory = factoryForSealMode('s3-object-lock');
    expect(factory).toBe(defaultS3ObjectLockFactory);
  });

  test('every shipped mode has a factory', async () => {
    const { factoryForSealMode } = await import('../../src/permissions/sealing.ts');
    // 'none' has no factory wired (it's a no-op upstream).
    for (const mode of ['worm-file', 'git-anchored', 'rfc3161-tsa', 's3-object-lock'] as const) {
      expect(factoryForSealMode(mode)).not.toBeNull();
    }
    expect(factoryForSealMode('none')).toBeNull();
  });
});

// ─── readdirSync sanity (no S3-side files leak into local dir) ────────────

describe('createS3ObjectLockSealer — local fs hygiene', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-s3lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('only seal.log lands in the local dir (no .seal files locally)', () => {
    const sealer = createS3ObjectLockSealer({
      path: dir,
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    sealer.append({ seq: 2, ts: 200, hash: OTHER_HASH });
    expect(readdirSync(dir).sort()).toEqual(['seal.log']);
  });
});

// ─── path normalization (review fix, mirrors rfc3161) ─────────────────────

describe('createS3ObjectLockSealer — path normalization preserves filesystem root', () => {
  // Bug pre-review-fix: `opts.path.replace(/\/+$/, '')` collapsed
  // "/" to "" — subsequent join(dir, 'seal.log') yielded the
  // CWD-relative "seal.log" instead of "/seal.log". An operator
  // configuring seal.path = "/" passed validation, then the local
  // seal index file landed in whatever directory the agent
  // happened to be running from. Mirror of the rfc3161 fix; the
  // S3 backend keeps a LOCAL append-only seal.log alongside the
  // remote bucket objects (see CONTRACTS sealing chapter), so the
  // same path bug applies. Injected seams so we don't touch real /.

  const captureSeams = () => {
    const calls = {
      ensureDirArg: null as string | null,
      appendArg: null as string | null,
    };
    return {
      calls,
      seams: {
        ensureDir: (d: string) => {
          calls.ensureDirArg = d;
        },
        append: (p: string, _c: string) => {
          calls.appendArg = p;
        },
        exists: () => false,
        read: () => '',
      },
    };
  };

  test('opts.path = "/" stays rooted (not collapsed to CWD)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createS3ObjectLockSealer({
      path: '/',
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
      ...seams,
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(r.ok).toBe(true);
    expect(calls.ensureDirArg).toBe('/');
    expect(calls.appendArg).toBe('/seal.log');
  });

  test('opts.path = "//" collapses to "/" (not "")', () => {
    const { calls, seams } = captureSeams();
    const sealer = createS3ObjectLockSealer({
      path: '//',
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(calls.ensureDirArg).toBe('/');
    expect(calls.appendArg).toBe('/seal.log');
  });

  test('opts.path = "/var/lib/agent/" strips trailing slash (regression)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createS3ObjectLockSealer({
      path: '/var/lib/agent/',
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(calls.ensureDirArg).toBe('/var/lib/agent');
    expect(calls.appendArg).toBe('/var/lib/agent/seal.log');
  });

  test('opts.path with no trailing slash is unchanged (regression)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createS3ObjectLockSealer({
      path: '/var/lib/agent',
      bucket: 'b',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: SHA256_HASH });
    expect(calls.ensureDirArg).toBe('/var/lib/agent');
    expect(calls.appendArg).toBe('/var/lib/agent/seal.log');
  });
});
