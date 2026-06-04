import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.ts';

// 2c: with the modal bridge (ctx.clarify) wired in the REPL, clarify is
// no longer staged out of the registry — it ships as a core tool.
describe('clarify is a core builtin tool', () => {
  test('clarify is registered in BUILTIN_TOOLS', () => {
    const clarify = BUILTIN_TOOLS.find((t) => t.name === 'clarify');
    expect(clarify).toBeDefined();
  });

  test('clarify is operator-confirm bound and not a write/exec', () => {
    const clarify = BUILTIN_TOOLS.find((t) => t.name === 'clarify');
    expect(clarify?.metadata.requiresOperatorConfirm).toBe(true);
    expect(clarify?.metadata.writes).toBe(false);
    expect(clarify?.metadata.idempotent).toBe(true);
  });
});
