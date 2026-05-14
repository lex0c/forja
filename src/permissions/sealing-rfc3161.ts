// RFC 3161 Time-Stamp Authority sealing backend.
//
// External anchoring via the Time-Stamp Protocol (RFC 3161). For
// each seal event the backend:
//
//   1. encodes the chain hash as a TimeStampReq (TSQ) DER payload;
//   2. POSTs the TSQ to the configured TSA endpoint;
//   3. stores the returned TimeStampResp (TSR) as a binary file
//      under `path/<seq>-<ts>.tsr`;
//   4. appends a line to `path/seal.log` matching the worm-file /
//      git-anchored wire format so list() works without dispatch.
//
// The TSR is the auditable proof: a CMS SignedData blob whose
// embedded TSTInfo carries the TSA's timestamp + our hash. A
// verifier (future work) parses the SignedData, validates the
// signature against the TSA's certificate chain, and confirms the
// TSTInfo.messageImprint matches our recomputed chain hash. This
// module ships SUBMIT + STORE only; verification is a separate
// concern (RFC 3161 §2.4.2 + CMS parsing are substantial).
//
// Threat model:
//   - In-scope: retroactive editing of past seal entries — the
//     TSR's TSA signature binds (timestamp + hash) at submission
//     time. A later edit can't reproduce a TSR with the same
//     timestamp from the real TSA without compromising the TSA's
//     signing key.
//   - Out-of-scope: TSA collusion (a hostile TSA could backdate).
//     Mitigated by choosing a trusted TSA (DigiCert, FreeTSA, an
//     internal TSA with audited operations).
//   - Out-of-scope: TSA availability — if the endpoint is down,
//     `submit` returns ok:false and the scheduler's `on_failure`
//     policy (degrade vs refuse) decides what happens.
//   - Out-of-scope: replay of an older TSR — the TSA's TSTInfo
//     carries a fresh `nonce` when we set one + the TSA's
//     timestamp is monotonic per the TSA's clock. Our encoder
//     omits the nonce for simplicity; a verifier would check the
//     timestamp falls within the seal's expected window
//     (interval_seconds bound).
//
// Sync interface: SealStore.append() is synchronous (matches the
// scheduler's sealNow() contract). The TSA HTTP call is therefore
// invoked via `Bun.spawnSync('curl', ...)` — sync subprocess
// returns the TSR bytes inline. Production traffic is at most one
// call per `interval_decisions` / `interval_seconds`, so the
// blocking call is acceptable. Operators with flaky TSAs combine
// `on_failure='degrade'` with monitoring on the chain.verify path.
//
// Test seam `submit`: tests inject a deterministic submitter so
// the suite runs without network. Production binds the curl-based
// `defaultRfc3161Submitter` (uses Bun.spawnSync with --max-time
// for backpressure on slow TSAs).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SealEntry, SealStore } from './sealing.ts';
import type { SealPolicy } from './types.ts';

// ─── ASN.1 DER encoder (minimal subset for TimeStampReq) ──────────────────

const SHA256_OID = new Uint8Array([
  0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
]);
const NULL_ENCODED = new Uint8Array([0x05, 0x00]);

const encodeLength = (n: number): Uint8Array => {
  if (n < 128) return new Uint8Array([n]);
  // Long form: 0x80 | byteCount, then content bytes BE. RFC 3161
  // TSQ payloads for SHA-256 hashes stay well under 256 bytes, so
  // the multi-byte path is paranoia — we still handle it for the
  // general case (future hash algorithms with larger digests).
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
};

