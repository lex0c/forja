import { describe, expect, test } from 'bun:test';
import { composeWithIdentity, IDENTITY_PROMPT } from '../../src/cli/identity-prompt.ts';

describe('identity-prompt', () => {
  test('IDENTITY_PROMPT states what the agent is and the policy it runs under', () => {
    // Role-as-tool, not persona: the marker must name the tool
    // and its operating policy — the load-bearing facts §1.2
    // asks for — not personality or tone.
    expect(IDENTITY_PROMPT).toContain('Hephaestus');
    expect(IDENTITY_PROMPT.toLowerCase()).toContain('declarative policy');
    expect(IDENTITY_PROMPT.toLowerCase()).toContain('verified');
    expect(IDENTITY_PROMPT.toLowerCase()).toContain('auditable');
  });

  test('IDENTITY_PROMPT stays a short role marker, not persona prose', () => {
    // ANTI_PATTERNS §1.2 caps the marker at 3-5 lines and rejects
    // persona prose. Guard the length and the absence of the
    // canonical persona opener.
    expect(IDENTITY_PROMPT.split('\n').length).toBeLessThanOrEqual(5);
    expect(IDENTITY_PROMPT).not.toContain('expert');
  });

  test('composeWithIdentity returns the marker alone when downstream is undefined', () => {
    expect(composeWithIdentity(undefined)).toBe(IDENTITY_PROMPT);
  });

  test('composeWithIdentity returns the marker alone when downstream is empty', () => {
    expect(composeWithIdentity('')).toBe(IDENTITY_PROMPT);
  });

  test('composeWithIdentity prepends the marker ahead of downstream, no --- separator', () => {
    const out = composeWithIdentity('# Environment\n\nbody');
    expect(out.startsWith(IDENTITY_PROMPT)).toBe(true);
    expect(out).toContain('# Environment');
    // Identity is the frame, not a peer hint layer — joined with
    // a blank line, never the `---` rule the hint layers use.
    expect(out).toBe(`${IDENTITY_PROMPT}\n\n# Environment\n\nbody`);
  });
});
