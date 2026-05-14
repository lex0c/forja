// Slice 88 — RFC 3161 TSA sealing backend. Tests cover:
//   - the TSQ DER encoder (known-good vector for SHA-256 hash);
//   - the SealStore flow (submit + store TSR + append seal.log);
//   - error mapping (submit fail, write fail, encode fail);
//   - listing (uses the seal.log line format, same as other backends);
//   - factory wiring from SealPolicy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Rfc3161Submitter,
  createRfc3161TsaSealer,
  defaultRfc3161TsaFactory,
  encodeTimestampQuery,
} from '../../src/permissions/sealing-rfc3161.ts';

const SHA256_OID_HEX = '060960864801650304020105 00'.replace(/\s/g, '');

const ZERO_HASH = '00'.repeat(32);
const ONES_HASH = 'ff'.repeat(32);

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

// ─── encoder ──────────────────────────────────────────────────────────────

describe('encodeTimestampQuery — DER shape', () => {
  test('SHA-256 zero hash produces the expected 56-byte TSQ', () => {
    const tsq = encodeTimestampQuery(ZERO_HASH);
    expect(tsq.length).toBe(56);
    const hex = bytesToHex(tsq);
    // SEQUENCE (54 inner)
    expect(hex.startsWith('3036')).toBe(true);
    // INTEGER version 1
    expect(hex.slice(4, 10)).toBe('020101');
    // MessageImprint SEQUENCE (49 inner)
    expect(hex.slice(10, 14)).toBe('3031');
    // AlgorithmIdentifier SEQUENCE (13 inner) — SHA-256 OID + NULL
    expect(hex.slice(14, 18)).toBe('300d');
    expect(hex.slice(18, 18 + SHA256_OID_HEX.length)).toBe(SHA256_OID_HEX);
    // OCTET STRING tag + length 32
    const octetStart = 18 + SHA256_OID_HEX.length;
    expect(hex.slice(octetStart, octetStart + 4)).toBe('0420');
    // Hash payload — 32 zero bytes
    expect(hex.slice(octetStart + 4)).toBe(ZERO_HASH);
  });

  test('different hash produces different TSQ payload at the hash slot', () => {
    const a = encodeTimestampQuery(ZERO_HASH);
    const b = encodeTimestampQuery(ONES_HASH);
    expect(a.length).toBe(b.length);
    expect(bytesToHex(a.slice(0, 24))).toBe(bytesToHex(b.slice(0, 24)));
    // hash bytes at offset 24 (last 32 bytes)
    expect(bytesToHex(a.slice(24))).toBe(ZERO_HASH);
    expect(bytesToHex(b.slice(24))).toBe(ONES_HASH);
  });

  test('uppercase hex is accepted + case-folded into the same bytes', () => {
    const lower = encodeTimestampQuery('a'.repeat(64));
    const upper = encodeTimestampQuery('A'.repeat(64));
    expect(bytesToHex(lower)).toBe(bytesToHex(upper));
  });

  test('non-hex input is rejected', () => {
    expect(() => encodeTimestampQuery('zz'.repeat(32))).toThrow('64 hex chars');
  });

  test('wrong-length input is rejected', () => {
    expect(() => encodeTimestampQuery('00'.repeat(16))).toThrow('64 hex chars');
    expect(() => encodeTimestampQuery('00'.repeat(64))).toThrow('64 hex chars');
  });
});

// ─── SealStore flow with scripted submitter ───────────────────────────────

