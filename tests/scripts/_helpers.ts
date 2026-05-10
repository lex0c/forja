// Test-only helper: resolve a target id to its full record, throwing
// loudly if missing. Tests pin known ids so a missing record is a
// test-bug, not a runtime case — converting silent `undefined` into
// an exception keeps assertions readable without `!` non-null casts
// (banned by Biome's noNonNullAssertion).

import { type BuildTarget, findTarget } from '../../scripts/targets.ts';

export const targetById = (id: string): BuildTarget => {
  const t = findTarget(id);
  if (t === undefined) throw new Error(`test fixture references unknown target: ${id}`);
  return t;
};
