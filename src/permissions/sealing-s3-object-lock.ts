// S3 Object Lock sealing backend.
//
// External anchoring via AWS S3 Object Lock in COMPLIANCE mode.
// For each seal event the backend:
//
//   1. canonicalizes the entry into a seal record byte string
//      (same `seq=N\tts=N\thash=H\n` line format used by the
//      other sealing backends);
//   2. uploads the bytes as an S3 object under
//      `<bucket>/<key_prefix>/<seq>-<ts>.seal` with Object Lock
//      retention set to `now + retention_days` in COMPLIANCE
//      mode;
//   3. appends the same line to a local `seal.log` so list() +
//      verify can walk the chain without S3 round-trips.
//
// Object Lock in COMPLIANCE mode is the audit-grade choice
// available on S3 itself: the object becomes undeletable +
// unmodifiable for ANY principal (including the AWS root user)
// until the retention timestamp expires. An adversary who
// rewrites the local audit log + recomputes hashes still gets
// caught because the S3-anchored bytes still carry the original
// seal record, signed (via TLS, ACLed) by the AWS object
// integrity model. Operators worried about AWS compromise pair
// this with rfc3161-tsa for two independent trust roots.
//
// Threat model:
//   - In-scope: retroactive edits to old seal records — Object
//     Lock COMPLIANCE rejects PutObject overwrites + DeleteObject
//     until expiry.
//   - Out-of-scope: AWS account takeover before the object lands
//     (an attacker with full IAM access who pre-empts the seal
//     write). Operators mitigate via least-privilege IAM and
//     audit-log credential rotation.
//   - Out-of-scope: bucket-level configuration drift (Object
//     Lock disabled on the bucket itself). The bucket MUST be
//     created with Object Lock enabled — this engine doesn't
//     bootstrap it; a future doctor check can verify the
//     bucket's GetObjectLockConfiguration on startup.
//   - Out-of-scope: clock skew between operator and AWS. The
//     RetainUntilDate is computed locally + sent verbatim;
//     AWS accepts whatever timestamp you provide as long as
//     it's in the future relative to AWS's clock. Operators
//     with bad clocks see PutObject failures; the diagnostic
//     surfaces via the standard SealStore error path.
//
// Sync interface: SealStore.append() is synchronous (matches the
// scheduler's sealNow() contract). The S3 PUT is invoked via
// `execFileSync('aws', ...)` — same posture as rfc3161-tsa's
// curl-based submitter. Operators bind to whatever `aws` CLI
// version is on their PATH; `aws --version 2.x+` is assumed.
//
// Test seam `submit`: tests inject a deterministic submitter so
// the suite runs without AWS credentials or network. Production
// binds the aws-CLI-based `defaultS3Submitter`.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SealEntry, SealStore } from './sealing.ts';
import type { SealPolicy } from './types.ts';

// ─── transport: aws-CLI-based submitter ───────────────────────────────────

export interface S3SubmitParams {
  bucket: string;
  key: string;
  body: Uint8Array;
  retainUntilIso: string;
  region: string | undefined;
  endpoint: string | undefined;
}

export type S3SubmitResult = { ok: true } | { ok: false; reason: string };

export type S3Submitter = (params: S3SubmitParams) => S3SubmitResult;

export const defaultS3Submitter: S3Submitter = (params) => {
  // Write body to a temp file because `aws s3api put-object`'s
  // `--body` flag wants a file path. Stdin (`--body -`) is not
  // universally supported across aws CLI versions; the temp-file
  // path is portable. We clean up unconditionally via try/finally.
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'forja-s3-seal-'));
    const bodyPath = join(tmpDir, 'body.bin');
    writeFileSync(bodyPath, params.body);
    const argv: string[] = [
      's3api',
      'put-object',
      '--bucket',
      params.bucket,
      '--key',
      params.key,
      '--body',
      bodyPath,
      '--object-lock-mode',
      'COMPLIANCE',
      '--object-lock-retain-until-date',
      params.retainUntilIso,
    ];
    if (params.region !== undefined) {
      argv.push('--region', params.region);
    }
    if (params.endpoint !== undefined) {
      argv.push('--endpoint-url', params.endpoint);
    }
    try {
      execFileSync('aws', argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `aws s3api put-object failed: ${msg}` };
    }
    return { ok: true };
  } finally {
    if (tmpDir !== null) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; leftover temp dir is operator's problem
      }
    }
  }
};

// ─── SealStore implementation ─────────────────────────────────────────────

const ENTRY_LINE = (e: SealEntry): string => `seq=${e.seq}\tts=${e.ts}\thash=${e.hash}\n`;

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

// Build the S3 object key: optional prefix + `<seq>-<ts>.seal`.
// Always inserts the separator slash between prefix and filename;
// the prefix MUST NOT start/end with `/` (parsePolicy enforces).
const buildObjectKey = (prefix: string | undefined, entry: SealEntry): string => {
  const name = `${entry.seq}-${entry.ts}.seal`;
  if (prefix === undefined || prefix === '') return name;
  return `${prefix}/${name}`;
};

