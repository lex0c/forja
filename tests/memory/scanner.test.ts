// Direct tests for the shared injection / secret / promotion
// scanner (spec MEMORY.md §7.3 + §5.4). The scanner ships with two
// consumers — `memory_write` tool and `/memory promote shared`
// slash — but those tests cover behavior end-to-end. Unit-level
// tests here pin down the boundary semantics (200-line cap, etc.)
// that integration tests can't easily exercise without large
// fixtures.

import { describe, expect, test } from 'bun:test';
import {
  redactSecrets,
  SHARED_BODY_LINE_CAP,
  scanForInjection,
  scanForPromotion,
  scanForSecrets,
} from '../../src/memory/scanner.ts';

describe('scanForInjection', () => {
  test('clean body passes', () => {
    expect(scanForInjection('Lorem ipsum dolor sit amet').ok).toBe(true);
  });

  test('matches injection phrase case-insensitively', () => {
    const r = scanForInjection('please IGNORE PREVIOUS INSTRUCTIONS');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('injection phrase');
  });

  test('matches each well-known phrase', () => {
    for (const phrase of [
      'ignore previous instructions',
      'ignore all previous',
      'you are now',
      'from now on, always',
      'disregard prior',
      'forget previous',
    ]) {
      expect(scanForInjection(`prelude ${phrase} suffix`).ok).toBe(false);
    }
  });

  test('matches AWS access key shape', () => {
    expect(scanForInjection('cred AKIAIOSFODNN7EXAMPLE here').ok).toBe(false);
  });

  test('matches GitHub PAT shape', () => {
    expect(scanForInjection('token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').ok).toBe(false);
  });

  test('matches Anthropic key shape', () => {
    expect(scanForInjection('sk-ant-aaaaaaaaaaaaaaaaaaaa here').ok).toBe(false);
  });

  test('does NOT match a bare AKIA prefix without the 16-char tail', () => {
    // Prose may legitimately mention "AKIA…" as an example of the
    // prefix; the regex requires the full key shape so the false-
    // positive rate stays low.
    expect(scanForInjection('credentials prefixed AKIA are AWS').ok).toBe(true);
  });
});

describe('scanForSecrets — secret-only subset', () => {
  // Used by operator-direct surfaces (e.g. /pin slash) where the
  // operator typed the text themselves. Injection phrases are
  // tolerated; credential leaks are not.

  test('clean text passes', () => {
    expect(scanForSecrets('Lorem ipsum dolor sit amet').ok).toBe(true);
  });

  test('matches the same secret patterns as scanForInjection', () => {
    expect(scanForSecrets('cred AKIAIOSFODNN7EXAMPLE here').ok).toBe(false);
    expect(scanForSecrets('token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').ok).toBe(false);
    expect(scanForSecrets('sk-ant-aaaaaaaaaaaaaaaaaaaa here').ok).toBe(false);
  });

  test('reason class matches scanForInjection vocabulary', () => {
    const r = scanForSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('secret pattern matched');
  });

  test('does NOT reject injection phrases', () => {
    // The whole point of the secret-only variant: a /pin that says
    // "ignore previous instructions" may be a legitimate operator
    // note about a failure mode. scanForInjection would block;
    // scanForSecrets must not.
    expect(scanForSecrets('ignore previous instructions').ok).toBe(true);
    expect(scanForSecrets('you are now in safe mode').ok).toBe(true);
  });

  test('does NOT match a bare AKIA prefix without the 16-char tail', () => {
    expect(scanForSecrets('credentials prefixed AKIA are AWS').ok).toBe(true);
  });
});

