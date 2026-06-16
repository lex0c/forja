import { describe, expect, test } from 'bun:test';
import { playbookDirsHint } from '../../src/tools/builtin/task-shared.ts';

// `playbookDirsHint` is the single source for the "where do playbooks
// live" advice the three subagent tools surface when no registry or
// definition is found (task / task_async / task_list). The real
// discovery dirs (subagents/paths.ts) are profile-aware, so the hint
// MUST track the active namespace — a hardcoded canonical hint would
// send a `--profile dev` operator to a directory the run never reads.
describe('playbookDirsHint', () => {
  test('no profile → canonical dirs (byte-identical to pre-profile)', () => {
    expect(playbookDirsHint({})).toBe('~/.config/forja/playbooks/ or <cwd>/.forja/playbooks/');
    // Empty FORJA_PROFILE is treated as "no profile", not a literal segment.
    expect(playbookDirsHint({ FORJA_PROFILE: '' })).toBe(
      '~/.config/forja/playbooks/ or <cwd>/.forja/playbooks/',
    );
  });

  test('active profile → both segments carry the profile', () => {
    expect(playbookDirsHint({ FORJA_PROFILE: 'dev' })).toBe(
      '~/.config/forja-dev/playbooks/ or <cwd>/.forja-dev/playbooks/',
    );
  });

  test('a malformed profile throws rather than silently using canonical', () => {
    // Mirrors the app-namespace contract: a typo'd profile that resolved
    // to the real namespace would defeat the isolation the operator asked
    // for, so the hint surfaces the same hard failure as path resolution.
    expect(() => playbookDirsHint({ FORJA_PROFILE: '../escape' })).toThrow(/invalid FORJA_PROFILE/);
  });
});
