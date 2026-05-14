// ULID generator per https://github.com/ulid/spec. 26 characters total:
//   - 10 chars: 48-bit unix-ms timestamp, Crockford base32, MSB first.
//   - 16 chars: 80-bit cryptographic randomness, Crockford base32.
//
// Stable, URL-safe, time-sortable public identifier independent of
// any DB autoincrement `seq` integer. Crockford base32 omits the
// visually-ambiguous `I`, `L`, `O`, `U` glyphs so a ULID printed
// in a terminal can be re-typed reliably.
//
// Time-sortability is a spec property: lexicographic order on the
// string equals chronological order on `granted_at`. The grants
// repo relies on this for the `ORDER BY granted_at DESC` query —
// without time-sortable IDs the query would need a secondary sort
// on `id` to break ties at the same ms.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encodeBigInt = (n: bigint, len: number): string => {
  let out = '';
  let v = n;
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
};

export interface GenerateUlidOptions {
  // Test seam: inject a deterministic timestamp + RNG so unit tests
  // can assert exact byte-for-byte output. Production callers leave
  // both undefined and the generator reads `Date.now()` +
  // `crypto.getRandomValues`.
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

export const generateUlid = (options: GenerateUlidOptions = {}): string => {
  const now = options.now ?? (() => Date.now());
  const randomBytes =
    options.randomBytes ??
    ((n: number) => {
      const out = new Uint8Array(n);
      crypto.getRandomValues(out);
      return out;
    });
  const ms = now();
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`ulid: invalid timestamp ${ms}`);
  }
  // The spec caps the timestamp at 2^48 - 1 (year 10889). JS Date.now()
  // can't exceed that for any reasonable run — but reject explicitly
  // so a future caller passing a poisoned `now()` doesn't silently
  // produce a colliding ULID.
  const maxMs = 281474976710655; // 2^48 - 1
  if (ms > maxMs) {
    throw new Error(`ulid: timestamp ${ms} exceeds 48-bit cap`);
  }
  const tsPart = encodeBigInt(BigInt(ms), 10);
  const bytes = randomBytes(10);
  let randVal = 0n;
  for (const b of bytes) randVal = (randVal << 8n) | BigInt(b);
  const randPart = encodeBigInt(randVal, 16);
  return tsPart + randPart;
};

// Strict validator. ULIDs out of band — values typed by operators
// or pasted from logs — pass through this before any DB lookup.
// Length check + alphabet check; rejects everything else (including
// lowercase, which ULID's canonical form forbids).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (s: string): boolean => ULID_RE.test(s);