const concatBytes = (...arrs: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

const tagged = (tag: number, content: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([tag]), encodeLength(content.length), content);

const SEQUENCE = (...children: Uint8Array[]): Uint8Array => tagged(0x30, concatBytes(...children));

const INTEGER = (n: number): Uint8Array => {
  // RFC 3161 version is 1. We only need single-byte non-negative
  // ints. Caller-supplied values >127 would need leading-zero
  // padding to avoid being parsed as negative; that case is not
  // exercised today.
  if (n < 0 || n > 127 || !Number.isInteger(n)) {
    throw new Error(`INTEGER encoder supports 0..127 only, got ${n}`);
  }
  return tagged(0x02, new Uint8Array([n]));
};

const OCTET_STRING = (bytes: Uint8Array): Uint8Array => tagged(0x04, bytes);

const algorithmIdentifierSha256 = (): Uint8Array => SEQUENCE(SHA256_OID, NULL_ENCODED);

const messageImprint = (hashBytes: Uint8Array): Uint8Array =>
  SEQUENCE(algorithmIdentifierSha256(), OCTET_STRING(hashBytes));

// Encode a SHA-256 chain hash as a TimeStampReq DER payload.
// Format (RFC 3161 §2.4.1):
//
//   TimeStampReq ::= SEQUENCE {
//     version       INTEGER { v1(1) },
//     messageImprint MessageImprint,
//     reqPolicy     TSAPolicyId          OPTIONAL,   -- omitted
//     nonce         INTEGER              OPTIONAL,   -- omitted
//     certReq       BOOLEAN DEFAULT FALSE,           -- omitted (default)
//     extensions    [0] IMPLICIT Extensions OPTIONAL -- omitted
//   }
//
// The optional fields are omitted; the resulting payload is the
// minimum-valid TSQ. Operators who need certReq=TRUE (TSA cert
// returned inline) or nonce binding (replay defense) can extend
// the encoder later.
export const encodeTimestampQuery = (hashHex: string): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
    throw new Error(`encodeTimestampQuery: hash must be 64 hex chars (sha256), got '${hashHex}'`);
  }
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    hash[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  return SEQUENCE(INTEGER(1), messageImprint(hash));
};

// ─── transport: curl-based submitter ──────────────────────────────────────

export type Rfc3161SubmitResult = { ok: true; tsr: Uint8Array } | { ok: false; reason: string };

export type Rfc3161Submitter = (tsq: Uint8Array, endpoint: string) => Rfc3161SubmitResult;

export interface DefaultRfc3161SubmitterOptions {
  // curl --max-time bound in seconds. Default 10s — TSAs typically
  // respond in <500ms; 10s is generous for slow connections without
  // hanging the sync caller indefinitely.
  timeoutSeconds?: number;
}

