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

  // Slice 135 P1 audit-5: multi-hop cycle scrub. The single-hop
  // `a → a` test above proves the WeakSet recognizes a self-ref;
  // a multi-hop cycle `a → b → c → a` is the more realistic shape
  // — Error.cause chains, observable-pattern back-references, or
  // a serializer-emitted ref-graph would all surface this way. The
  // guard is per-descent (single WeakSet threaded through the
  // entire walk), so the third-level visit MUST see `a` already
  // present in the seen-set. A regression that re-instantiated the
  // WeakSet per recurse-depth would only catch the trivial case.
  test('multi-hop cycle a → b → c → a replaced with sentinel at the back-edge', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b' };
    const c: Record<string, unknown> = { id: 'c' };
    a.next = b;
    b.next = c;
    c.next = a; // back-edge — third visit to `a`
    const r = scrubFailurePayload(a);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    // Walk: parsed.id='a'; parsed.next.id='b'; parsed.next.next.id='c';
    // parsed.next.next.next === sentinel (back-edge to `a`).
    expect(parsed.id).toBe('a');
    const next1 = parsed.next as Record<string, unknown>;
    expect(next1.id).toBe('b');
    const next2 = next1.next as Record<string, unknown>;
    expect(next2.id).toBe('c');
    expect(next2.next).toBe('__forja_cycle__');
  });

  test('multi-hop cycle through arrays + objects mixed', () => {
    // A cycle that bounces through an array node in the middle —
    // exercises the array branch of the scrubber's seen-set check.
    const root: Record<string, unknown> = { id: 'root' };
    const inner: Record<string, unknown> = { id: 'inner' };
    const list: unknown[] = [inner];
    root.list = list;
    inner.parent = root; // back-edge through inner
    const r = scrubFailurePayload(root);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as {
      id: string;
      list: Array<{ id: string; parent: unknown }>;
    };
    expect(parsed.id).toBe('root');
    expect(parsed.list[0]?.id).toBe('inner');
    expect(parsed.list[0]?.parent).toBe('__forja_cycle__');
  });

  test('two disjoint cycles in the same payload both get scrubbed', () => {
    // Two independent cycles in different subtrees. Both must
    // terminate at the sentinel. A regression that exited the
    // walk after the first sentinel would let the second cycle
    // crash the stack.
    const cyclesA: Record<string, unknown> = { tag: 'A' };
    cyclesA.self = cyclesA;
    const cyclesB: Record<string, unknown> = { tag: 'B' };
    cyclesB.self = cyclesB;
    const payload = { left: cyclesA, right: cyclesB };
    const r = scrubFailurePayload(payload);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as {
      left: { tag: string; self: unknown };
      right: { tag: string; self: unknown };
    };
    expect(parsed.left.tag).toBe('A');
    expect(parsed.left.self).toBe('__forja_cycle__');
    expect(parsed.right.tag).toBe('B');
    expect(parsed.right.self).toBe('__forja_cycle__');
  });

  test('non-cyclic shared reference (diamond) preserved across both branches', () => {
    // The seen-set is per-descent — once we enter a node it gets
    // added regardless of cycle vs. shared. With the current
    // implementation, a SHARED but non-cyclic reference (`payload
    // { a: shared, b: shared }`) collapses to sentinel on the
    // second branch. This pins that behavior so a future
    // "optimization" that allows shared-but-acyclic doesn't silently
    // change the JSON shape consumers depend on.
    //
    // Operationally this is fine for audit: shared-references in
    // payload objects are extremely rare (payload is usually
    // built ad-hoc per emit site), and the sentinel preserves
    // signal. Documenting the contract is the test's job.
    const shared: Record<string, unknown> = { kind: 'shared' };
    const payload = { a: shared, b: shared };
    const r = scrubFailurePayload(payload);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as {
      a: { kind: string };
      b: unknown;
    };
    expect(parsed.a.kind).toBe('shared');
    // Second branch sees `shared` already in seen → sentinel.
    expect(parsed.b).toBe('__forja_cycle__');
  });

  test('proto-pollution at depth 5 is stripped (not just shallow nesting)', () => {
    // Existing safe-json tests cover top-level + 1-3 nested levels.
    // Make sure deep nesting doesn't accidentally bypass the
    // recursion via an early-exit optimization.
    const deep: Record<string, unknown> = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                __proto__: { isAdmin: true },
                real: 'value',
              },
              other: 'data',
            },
          },
        },
      },
    };
    const r = scrubFailurePayload(deep);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string);
    // Walk down + assert __proto__ is gone, `real` preserved.
    const l5 = (
      (
        (
          ((parsed as Record<string, unknown>).l1 as Record<string, unknown>).l2 as Record<
            string,
            unknown
          >
        ).l3 as Record<string, unknown>
      ).l4 as Record<string, unknown>
    ).l5 as Record<string, unknown>;
    expect(Object.hasOwn(l5, '__proto__')).toBe(false);
    expect(l5.real).toBe('value');
  });

  test('proto-pollution inside an array element at any depth is stripped', () => {
    // The proto-scrub walks arrays via the recursive branch; this
    // pins that arrays of objects containing __proto__ at deep
    // positions also get cleaned.
    const payload = {
      items: [
        { ok: 1 },
        {
          nested: [{ ok: 2 }, { __proto__: { polluted: true }, ok: 3 }],
        },
      ],
    };
    const r = scrubFailurePayload(payload);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as {
      items: Array<{ ok?: number; nested?: Array<Record<string, unknown>> }>;
    };
    const item1 = parsed.items[1];
    const inner = item1?.nested?.[1];
    if (inner === undefined) throw new Error('shape');
    expect(Object.hasOwn(inner, '__proto__')).toBe(false);
    expect(inner.ok).toBe(3);
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
