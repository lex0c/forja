import { describe, expect, test } from 'bun:test';
import { scrubFailurePayload } from '../../src/failures/scrub.ts';

describe('scrubFailurePayload', () => {
  test('null/undefined → {json: null, truncated: false}', () => {
    expect(scrubFailurePayload(null)).toEqual({ json: null, truncated: false });
    expect(scrubFailurePayload(undefined)).toEqual({ json: null, truncated: false });
  });

  test('plain object round-trips', () => {
    const r = scrubFailurePayload({ approval_seq: 12345, tool: 'bwrap' });
    expect(r.truncated).toBe(false);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string);
    expect(parsed).toEqual({ approval_seq: 12345, tool: 'bwrap' });
  });

  test('redacts POSIX paths in string values', () => {
    const r = scrubFailurePayload({ message: 'failed at /home/lex/secrets/token.txt' });
    const parsed = JSON.parse(r.json as string);
    expect(parsed.message).not.toContain('/home/lex/secrets/token.txt');
    expect(parsed.message).toContain('<path>');
  });

  test('redacts URLs in string values', () => {
    const r = scrubFailurePayload({ note: 'fetch failed: https://internal.example.com/secret' });
    const parsed = JSON.parse(r.json as string);
    expect(parsed.note).not.toContain('internal.example.com');
  });

  test('redacts recursively through nested objects + arrays', () => {
    const r = scrubFailurePayload({
      details: { trace: ['at /home/lex/foo.ts', 'https://x.example/y'] },
    });
    const parsed = JSON.parse(r.json as string);
    expect(parsed.details.trace[0]).not.toContain('/home/lex/foo.ts');
    expect(parsed.details.trace[1]).not.toContain('x.example');
  });

  test('strips __proto__ / constructor / prototype keys', () => {
    const payload = {
      __proto__: { isAdmin: true },
      constructor: { polluted: true },
      prototype: { also: true },
      ok_field: 1,
    } as Record<string, unknown>;
    const r = scrubFailurePayload(payload);
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    // `__proto__` access goes through Object.prototype's getter
    // — checking the OWN property is the right invariant.
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
    expect(Object.hasOwn(parsed, 'prototype')).toBe(false);
    expect(parsed.ok_field).toBe(1);
    // Bonus: object literal `{}` must NOT have been polluted.
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  test('truncates payload > 8 KiB', () => {
    const big = 'x'.repeat(10 * 1024); // 10 KiB
    const r = scrubFailurePayload({ blob: big });
    expect(r.truncated).toBe(true);
    const parsed = JSON.parse(r.json as string);
    expect(parsed._truncated).toBeDefined();
    expect(parsed._truncated.original_bytes).toBeGreaterThan(8 * 1024);
    expect(parsed._truncated.cap_bytes).toBe(8 * 1024);
    expect(parsed.blob).toBeUndefined();
  });

  test('payload at the cap stays non-truncated', () => {
    // 7 KiB content + JSON overhead → well under 8 KiB cap.
    const data = 'a'.repeat(7 * 1024);
    const r = scrubFailurePayload({ data });
    expect(r.truncated).toBe(false);
  });

  test('non-string primitives pass through unchanged', () => {
    const r = scrubFailurePayload({ n: 42, b: true, nil: null });
    const parsed = JSON.parse(r.json as string);
    expect(parsed.n).toBe(42);
    expect(parsed.b).toBe(true);
    expect(parsed.nil).toBeNull();
  });

  // Slice 130 fixup #5: cycle guard. Without it the recursive
  // scrub blows the stack and the wire-site catch silently drops
  // the row.
  test('cycle in payload object is replaced with sentinel (no stack overflow)', () => {
    const cyc: Record<string, unknown> = { id: 'x' };
    cyc.self = cyc;
    const r = scrubFailurePayload(cyc);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    expect(parsed.id).toBe('x');
    expect(parsed.self).toBe('__forja_cycle__');
  });

  test('cycle in nested array is also replaced with sentinel', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const r = scrubFailurePayload({ list: arr });
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as { list: unknown[] };
    expect(parsed.list[0]).toBe('__forja_cycle__');
  });

  // Slice 130 fixup #5: BigInt is NOT JSON-serializable; the
  // catch around JSON.stringify must produce a `_scrub_failed`
  // marker row instead of letting the throw propagate to the
  // wire-site swallow.
  test('BigInt payload value lands as _scrub_failed marker (no row loss)', () => {
    const r = scrubFailurePayload({ big: BigInt(123) } as unknown as Record<string, unknown>);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    expect(parsed._scrub_failed).toBeDefined();
    expect((parsed._scrub_failed as Record<string, unknown>).reason).toBe('TypeError');
  });

  // Slice 130 fixup #7 (T-P1-3): cap boundary off-by-one. The cap
  // is `<= MAX_PAYLOAD_BYTES` (no truncate) vs `>` (truncate).
  test('payload exactly at MAX_PAYLOAD_BYTES is NOT truncated', () => {
    // 8 KiB = 8192 bytes. JSON for `{"d":"<7180 a's>"}` = ~7186 chars.
    // Pad until exactly at cap.
    const cap = 8 * 1024;
    const overhead = '{"d":""}'.length; // 8 chars wrapper
    const data = 'a'.repeat(cap - overhead);
    const r = scrubFailurePayload({ d: data });
    expect(r.truncated).toBe(false);
    const bytes = Buffer.byteLength(r.json as string, 'utf8');
    expect(bytes).toBe(cap);
  });

  test('payload at MAX_PAYLOAD_BYTES + 1 IS truncated', () => {
    const cap = 8 * 1024;
    const overhead = '{"d":""}'.length;
    const data = 'a'.repeat(cap - overhead + 1);
    const r = scrubFailurePayload({ d: data });
    expect(r.truncated).toBe(true);
  });
});