export const defaultRfc3161Submitter = (
  opts: DefaultRfc3161SubmitterOptions = {},
): Rfc3161Submitter => {
  const timeoutSeconds = opts.timeoutSeconds ?? 10;
  return (tsq, endpoint) => {
    try {
      // execFileSync piping a Buffer to stdin returns stdout as a
      // Buffer when no `encoding` is set. Curl writes the TSR
      // bytes to stdout; stderr captures diagnostics.
      const stdout = execFileSync(
        'curl',
        [
          '-sS',
          '-X',
          'POST',
          '--max-time',
          String(timeoutSeconds),
          '-H',
          'Content-Type: application/timestamp-query',
          '-H',
          'Accept: application/timestamp-reply',
          '--data-binary',
          '@-',
          '--output',
          '-',
          endpoint,
        ],
        {
          input: Buffer.from(tsq),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      if (stdout.length === 0) {
        return { ok: false, reason: 'TSA returned empty response' };
      }
      return { ok: true, tsr: new Uint8Array(stdout) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `curl failed: ${msg}` };
    }
  };
};

// ─── SealStore implementation ─────────────────────────────────────────────

const ENTRY_LINE = (e: SealEntry): string => `seq=${e.seq}\tts=${e.ts}\thash=${e.hash}\n`;

// Strict parser — same shape as the worm-file/git-anchored parsers
// in sealing.ts. Duplicated here rather than imported to keep the
// backend file self-contained; the wire format is the contract,
// not the parser implementation.
const parseLine = (line: string): SealEntry | null => {
  const parts = line.split('\t');
  if (parts.length !== 3) return null;
  const seqPart = parts[0] ?? '';
  const tsPart = parts[1] ?? '';
  const hashPart = parts[2] ?? '';
  if (!seqPart.startsWith('seq=') || !tsPart.startsWith('ts=') || !hashPart.startsWith('hash=')) {
    return null;
  }
  const seq = Number.parseInt(seqPart.slice(4), 10);
  const ts = Number.parseInt(tsPart.slice(3), 10);
  const hash = hashPart.slice(5);
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!Number.isInteger(ts) || ts < 0) return null;
  if (hash.length === 0 || /\s/.test(hash)) return null;
  return { seq, ts, hash };
};

export interface CreateRfc3161TsaSealerOptions {
  // Directory holding TSR proof tokens + the seal.log line index.
  // Created if missing (mkdir -p). Required.
  path: string;
  // TSA HTTP endpoint URL. Required.
  endpoint: string;
  // Test seam — production binds `defaultRfc3161Submitter()`.
  submit?: Rfc3161Submitter;
  // Test seams for fs. Production callers leave undefined →
  // defaults from node:fs.
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  append?: (path: string, content: string) => void;
  writeBinary?: (path: string, content: Uint8Array) => void;
  ensureDir?: (dir: string) => void;
}

const defaultExists = (p: string): boolean => existsSync(p);
const defaultRead = (p: string): string => readFileSync(p, 'utf-8');
const defaultAppend = (p: string, c: string): void => appendFileSync(p, c, 'utf-8');
const defaultWriteBinary = (p: string, c: Uint8Array): void => writeFileSync(p, c);
const defaultEnsureDir = (d: string): void => {
  mkdirSync(d, { recursive: true });
};

export const createRfc3161TsaSealer = (opts: CreateRfc3161TsaSealerOptions): SealStore => {
  // Strip trailing slashes so join(dir, 'seal.log') doesn't
  // produce double-slash paths. The /^\/+$/ guard preserves "/"
  // (and other all-slashes values like "//") as the filesystem
  // root — without it, the naive replace collapses "/" to "" and
  // every subsequent join() becomes a CWD-relative path, silently
  // writing seal artifacts to the wrong place when an operator
  // deliberately configures seal.path = "/".
  const dir = /^\/+$/.test(opts.path) ? '/' : opts.path.replace(/\/+$/, '');
  const sealLogPath = join(dir, 'seal.log');
  const submit = opts.submit ?? defaultRfc3161Submitter();
  const exists = opts.exists ?? defaultExists;
  const read = opts.read ?? defaultRead;
  const append = opts.append ?? defaultAppend;
  const writeBinary = opts.writeBinary ?? defaultWriteBinary;
  const ensureDir = opts.ensureDir ?? defaultEnsureDir;

  return {
    append: (entry: SealEntry) => {
      if (
        !Number.isInteger(entry.seq) ||
        entry.seq < 1 ||
        !Number.isInteger(entry.ts) ||
        entry.ts < 0 ||
        typeof entry.hash !== 'string' ||
        entry.hash.length === 0 ||
        /\s/.test(entry.hash)
      ) {
        return { ok: false, reason: `invalid seal entry: ${JSON.stringify(entry)}` };
      }
      // Hash MUST be SHA-256 (64 hex chars) for this backend — the
      // TSQ encoder hardcodes the algorithm OID.
      if (!/^[0-9a-fA-F]{64}$/.test(entry.hash)) {
        return {
          ok: false,
          reason: `rfc3161-tsa requires sha256 hash (64 hex chars); got ${entry.hash.length} chars`,
        };
      }
      let tsq: Uint8Array;
      try {
        tsq = encodeTimestampQuery(entry.hash);
      } catch (e) {
        return {
          ok: false,
          reason: `TSQ encode failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      try {
        ensureDir(dir);
      } catch (e) {
        return {
          ok: false,
          reason: `ensure seal dir failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const submitResult = submit(tsq, opts.endpoint);
      if (!submitResult.ok) {
        return { ok: false, reason: `TSA submit failed: ${submitResult.reason}` };
      }
      const tsrPath = join(dir, `${entry.seq}-${entry.ts}.tsr`);
      try {
        writeBinary(tsrPath, submitResult.tsr);
      } catch (e) {
        return {
          ok: false,
          reason: `write TSR failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      try {
        append(sealLogPath, ENTRY_LINE(entry));
      } catch (e) {
        return {
          ok: false,
          reason: `append seal.log failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true };
    },
    list: () => {
      if (!exists(sealLogPath)) return [];
      const content = read(sealLogPath);
      if (content.length === 0) return [];
      const lines = content.split('\n');
      const out: SealEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.length === 0) continue;
        const parsed = parseLine(line);
        if (parsed === null) {
          throw new Error(`malformed seal entry at line ${i + 1}: ${JSON.stringify(line)}`);
        }
        out.push(parsed);
      }
      return out;
    },
    close: () => {
      // No-op. curl invocations are one-shot subprocesses; no
      // persistent socket / handle to release.
    },
  };
};

// Production factory. Maps SealPolicy's polymorphic `path` +
// `endpoint` to the constructor. Throws on missing required
// fields — parsePolicy enforces presence for valid input, so this
// branch is defense-in-depth.
export const defaultRfc3161TsaFactory = (config: SealPolicy): SealStore => {
  if (config.path === undefined) {
    throw new Error('defaultRfc3161TsaFactory: config.path is required for rfc3161-tsa mode');
  }
  if (config.endpoint === undefined) {
    throw new Error('defaultRfc3161TsaFactory: config.endpoint is required for rfc3161-tsa mode');
  }
  return createRfc3161TsaSealer({
    path: config.path,
    endpoint: config.endpoint,
  });
};
