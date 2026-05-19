// Memory write tripwire (spec MEMORY.md §7.3).
//
// HONEST FRAMING. This module is two things, kept together because
// they share the secret-pattern set:
//
//   1. A `INJECTION_PHRASES` tripwire — a small list of obvious
//      English jailbreak phrases ("ignore previous instructions",
//      etc.). It catches script-kiddie copy-paste from public
//      jailbreak tutorials. It does NOT catch:
//        - the same intent in any other language ("ignore as
//          instruções anteriores", "忽略之前的指令", …);
//        - paraphrase ("the new rule is …", "your role going
//          forward", "treat my prior message as void", …);
//        - structural injection (yaml/code-block/role-play wrappers,
//          markdown that mimics system instructions, …).
//      An attacker with five minutes of effort defeats it. The
//      list of legal phrases stays SHORT on purpose — extending it
//      with more English phrases doesn't move the threat needle and
//      inflates false-positive rate against legitimate memory
//      bodies that quote model failure modes.
//
//      This tripwire's value is two-fold:
//        (a) **Audit signal.** A match produces a `memory_events
//            action=refused` row with `details.reason='injection
//            phrase: …'`, so the operator sees that something
//            obviously hostile tried to write. The model can't
//            silently retry.
//        (b) **Defense-in-depth.** Combined with the modal
//            confirmation (operator approves every inferred
//            write), the trust boundary (`untrusted` memories
//            don't eager-load), `source` attribution (operator-
//            typed vs model-decided), and scope isolation (local/
//            shared/user), the tripwire is one of several layers
//            that all need to fall for an injection to land. See
//            `docs/MEMORY.md §8.1` for the full picture.
//
//      It is NOT the defense. The defense is structural — the
//      modal is the load-bearing gate. Frame this module
//      accordingly when claims about "injection defense" come up.
//
//   2. `SECRET_PATTERNS` — credential-shape regexes (AWS keys,
//      GitHub PATs, Anthropic/OpenAI/Slack tokens). UNLIKE phrase
//      detection, these ARE shape-stable and language-agnostic;
//      a key has the same prefix + entropy regardless of the
//      surrounding prose. The secret pass is the more honest
//      half of this scanner.
//
// Consumers (all gate writes / pins before the substrate persists):
//
//   - `memory_write` tool — runs the full scan on body + description
//     before showing the modal so the operator doesn't get a
//     confirm prompt for content that would be blocked anyway.
//   - `/memory promote shared` slash command — scans before
//     local → shared via the `scanForPromotion` superset (adds
//     path-traversal heuristic + 200-line cap per spec §5.4).
//   - `pin_context` tool / `/pin` slash — `scanForSecrets` only,
//     skipping the phrase pass on operator-direct surfaces.
//   - Harness tool-output gate — runs the full scan on every tool
//     result before it reaches the model, catching credentials
//     that landed in stdout. Phrase pass here is best-effort same
//     story as memory writes.

export interface ScanResult {
  ok: boolean;
  // The first matched phrase / pattern class, used in the audit
  // row's `details.reason`. We surface a CLASS (not the literal
  // text) for secrets so the operator-side audit doesn't
  // duplicate the credential into another column. Phrases echo
  // verbatim because they're benign.
  reason?: string;
}

// English-only obvious-jailbreak phrases. See module header for the
// honest framing: this catches script-kiddie copy-paste, not real
// adversarial input. Spec §7.3 names these verbatim. Do NOT extend
// the list with translations or paraphrases — false-positive rate
// climbs against legitimate operator notes (a memory documenting
// "the model failed when prompted with 'ignore previous instructions'"
// is itself useful content) without moving the threat needle.
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

// Run the obvious-jailbreak tripwire + secret pattern check
// against a single text field (body or description). Used by
// memory_write before the modal opens AND by /memory promote
// shared as part of the `scanForPromotion` superset.
//
// Naming note: the function is called `scanForInjection` for
// backwards compatibility with callers across the codebase; the
// MODULE header (above) reframes what "injection" means here —
// English script-kiddie phrases, NOT semantic injection defense.
// A future rename to `scanWriteTripwire` is in the backlog if/
// when the call sites are touched for another reason.
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

