import { describe, expect, test } from 'bun:test';
import {
  buildReflectionBlock,
  composeWithReflectionBlock,
  REFLECTION_BLOCK_HEADER,
} from '../../src/cli/reflection-block.ts';

describe('buildReflectionBlock', () => {
  test('returns null for off / undefined / null', () => {
    expect(buildReflectionBlock('off')).toBeNull();
    expect(buildReflectionBlock(undefined)).toBeNull();
    expect(buildReflectionBlock(null)).toBeNull();
  });

  test('terse block carries the canonical header + one-liner contract', () => {
    const out = buildReflectionBlock('terse');
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.startsWith(REFLECTION_BLOCK_HEADER)).toBe(true);
    expect(out).toContain('one-line');
    // The compositor must spell out the literal `Reflection:`
    // marker so the model has a fixed prefix to emit. Fuzzy
    // wording would let the model freelance the format and
    // make audit / regression tests harder to pin.
    expect(out).toContain('Reflection:');
  });

  test('full block carries the paragraph contract', () => {
    const out = buildReflectionBlock('full');
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.startsWith(REFLECTION_BLOCK_HEADER)).toBe(true);
    expect(out).toContain('paragraph');
    expect(out).toContain('Reflection:');
  });
});

describe('composeWithReflectionBlock', () => {
  test('off / undefined → downstream untouched', () => {
    expect(composeWithReflectionBlock('body', 'off')).toBe('body');
    expect(composeWithReflectionBlock('body', undefined)).toBe('body');
    expect(composeWithReflectionBlock('body', null)).toBe('body');
  });

  test('terse appends with separator', () => {
    const out = composeWithReflectionBlock('You are review.', 'terse');
    if (out === undefined) return;
    const bodyIdx = out.indexOf('You are review.');
    const sepIdx = out.indexOf('---');
    const headerIdx = out.indexOf(REFLECTION_BLOCK_HEADER);
    expect(bodyIdx).toBe(0);
    expect(sepIdx).toBeGreaterThan(bodyIdx);
    expect(headerIdx).toBeGreaterThan(sepIdx);
  });

  test('returns block alone when downstream undefined', () => {
    const out = composeWithReflectionBlock(undefined, 'full');
    if (out === undefined) return;
    expect(out.startsWith(REFLECTION_BLOCK_HEADER)).toBe(true);
  });

  test('downstream undefined + off → undefined', () => {
    expect(composeWithReflectionBlock(undefined, 'off')).toBeUndefined();
  });
});