// Compute the ISO 8601 retention timestamp from now + retention_days.
// COMPLIANCE-mode Object Lock accepts any future timestamp; AWS
// rounds to seconds. We emit Z-suffixed UTC for unambiguous parse.
const computeRetainUntil = (nowMs: number, retentionDays: number): string => {
  const expiryMs = nowMs + retentionDays * 24 * 60 * 60 * 1000;
  return new Date(expiryMs).toISOString();
};

export interface CreateS3ObjectLockSealerOptions {
  // Local directory holding the seal.log index. Created if missing
  // (mkdir -p). REQUIRED.
  path: string;
  // S3 bucket name. Bucket MUST have Object Lock enabled at
  // creation; we don't enable it. REQUIRED.
  bucket: string;
  // Object Lock retention window in days. REQUIRED — no default
  // because COMPLIANCE-mode locks are irreversible until expiry,
  // so operators MUST choose deliberately. Validation lives in
  // parsePolicy (≥ 1 integer).
  retentionDays: number;
  // S3 key prefix (without leading/trailing `/`). Default empty.
  keyPrefix?: string;
  // AWS region. Optional — absent → aws CLI uses operator profile.
  region?: string;
  // Custom S3 endpoint URL (MinIO etc.). Optional.
  endpoint?: string;
  // Test seam. Production binds `defaultS3Submitter`.
  submit?: S3Submitter;
  // Test seam for the retain-until timestamp. Defaults to Date.now().
  now?: () => number;
  // Test seams for fs.
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  append?: (path: string, content: string) => void;
  ensureDir?: (dir: string) => void;
}

const defaultExists = (p: string): boolean => existsSync(p);
const defaultRead = (p: string): string => readFileSync(p, 'utf-8');
const defaultAppend = (p: string, c: string): void => appendFileSync(p, c, 'utf-8');
const defaultEnsureDir = (d: string): void => {
  mkdirSync(d, { recursive: true });
};

export const createS3ObjectLockSealer = (opts: CreateS3ObjectLockSealerOptions): SealStore => {
  // Strip trailing slashes so join(dir, 'seal.log') doesn't
  // produce double-slash paths. The /^\/+$/ guard preserves "/"
  // (and other all-slashes values like "//") as the filesystem
  // root — without it, the naive replace collapses "/" to "" and
  // every subsequent join() becomes a CWD-relative path, silently
  // writing the local seal index file to the wrong place when an
  // operator deliberately configures seal.path = "/".
  const dir = /^\/+$/.test(opts.path) ? '/' : opts.path.replace(/\/+$/, '');
  const sealLogPath = join(dir, 'seal.log');
  const submit = opts.submit ?? defaultS3Submitter;
  const now = opts.now ?? (() => Date.now());
  const exists = opts.exists ?? defaultExists;
  const read = opts.read ?? defaultRead;
  const append = opts.append ?? defaultAppend;
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
      try {
        ensureDir(dir);
      } catch (e) {
        return {
          ok: false,
          reason: `ensure seal dir failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const line = ENTRY_LINE(entry);
      const body = new TextEncoder().encode(line);
      const key = buildObjectKey(opts.keyPrefix, entry);
      const retainUntilIso = computeRetainUntil(now(), opts.retentionDays);
      const result = submit({
        bucket: opts.bucket,
        key,
        body,
        retainUntilIso,
        region: opts.region,
        endpoint: opts.endpoint,
      });
      if (!result.ok) {
        return { ok: false, reason: `S3 put failed: ${result.reason}` };
      }
      try {
        append(sealLogPath, line);
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
      // No-op. aws CLI invocations are one-shot subprocesses.
    },
  };
};

// Production factory. Maps SealPolicy's s3-object-lock fields to
// the constructor. Throws on missing required fields —
// parsePolicy enforces presence for valid input, so these
// branches are defense-in-depth.
export const defaultS3ObjectLockFactory = (config: SealPolicy): SealStore => {
  if (config.path === undefined) {
    throw new Error('defaultS3ObjectLockFactory: config.path is required for s3-object-lock mode');
  }
  if (config.bucket === undefined) {
    throw new Error(
      'defaultS3ObjectLockFactory: config.bucket is required for s3-object-lock mode',
    );
  }
  if (config.retention_days === undefined) {
    throw new Error(
      'defaultS3ObjectLockFactory: config.retention_days is required for s3-object-lock mode',
    );
  }
  return createS3ObjectLockSealer({
    path: config.path,
    bucket: config.bucket,
    retentionDays: config.retention_days,
    ...(config.key_prefix !== undefined ? { keyPrefix: config.key_prefix } : {}),
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
  });
};
