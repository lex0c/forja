import { describe, expect, test } from 'bun:test';
import { forjaCommand } from '../../src/cli/forja-command.ts';

// Suggested/remediation commands must hit the SAME namespace the diagnostic
// ran against. Under a profile, a bare `forja permission rotate-chain` would
// resolve the canonical namespace and mutate the operator's REAL chain — so
// every advertised command re-prefixes the active `--profile`.
describe('forjaCommand', () => {
  test('no profile ⇒ bare `forja <rest>` (byte-identical to a plain string)', () => {
    expect(forjaCommand('purge --force', {})).toBe('forja purge --force');
    expect(forjaCommand('permission verify', {})).toBe('forja permission verify');
  });

  test('empty FORJA_PROFILE is treated as no profile', () => {
    expect(forjaCommand('purge --force', { FORJA_PROFILE: '' })).toBe('forja purge --force');
  });

  test('active profile ⇒ re-prefixes `--profile <name>` before the verb', () => {
    expect(forjaCommand('purge --force', { FORJA_PROFILE: 'dev' })).toBe(
      'forja --profile dev purge --force',
    );
    expect(forjaCommand('permission rotate-chain --reason x', { FORJA_PROFILE: 'dev' })).toBe(
      'forja --profile dev permission rotate-chain --reason x',
    );
  });
});
