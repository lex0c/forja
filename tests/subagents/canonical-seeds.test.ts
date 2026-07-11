import { describe, expect, test } from 'bun:test';
import { CANONICAL_PLAYBOOKS } from '../../src/cli/init-playbooks/index.ts';
import { loadSubagentFromString } from '../../src/subagents/load.ts';
import { validateSubagentSet } from '../../src/subagents/validate.ts';
import { registerBuiltinTools } from '../../src/tools/builtin/index.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

// First-run eval. `forja init` materializes these canonical playbooks as
// subagent seeds, and bootstrap validates them via validateSubagentSet
// against the builtin toolset. A tool-capability gate that rejects a seed
// (e.g. the too-broad escapesCwd gate that briefly barred bash) bricks the
// FIRST RUN for every new user — a class of bug ~850 unit tests missed
// because none exercised the real shipped seeds end-to-end. This closes
// that gap: the seeds we ship must always survive their own bootstrap.
describe('canonical playbook seeds', () => {
  test('all parse and pass bootstrap validation against the builtin toolset', () => {
    expect(CANONICAL_PLAYBOOKS.length).toBeGreaterThan(0);
    const registry = createToolRegistry();
    registerBuiltinTools(registry);
    const defs = CANONICAL_PLAYBOOKS.map((p) =>
      loadSubagentFromString(p.content, 'builtin', `builtin/${p.filename}`),
    );
    // Exactly the bootstrap path (src/cli/bootstrap.ts) — first offending
    // seed throws with its name + source path.
    expect(() => validateSubagentSet(defs, registry)).not.toThrow();
  });
});
