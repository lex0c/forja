// Factuality classifier tests (S2/T2.1). Pure function, 4 cases.

import { describe, expect, test } from 'bun:test';
import type { MemoryFrontmatter } from '../../../src/memory/types.ts';
import { isMemoryFactual } from '../../../src/memory/verify/factuality.ts';

const fm = (type: MemoryFrontmatter['type']): MemoryFrontmatter => ({
  name: 'x',
  description: 'y',
  type,
  source: 'user_explicit',
});

describe('isMemoryFactual', () => {
  test("type='project' is factual (verifiable against repo FS)", () => {
    expect(isMemoryFactual(fm('project'))).toBe(true);
  });

  test("type='reference' is factual (verifiable against external systems)", () => {
    // v1 stubs reference verification, but the classifier still
    // tags reference memories as factual so a future
    // ReferenceVerifier wireup picks them up automatically.
    expect(isMemoryFactual(fm('reference'))).toBe(true);
  });

  test("type='user' is preference (subjective claims about the operator)", () => {
    expect(isMemoryFactual(fm('user'))).toBe(false);
  });

  test("type='feedback' is preference (rules stated by the operator)", () => {
    expect(isMemoryFactual(fm('feedback'))).toBe(false);
  });
});
