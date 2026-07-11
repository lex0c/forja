// Parse a relative-delay string ("30s", "10m", "2h") into milliseconds.
// Returns null on any malformed input — the `reminder` tool turns that
// into a clean invalid_arg, never a throw. Suffix-only (s/m/h); no
// compound form ("1h30m"), which the model expresses as one unit ("90m").
//
// No regex (project convention leans on explicit scanning over patterns):
// the numeric part is validated digit-by-digit.

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const isAllAsciiDigits = (s: string): boolean => {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false; // not 0-9
  }
  return true;
};

export const parseDuration = (input: string): number | null => {
  const trimmed = input.trim();
  // Need at least one digit + one unit char.
  if (trimmed.length < 2) return null;
  const unit = trimmed[trimmed.length - 1]?.toLowerCase() ?? '';
  const mult = UNIT_MS[unit];
  if (mult === undefined) return null;
  const numPart = trimmed.slice(0, -1);
  if (!isAllAsciiDigits(numPart)) return null;
  const n = Number(numPart);
  // isAllAsciiDigits already excludes NaN/sign/decimal; guard 0 and the
  // (astronomically unlikely) overflow into a non-finite product.
  if (n <= 0) return null;
  const ms = n * mult;
  return Number.isFinite(ms) ? ms : null;
};