describe('createRfc3161TsaSealer — append flow', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-tsa-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('successful submit: TSR stored + seal.log appended', () => {
    const fakeTsr = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const submit: Rfc3161Submitter = () => ({ ok: true, tsr: fakeTsr });
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit,
    });
    const entry = { seq: 1, ts: 1_700_000_000, hash: ZERO_HASH };
    const r = sealer.append(entry);
    expect(r.ok).toBe(true);
    // TSR file written under dir/<seq>-<ts>.tsr
    const tsrPath = join(dir, `1-${entry.ts}.tsr`);
    expect(existsSync(tsrPath)).toBe(true);
    expect(readFileSync(tsrPath)).toEqual(Buffer.from(fakeTsr));
    // seal.log line matches the wire format
    const logPath = join(dir, 'seal.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toBe(`seq=1\tts=${entry.ts}\thash=${ZERO_HASH}\n`);
  });

  test('multiple successful appends: each writes its own TSR file', () => {
    let n = 0;
    const submit: Rfc3161Submitter = () => {
      n++;
      return { ok: true, tsr: new Uint8Array([n]) };
    };
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit,
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    sealer.append({ seq: 2, ts: 200, hash: ONES_HASH });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['1-100.tsr', '2-200.tsr', 'seal.log']);
  });

  test('submitter returning ok:false maps to ok:false with TSA-submit-failed prefix', () => {
    const submit: Rfc3161Submitter = () => ({ ok: false, reason: 'endpoint unreachable' });
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit,
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('TSA submit failed: endpoint unreachable');
    // No TSR file landed; seal.log was never created.
    expect(existsSync(join(dir, 'seal.log'))).toBe(false);
    expect(readdirSync(dir).length).toBe(0);
  });

  test('non-sha256 hash (wrong length) is rejected BEFORE submit', () => {
    let submitCalled = false;
    const submit: Rfc3161Submitter = () => {
      submitCalled = true;
      return { ok: true, tsr: new Uint8Array() };
    };
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit,
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: 'short' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('rfc3161-tsa requires sha256 hash');
    expect(submitCalled).toBe(false);
  });

  test('invalid entry shape (negative seq) is rejected', () => {
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array() }),
    });
    const r = sealer.append({ seq: -1, ts: 100, hash: ZERO_HASH });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('invalid seal entry');
  });

  test('whitespace in hash is rejected', () => {
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array() }),
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: 'aa bb cc' });
    expect(r.ok).toBe(false);
  });

  test('submitter throwing is NOT caught by the sealer (test-seam contract)', () => {
    // The submitter is expected to return Rfc3161SubmitResult; a
    // thrown error means a programming bug. Surfacing the throw
    // helps tests catch malformed submitters.
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => {
        throw new Error('submitter bug');
      },
    });
    expect(() => sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH })).toThrow('submitter bug');
  });

  test('submitter receives the TSQ + endpoint verbatim', () => {
    const captured: { tsq: Uint8Array | null; endpoint: string | null } = {
      tsq: null,
      endpoint: null,
    };
    const submit: Rfc3161Submitter = (tsq, endpoint) => {
      captured.tsq = tsq;
      captured.endpoint = endpoint;
      return { ok: true, tsr: new Uint8Array() };
    };
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com/path?q=1',
      submit,
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(captured.endpoint).toBe('https://tsa.example.com/path?q=1');
    expect(captured.tsq).toEqual(encodeTimestampQuery(ZERO_HASH));
  });
});

// ─── path normalization (review fix) ──────────────────────────────────────

