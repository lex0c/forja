// Heuristic injection / secret scanner shared across memory write
// surfaces (spec MEMORY.md §7.3). Two consumers today:
//
//   - `memory_write` tool (`src/tools/builtin/memory-write.ts`):
//     scans body + description before showing the modal so the
//     operator never gets a confirm prompt for content that
//     would have been blocked anyway.
//
//   - `/memory promote shared` slash command (spec §5.4): scans
//     the source body again before moving local → shared, with
//     a TIGHTER size cap (`SHARED_BODY_LINE_CAP`, 200 lines) the
//     spec mandates because shared memories enter the team's
//     committed context and benefit from less surface area.
//
// Spec §7.3 names "injection phrases" + "secret patterns" as the
// two filter classes. The bar is "raise the cost of the obvious
// vector", not "stop a human red team" — keep the list short so
// false positives stay rare.
//
// Promote-specific extras (spec §5.4 "scanner adicional"):
//   - Path traversal heuristic: bodies that *look like* they
//     reference filesystem traversal (`../`, `/etc/`, etc.).
//     Memory-write doesn't run this because regular memories
//     legitimately discuss paths; promotion surfaces it because
//     a shared memory shouldn't carry unvalidated path
//     references that would mislead future readers.
//   - Body line cap: hard-cap of 200 lines for shared bodies so
//     the eager-load section stays scannable.

export interface ScanResult {
  ok: boolean;
  // The first matched phrase / pattern class, used in the audit
  // row's `details.reason`. We surface a CLASS (not the literal
  // text) for secrets so the operator-side audit doesn't
  // duplicate the credential into another column. Phrases echo
  // verbatim because they're benign.
  reason?: string;
}

// Spec §7.3:
//   - "ignore previous instructions"
//   - "you are now"
//   - "from now on, always"
//   - secret patterns (AWS keys, GitHub tokens, etc.)
const INJECTION_PHRASES: readonly string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'you are now',
  'from now on, always',
  'disregard prior',
  'forget previous',
];

// Secret-pattern regexes. Anchored on common high-entropy prefixes
// so a memory body that mentions "AKIA" in prose without the full
// key doesn't trigger. Patterns:
//   - AWS access key id: `AKIA` + 16 [A-Z0-9]
//   - GitHub PAT (classic): `ghp_` + 36 chars
//   - GitHub fine-grained: `github_pat_` + ...
//   - Anthropic key: `sk-ant-` + ...
//   - OpenAI key: `sk-` + 40+ alnum (kept loose; these key formats churn)
//   - Slack token: `xox[baprs]-...`
const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{40,}\b/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

// Run the standard injection + secret scanner against a single
// text field (body or description). Used by memory_write before
// the modal opens AND by /memory promote shared as part of the
// `scanForPromotion` superset.
export const scanForInjection = (text: string): ScanResult => {
  const lower = text.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `injection phrase: ${JSON.stringify(phrase)}` };
    }
  }
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) {
      return { ok: false, reason: 'secret pattern matched' };
    }
  }
  return { ok: true };
};

// Hard cap on body line count for promotion. Spec §5.4 "Content
// fica < 200 lines (limite hard)". Counted as `\n`-separated
// lines including a trailing empty line if the body ends with
// `\n` (standard line-count). We compare strict-less-than so a
// body of exactly 200 lines passes; 201 fails.
export const SHARED_BODY_LINE_CAP = 200;

// Path-traversal heuristic for promotion. Spec §5.4 calls for a
// path-traversal check on shared bodies — a shared memory that
// claims `../../etc/passwd` is more likely a hand-edited mistake
// or an injection attempt than legitimate content. Conservative
// regex: `..` followed by `/` or `\`, or absolute filesystem
// roots in unusual positions. Memory-write doesn't run this
// because regular memories may legitimately discuss paths
// (e.g., `the tool reads ../config/foo.yaml`).
const PATH_TRAVERSAL_PATTERNS: readonly RegExp[] = [
  /\.\.[\\/]/, // ../ or ..\
  /\b\/etc\/(passwd|shadow|hosts)\b/i,
  /\b[A-Z]:\\Windows\\System32\b/i,
];

// Promotion-specific superset of `scanForInjection` plus path-
// traversal + size cap. Returns the FIRST failing rule's reason
// so the audit row carries actionable detail without dumping
// the full failure set.
export const scanForPromotion = (body: string): ScanResult => {
  const baseScan = scanForInjection(body);
  if (!baseScan.ok) return baseScan;
  for (const pat of PATH_TRAVERSAL_PATTERNS) {
    if (pat.test(body)) {
      return { ok: false, reason: 'path traversal pattern' };
    }
  }
  const lineCount = body.split('\n').length;
  if (lineCount >= SHARED_BODY_LINE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${SHARED_BODY_LINE_CAP}-line cap (got ${lineCount})`,
    };
  }
  return { ok: true };
};
