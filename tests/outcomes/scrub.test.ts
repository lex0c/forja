// Slice 131 fixup: scrubOutcomePayload is currently aliased to
// scrubFailurePayload (slice 130). A direct test pins the
// public-export semantics so a future refactor that diverges
// the two trips a signal in CI rather than silently letting
// failure-side scrub changes propagate to calibration payloads
// without anyone noticing.

import { describe, expect, test } from 'bun:test';
import { scrubOutcomePayload } from '../../src/outcomes/index.ts';

describe('scrubOutcomePayload', () => {
  test('null/undefined → {json: null, truncated: false}', () => {
    expect(scrubOutcomePayload(null)).toEqual({ json: null, truncated: false });
    expect(scrubOutcomePayload(undefined)).toEqual({ json: null, truncated: false });
  });

  test('passes payload values through proto-pollution scrub', () => {
    const r = scrubOutcomePayload({
      __proto__: { isAdmin: true },
      approval_seq: 42,
      ok: 'value',
    } as Record<string, unknown>);
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
    expect(parsed.approval_seq).toBe(42);
    expect(parsed.ok).toBe('value');
  });

  test('redacts paths inside payload values', () => {
    const r = scrubOutcomePayload({
      message: 'tool failed at /home/lex/.ssh/id_rsa',
    });
    const parsed = JSON.parse(r.json as string);
    expect(parsed.message).not.toContain('/home/lex/');
    expect(parsed.message).toContain('<path>');
  });

  test('cycle in payload replaced with sentinel (slice 130 cycle guard inherited)', () => {
    const cyc: Record<string, unknown> = { name: 'x' };
    cyc.self = cyc;
    const r = scrubOutcomePayload(cyc);
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json as string) as Record<string, unknown>;
    expect(parsed.name).toBe('x');
    expect(parsed.self).toBe('__forja_cycle__');
  });

  test('truncates payload over the 8 KiB cap', () => {
    const big = 'a'.repeat(10 * 1024);
    const r = scrubOutcomePayload({ blob: big });
    expect(r.truncated).toBe(true);
  });
});
