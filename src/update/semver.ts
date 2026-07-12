// Minimal semver parse + compare for the update subsystem. NOT a full semver
// library — the release channel only emits tags shaped MAJOR.MINOR.PATCH with
// an optional `-prerelease` segment (build metadata after `+` is ignored, per
// SemVer §10). Dependency-free and pure so it's trivially testable, and no
// regex (project rule: glob/prefix, not regex) — plain scanning throughout.

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  // Dot-separated prerelease identifiers (`rc.1` → ['rc','1']), or [] for a
  // stable release. A stable release outranks any prerelease of the same
  // MAJOR.MINOR.PATCH (SemVer §11.3).
  prerelease: string[];
}

const isNonNegInt = (s: string): boolean =>
  // Bounded length guards against Number() overflow on a hostile tag (§0.4).
  s.length > 0 && s.length <= 9 && [...s].every((c) => c >= '0' && c <= '9');

const isAlnumHyphen = (c: string): boolean =>
  (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '-';

// SemVer §9: a prerelease identifier is a non-empty run of ASCII alphanumerics
// and hyphens ([0-9A-Za-z-]), and an all-numeric one must not have a leading
// zero. Enforced BEFORE the tag is cached or rendered — the release response is
// untrusted (§0.4), so control chars / ANSI escapes / whitespace / non-ASCII
// must never reach `formatSemver` and the boot notice (terminal injection).
const isValidPreId = (id: string): boolean => {
  if (id.length === 0) return false;
  for (const c of id) if (!isAlnumHyphen(c)) return false;
  const allDigits = [...id].every((c) => c >= '0' && c <= '9');
  return !(allDigits && id.length > 1 && id[0] === '0');
};

// Parses `1.2.3` / `1.2.3-rc.1` / `v1.2.3` (leading `v` tolerated). Returns
// null on anything malformed — callers treat null as "no signal", never throw.
export const parseSemver = (raw: string): Semver | null => {
  let s = raw.trim();
  if (s.startsWith('v')) s = s.slice(1);
  const plus = s.indexOf('+');
  const core = plus === -1 ? s : s.slice(0, plus); // drop build metadata
  const dash = core.indexOf('-');
  const mainPart = dash === -1 ? core : core.slice(0, dash);
  // null = no prerelease section at all; '' = a trailing dash with an empty
  // section (malformed). Splitting '' yields [''], caught by the empty-id check.
  const prePart = dash === -1 ? null : core.slice(dash + 1);
  const nums = mainPart.split('.');
  if (nums.length !== 3 || !nums.every(isNonNegInt)) return null;
  const prerelease = prePart === null ? [] : prePart.split('.');
  if (!prerelease.every(isValidPreId)) return null;
  const [maj, min, pat] = nums as [string, string, string];
  return { major: Number(maj), minor: Number(min), patch: Number(pat), prerelease };
};

// Canonical string form (no leading `v`) — what the cache stores and what
// `forja --version` reports.
export const formatSemver = (s: Semver): string => {
  const core = `${s.major}.${s.minor}.${s.patch}`;
  return s.prerelease.length === 0 ? core : `${core}-${s.prerelease.join('.')}`;
};

const comparePreId = (a: string, b: string): -1 | 0 | 1 => {
  const an = isNonNegInt(a);
  const bn = isNonNegInt(b);
  if (an && bn) {
    const x = Number(a);
    const y = Number(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (an) return -1; // numeric identifiers rank below alphanumeric (SemVer §11.4)
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
};

// -1 if a < b, 0 if equal, 1 if a > b. Precedence: numeric main triplet, then
// prerelease per SemVer §11 — a version WITH prerelease is LOWER than the same
// without, and identifiers compare left-to-right.
export const compareSemver = (a: Semver, b: Semver): -1 | 0 | 1 => {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a stable, b prerelease → a > b
  if (bp.length === 0) return -1;
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const c = comparePreId(ap[i] as string, bp[i] as string);
    if (c !== 0) return c;
  }
  if (ap.length === bp.length) return 0;
  return ap.length < bp.length ? -1 : 1; // more identifiers → higher precedence
};

// True iff `latest` is strictly newer than `current`. Malformed input on
// either side → false: no signal, never a false positive that nags the user.
export const isNewer = (latest: string, current: string): boolean => {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (l === null || c === null) return false;
  return compareSemver(l, c) === 1;
};
