import { describe, expect, test } from 'bun:test';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { McpPolicy, Policy } from '../../src/permissions/types.ts';
import { categoryIsEgress } from '../../src/permissions/types.ts';

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

  test('mcp.egress IS egress — a network-granted server can exfil (MCP.md §2.3)', () => {
    expect(categoryIsEgress('mcp.egress')).toBe(true);
  });

  test('an mcp.egress tool defaults to confirm — network egress is never silent', () => {
    const eng = createPermissionEngine(policy(), { cwd: CWD });
    const d = eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' });
    expect(d.kind).toBe('confirm');
  });

  test('autonomous does NOT auto-approve an mcp.egress tool — a remote server can exfil', () => {
    // The autonomous posture flips ordinary policy confirms to allow, but egress
    // is exempt (categoryIsEgress) — a remote MCP server's every call stays seen.
    const eng = createPermissionEngine(policy(), { cwd: CWD, approvalPosture: 'autonomous' });
    const d = eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' });
    expect(d.kind).toBe('confirm');
  });
});

describe('permission engine: per-tool mcp policy ([tools.mcp])', () => {
  const withMcp = (mcp: McpPolicy): Policy => policy({ tools: { mcp } });

  test('a deny pattern blocks one tool while siblings keep the category default', () => {
    const eng = createPermissionEngine(withMcp({ deny: ['mcp__github__delete_*'] }), { cwd: CWD });
    expect(eng.check('mcp__github__delete_repo', 'mcp', {}).kind).toBe('deny');
    expect(eng.check('mcp__github__list_repos', 'mcp', {}).kind).toBe('allow');
  });

  test('deny beats the egress default too', () => {
    const eng = createPermissionEngine(withMcp({ deny: ['mcp__proxy__*'] }), { cwd: CWD });
    expect(eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' }).kind).toBe('deny');
  });

  test('a confirm pattern forces a prompt on an otherwise-allowed tool', () => {
    const eng = createPermissionEngine(withMcp({ confirm: ['mcp__github__*'] }), { cwd: CWD });
    expect(eng.check('mcp__github__create_issue', 'mcp', {}).kind).toBe('confirm');
  });

  test('an explicit allow opts an egress tool out of its default confirm', () => {
    const eng = createPermissionEngine(withMcp({ allow: ['mcp__proxy__fetch'] }), { cwd: CWD });
    // the operator pre-authorized THIS exact egress tool → allow, not confirm…
    expect(eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' }).kind).toBe('allow');
    // …a sibling egress tool not listed still confirms (the default holds)
    expect(eng.check('mcp__proxy__post', 'mcp.egress', { url: 'https://x' }).kind).toBe('confirm');
  });

  test('an explicit allow on an egress tool holds under autonomous (operator pre-authorized it)', () => {
    const eng = createPermissionEngine(withMcp({ allow: ['mcp__proxy__fetch'] }), {
      cwd: CWD,
      approvalPosture: 'autonomous',
    });
    expect(eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' }).kind).toBe('allow');
  });

  test('deny beats allow when a tool matches both', () => {
    const eng = createPermissionEngine(
      withMcp({ allow: ['mcp__github__*'], deny: ['mcp__github__delete_*'] }),
      { cwd: CWD },
    );
    expect(eng.check('mcp__github__delete_repo', 'mcp', {}).kind).toBe('deny');
    expect(eng.check('mcp__github__read', 'mcp', {}).kind).toBe('allow');
  });

  test('a glob is server- and tool-scoped — no cross-server leak', () => {
    const eng = createPermissionEngine(withMcp({ deny: ['mcp__github__*'] }), { cwd: CWD });
    expect(eng.check('mcp__github__x', 'mcp', {}).kind).toBe('deny');
    expect(eng.check('mcp__gitlab__x', 'mcp', {}).kind).toBe('allow'); // different server
  });

  test('a session-allow lets a confirmed egress tool through for the rest of the session', () => {
    const eng = createPermissionEngine(policy(), { cwd: CWD });
    expect(eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' }).kind).toBe('confirm');
    eng.addSessionAllow('mcp', 'mcp__proxy__fetch');
    expect(eng.check('mcp__proxy__fetch', 'mcp.egress', { url: 'https://x' }).kind).toBe('allow');
  });
});
