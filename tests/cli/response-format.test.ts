import { describe, expect, test } from 'bun:test';
import {
  RESPONSE_FORMAT_PROMPT,
  composeWithResponseFormat,
} from '../../src/cli/response-format.ts';

describe('response-format', () => {
  test('RESPONSE_FORMAT_PROMPT pins the render target literally', () => {
    // The render target IS the contract — every other rule
    // derives from it. If a future change moves rendering off
    // CommonMark or off monospace, this assertion catches it
    // before downstream rules drift out of alignment.
    expect(RESPONSE_FORMAT_PROMPT).toContain('CommonMark');
    expect(RESPONSE_FORMAT_PROMPT).toContain('monospace');
  });

  test('RESPONSE_FORMAT_PROMPT names the file:line reference shape literally', () => {
    // Concrete pattern, not adjective. The TUI and external
    // tooling depend on this shape to make refs clickable; a
    // drift to `file (line N)` would silently break linking.
    expect(RESPONSE_FORMAT_PROMPT).toContain('file:line');
  });

  test('RESPONSE_FORMAT_PROMPT pins the no-emoji default', () => {
    // Binary rule — emojis don't render uniformly in monospace.
    // Phrased as a default the user can override, not as a ban.
    expect(RESPONSE_FORMAT_PROMPT.toLowerCase()).toContain('no emoji');
  });

  test('RESPONSE_FORMAT_PROMPT bans structural padding (preamble + recap)', () => {
    // ANTI_PATTERNS.md §1.3: verbosity is a consequence of
    // schema + budget, not adjective. The structural form here
    // — "don't preface with I will, don't end with recap" — IS
    // a measurable rule (regex on output).
    expect(RESPONSE_FORMAT_PROMPT.toLowerCase()).toContain("don't preface");
    expect(RESPONSE_FORMAT_PROMPT.toLowerCase()).toContain('recap');
  });

  test('RESPONSE_FORMAT_PROMPT pins the per-sentence density rule', () => {
    // The principle the one-sentence-answer / no-pad rules derive
    // from — every sentence must move the reader. Presence rule.
    expect(RESPONSE_FORMAT_PROMPT).toContain('change what the reader knows');
  });

  test('RESPONSE_FORMAT_PROMPT does NOT carry persona or adjectival tuning', () => {
    // ANTI_PATTERNS.md §1.2 + §1.3: persona ("you are an
    // expert X") and adjectival verbosity ("be concise",
    // "be helpful") are explicitly out of scope. The
    // assertion catches a future drift that would erode the
    // "role-as-tool, not persona" contract.
    const lower = RESPONSE_FORMAT_PROMPT.toLowerCase();
    expect(lower).not.toContain('you are');
    expect(lower).not.toContain('be concise');
    expect(lower).not.toContain('be helpful');
    expect(lower).not.toContain('expert');
    expect(lower).not.toContain('senior');
  });

  test('composeWithResponseFormat returns the hint alone when downstream is undefined', () => {
    const out = composeWithResponseFormat(undefined);
    expect(out).toBe(RESPONSE_FORMAT_PROMPT);
  });

  test('composeWithResponseFormat returns the hint alone when downstream is empty', () => {
    const out = composeWithResponseFormat('');
    expect(out).toBe(RESPONSE_FORMAT_PROMPT);
  });

  test('composeWithResponseFormat prepends hint with separator when downstream is set', () => {
    // Same shape as composeWithParallelHint: the response-format
    // block is OUTERMOST, so its content must appear FIRST in
    // the composed prompt, with the `---` separator before the
    // downstream layer.
    const out = composeWithResponseFormat('# Parallelism\n\nDownstream layer.');
    expect(out.startsWith(RESPONSE_FORMAT_PROMPT)).toBe(true);
    expect(out).toContain('---');
    expect(out).toContain('# Parallelism');
    const hintEnd = RESPONSE_FORMAT_PROMPT.length;
    const sepIdx = out.indexOf('---');
    expect(sepIdx).toBeGreaterThan(hintEnd);
    const downstreamIdx = out.indexOf('# Parallelism');
    expect(downstreamIdx).toBeGreaterThan(sepIdx);
  });
});