// Secret-only scan (skips the injection-phrase pass). Used on
// operator-direct surfaces where the operator typed the text
// themselves — injection-phrase blocking would be friction (a
// `/pin "ignore previous instructions"` might be a legitimate
// note about a model failure mode), but credential leaks
// (copy-paste of a log line with `sk-ant-...`) still need to be
// caught at the boundary before the secret lands in persistent
// storage and gets re-injected literally on every goal/resume.
// The reason class matches `scanForInjection`'s `secret pattern
// matched` so audit rows from both surfaces share vocabulary.
export const scanForSecrets = (text: string): ScanResult => {
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) {
      return { ok: false, reason: 'secret pattern matched' };
    }
  }
  return { ok: true };
};

// Replace credential-shaped substrings with `<REDACTED:secret>`.
// Used on audit-write paths where the surface must persist
// (the row is the forensic record) but the credential cannot
// (365d retention). Distinct from `scanForSecrets`, which
// rejects the input outright — redaction is "the message is
// worth keeping, the secret in it isn't". Uses the same
// SECRET_PATTERNS set so detection vocabulary stays consistent
// across the codebase.
//
// Idempotent: calling twice yields the same string (the
// placeholder doesn't match any pattern).
export const redactSecrets = (text: string): string => {
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pat.source, `${pat.flags}g`), '<REDACTED:secret>');
  }
  return out;
};

// Hard cap on body line count for promotion (spec §5.4 line 384
// "Content fica < 200 lines"). The cap value names the maximum
// ALLOWED line count: 200 lines passes, 201 fails. Compare
// strictly greater-than so the boundary is treated as "valid at
// the limit": 200 lines passes, 201 fails. Using `>=` would
// reject exactly-200-line bodies while reporting "exceeds
// 200-line cap (got 200)", internally contradictory since 200
// doesn't exceed 200. See `countLines` below for the
// trailing-newline normalization that keeps editor-written
// 200-line files from counting as 201.
export const SHARED_BODY_LINE_CAP = 200;

// Count logical lines in a memory body. Most editors end files
// with a trailing `\n`, which means `body.split('\n').length`
// over-counts by one: `"a\nb\n"` splits as `["a", "b", ""]`
// (length 3) but represents 2 lines. A 200-line body with the
// canonical trailing newline would be flagged as 201 by the
// raw split, falsely tripping the cap.
//
// Normalize by stripping ONE trailing `\n` before splitting.
// Empty body collapses to 0 lines (defensive — writeMemory
// rejects empty bodies up front, but the scanner shouldn't trust
// upstream gates).
//
// CRLF on Windows: `body.endsWith('\n')` matches both `\n` and
// `\r\n`. After slicing off the `\n`, a leftover `\r` becomes
// trailing data on the prior line — counted correctly as part
// of that line, not as a separator.
const countLines = (body: string): number => {
  if (body.length === 0) return 0;
  const normalized = body.endsWith('\n') ? body.slice(0, -1) : body;
  return normalized.split('\n').length;
};

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
  // `\b/etc/...` won't match `to /etc/shadow` because `\b` needs a
  // word char immediately before the `/`, and `/` itself is
  // non-word, so the leading boundary fires only at start-of-
  // string. Drop the leading `\b` and rely on the literal
  // `/etc/` prefix as the anchor; trailing `\b` after the
  // sensitive name still keeps `/etc/passwordless` from
  // matching.
  /\/etc\/(passwd|shadow|hosts)\b/i,
  // Same correction for the Windows literal — the leading `[A-Z]:`
  // begins with a word char, so `\b` is fine. Kept verbatim.
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
  const lineCount = countLines(body);
  if (lineCount > SHARED_BODY_LINE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${SHARED_BODY_LINE_CAP}-line cap (got ${lineCount})`,
    };
  }
  return { ok: true };
};
