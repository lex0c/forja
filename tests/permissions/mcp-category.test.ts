import { describe, expect, test } from 'bun:test';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import { categoryIsEgress } from '../../src/permissions/types.ts';
import type { Policy } from '../../src/permissions/types.ts';

// The 'mcp' category gates tools imported from a trusted MCP server. The
// per-manifest-hash trust prompt is the heavyweight gate (it approved the
// server + its whole tool set); the category default here is allow, with
// the deterministic risk score still able to upgrade a risky call to
// confirm via the approval gate. stdio MCP is a local subprocess → never
// egress.

const CWD = '/proj';
const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

describe('permission engine: mcp category', () => {
  test('a trusted-manifest MCP tool is allowed by default (no policy section)', () => {
    const eng = createPermissionEngine(policy(), { cwd: CWD });
    expect(eng.check('mcp__postgres__query', 'mcp', { sql: 'SELECT 1' }).kind).toBe('allow');
  });

  test('the allow holds with an unrelated populated policy', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { deny: ['rm -rf *'] } } }), {
      cwd: CWD,
    });
    expect(eng.check('mcp__github__create_issue', 'mcp', { title: 'x' }).kind).toBe('allow');
  });

  test('mcp is NOT egress — stdio is a local subprocess', () => {
    expect(categoryIsEgress('mcp')).toBe(false);
  });
});