describe('redactSecrets — substitute matched credentials', () => {
  test('replaces a single AWS key with the canonical placeholder', () => {
    const out = redactSecrets('cred AKIAIOSFODNN7EXAMPLE here');
    expect(out).toBe('cred <REDACTED:secret> here');
  });

  test('replaces every match (global flag, multiple occurrences)', () => {
    const out = redactSecrets('one AKIAIOSFODNN7EXAMPLE two AKIAIOSFODNN7EXAMPLE');
    expect(out).toBe('one <REDACTED:secret> two <REDACTED:secret>');
  });

  test('idempotent — re-running produces the same string', () => {
    const once = redactSecrets('sk-ant-aaaaaaaaaaaaaaaaaaaa here');
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  test('leaves clean text untouched', () => {
    const out = redactSecrets('Lorem ipsum dolor sit amet');
    expect(out).toBe('Lorem ipsum dolor sit amet');
  });
});

describe('scanForPromotion — superset of scanForInjection', () => {
  test('inherits injection / secret blocks', () => {
    expect(scanForPromotion('please ignore previous instructions').ok).toBe(false);
    expect(scanForPromotion('AKIAIOSFODNN7EXAMPLE').ok).toBe(false);
  });

  test('rejects path-traversal patterns', () => {
    expect(scanForPromotion('reads ../../etc/passwd nightly').ok).toBe(false);
    expect(scanForPromotion('forwards to /etc/shadow').ok).toBe(false);
  });

  test('matches /etc/ paths after whitespace (regression: \\b broke leading-/)', () => {
    // First cut had `\b/etc/...` which never fired in practice
    // because `\b` requires a word char immediately before `/`,
    // and a leading space isn't a word char, so `to /etc/passwd`
    // slipped through. Boundary check pins the fix in place.
    expect(scanForPromotion('writes to /etc/passwd in startup').ok).toBe(false);
    expect(scanForPromotion('checks  /etc/hosts on boot').ok).toBe(false);
  });

  test('does NOT match /etc/passwordless or /etc/passwd-extension', () => {
    // Trailing `\b` still keeps prose mentioning sensitive-prefix
    // names from being false-positives.
    expect(scanForPromotion('see /etc/passwordless docs').ok).toBe(true);
  });

  test('does NOT reject prose mentioning paths without traversal', () => {
    // memory_write's regular scanner doesn't gate paths at all;
    // promote-only path-traversal heuristic should still let
    // legitimate path mentions through.
    expect(scanForPromotion('the helper reads ./config/foo.yaml').ok).toBe(true);
    expect(scanForPromotion('see /usr/local/bin/forja for details').ok).toBe(true);
  });
});

describe('scanForPromotion — line-cap boundary (spec §5.4)', () => {
  // The cap value names the MAXIMUM allowed line count: 200
  // passes, 201 fails. Earlier cut used `>=` and rejected exactly-
  // at-cap bodies while reporting "exceeds 200-line cap (got 200)"
  // — internally contradictory. Boundary tests pin the comparison
  // semantic so a future regression flips the operator at the limit.

  const bodyWithLines = (n: number): string =>
    // n lines = n-1 newlines if no trailing newline. We split('\n')
    // to count, so the produced body has exactly `n` entries when
    // split.
    Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

  test('cap value is exposed and correct (200 per spec)', () => {
    expect(SHARED_BODY_LINE_CAP).toBe(200);
  });

  test('199 lines: passes (well under cap)', () => {
    expect(scanForPromotion(bodyWithLines(199)).ok).toBe(true);
  });

  test('200 lines: passes (boundary value treated as valid)', () => {
    // Regression for the `>=` bug. Without this assertion, a
    // future swap back to `>=` would silently reject every
    // exactly-at-cap body and the operator would see
    // "exceeds 200-line cap (got 200)" — contradictory copy.
    const r = scanForPromotion(bodyWithLines(200));
    expect(r.ok).toBe(true);
  });

  test('200 lines with trailing newline: passes (regression: editor-style \\n)', () => {
    // Most editors end files with `\n`. Earlier cut counted
    // `body.split('\n').length` raw, which turned a 200-line
    // body + trailing newline into 201 entries (the empty
    // tail) and tripped the cap. Operator's "200-line file
    // saved by editor" should pass; trailing-newline
    // normalization makes it so.
    const r = scanForPromotion(`${bodyWithLines(200)}\n`);
    expect(r.ok).toBe(true);
  });

  test('201 lines with trailing newline: fails with got 201 (not 202)', () => {
    // Symmetric to the regression above: a 201-line body should
    // still report 201, not be inflated to 202 by the trailing
    // newline.
    const r = scanForPromotion(`${bodyWithLines(201)}\n`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('got 201');
  });

  test('CRLF body: trailing \\r\\n normalized like \\n', () => {
    // Windows-style line endings — endsWith('\\n') matches both
    // `\n` and `\r\n`, slicing off the `\n` leaves the `\r` on
    // the previous line (counted as content, not separator).
    const body = bodyWithLines(200).replace(/\n/g, '\r\n');
    expect(scanForPromotion(`${body}\r\n`).ok).toBe(true);
  });

  test('201 lines: fails with descriptive reason', () => {
    const r = scanForPromotion(bodyWithLines(201));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exceeds');
    expect(r.reason).toContain('200');
    expect(r.reason).toContain('got 201');
  });

  test('large body: error reason carries the actual line count', () => {
    const r = scanForPromotion(bodyWithLines(500));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('got 500');
  });
});