describe('createRfc3161TsaSealer — path normalization preserves filesystem root', () => {
  // Bug pre-review-fix: `opts.path.replace(/\/+$/, '')` collapsed
  // "/" to "" — subsequent join(dir, 'seal.log') yielded the
  // CWD-relative "seal.log" instead of "/seal.log". A deployment
  // configuring seal.path = "/" passed shape validation, then
  // wrote seal artifacts under whatever directory the agent
  // happened to be running from. Tests use injected seams so we
  // don't touch the actual filesystem root.

  const captureSeams = () => {
    const calls = {
      ensureDirArg: null as string | null,
      writeBinaryArg: null as string | null,
      appendArg: null as string | null,
    };
    return {
      calls,
      seams: {
        ensureDir: (d: string) => {
          calls.ensureDirArg = d;
        },
        writeBinary: (p: string, _c: Uint8Array) => {
          calls.writeBinaryArg = p;
        },
        append: (p: string, _c: string) => {
          calls.appendArg = p;
        },
        // Stub the read/exists paths so list() / dedup logic never
        // touch real FS (not exercised by append, but defensive).
        exists: () => false,
        read: () => '',
      },
    };
  };

  test('opts.path = "/" stays rooted (not collapsed to CWD)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createRfc3161TsaSealer({
      path: '/',
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([0x01]) }),
      ...seams,
    });
    const r = sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(r.ok).toBe(true);
    expect(calls.ensureDirArg).toBe('/');
    expect(calls.writeBinaryArg).toBe('/1-100.tsr');
    expect(calls.appendArg).toBe('/seal.log');
  });

  test('opts.path = "//" collapses to "/" (not "")', () => {
    const { calls, seams } = captureSeams();
    const sealer = createRfc3161TsaSealer({
      path: '//',
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([0x01]) }),
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(calls.ensureDirArg).toBe('/');
    expect(calls.writeBinaryArg).toBe('/1-100.tsr');
  });

  test('opts.path = "/var/lib/agent/" strips trailing slash (regression)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createRfc3161TsaSealer({
      path: '/var/lib/agent/',
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([0x01]) }),
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(calls.ensureDirArg).toBe('/var/lib/agent');
    expect(calls.writeBinaryArg).toBe('/var/lib/agent/1-100.tsr');
  });

  test('opts.path with no trailing slash is unchanged (regression)', () => {
    const { calls, seams } = captureSeams();
    const sealer = createRfc3161TsaSealer({
      path: '/var/lib/agent',
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([0x01]) }),
      ...seams,
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    expect(calls.ensureDirArg).toBe('/var/lib/agent');
    expect(calls.writeBinaryArg).toBe('/var/lib/agent/1-100.tsr');
  });
});

// ─── list() across multiple appends ───────────────────────────────────────

describe('createRfc3161TsaSealer — list()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-tsa-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('empty dir → empty list', () => {
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array() }),
    });
    expect(sealer.list()).toEqual([]);
  });

  test('appended entries are listed in append order', () => {
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([1]) }),
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    sealer.append({ seq: 2, ts: 200, hash: ONES_HASH });
    expect(sealer.list()).toEqual([
      { seq: 1, ts: 100, hash: ZERO_HASH },
      { seq: 2, ts: 200, hash: ONES_HASH },
    ]);
  });

  test('malformed line in seal.log throws on list() (no silent skip)', () => {
    const sealer = createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      submit: () => ({ ok: true, tsr: new Uint8Array([1]) }),
    });
    sealer.append({ seq: 1, ts: 100, hash: ZERO_HASH });
    // Corrupt the log file directly.
    const logPath = join(dir, 'seal.log');
    Bun.write(logPath, 'this is not a valid line\n');
    expect(() => sealer.list()).toThrow('malformed seal entry');
  });
});

// ─── factory + dispatcher ─────────────────────────────────────────────────

describe('defaultRfc3161TsaFactory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-tsa-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('throws when path is missing', () => {
    expect(() =>
      defaultRfc3161TsaFactory({
        mode: 'rfc3161-tsa',
        endpoint: 'https://tsa.example.com',
      }),
    ).toThrow('path is required');
  });

  test('throws when endpoint is missing', () => {
    expect(() =>
      defaultRfc3161TsaFactory({
        mode: 'rfc3161-tsa',
        path: dir,
      }),
    ).toThrow('endpoint is required');
  });

  test('returns a SealStore with both fields present (production submitter wired)', () => {
    const store = defaultRfc3161TsaFactory({
      mode: 'rfc3161-tsa',
      path: dir,
      endpoint: 'https://tsa.example.com',
    });
    expect(typeof store.append).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.close).toBe('function');
    store.close();
  });
});

// ─── factoryForSealMode wiring ────────────────────────────────────────────

describe('factoryForSealMode — rfc3161-tsa dispatch', () => {
  test('returns the rfc3161 factory for mode "rfc3161-tsa"', async () => {
    const { factoryForSealMode } = await import('../../src/permissions/sealing.ts');
    const factory = factoryForSealMode('rfc3161-tsa');
    expect(factory).toBe(defaultRfc3161TsaFactory);
  });
});
