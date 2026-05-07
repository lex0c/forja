import { describe, expect, test } from 'bun:test';
import {
  composeWithEnvironment,
  renderEnvironmentSection,
} from '../../src/cli/environment-prompt.ts';

const baseInput = {
  cwd: '/repo',
  platform: 'linux',
  modelId: 'anthropic/claude-sonnet-4-6',
  today: '2026-05-07',
  git: null,
};

describe('renderEnvironmentSection', () => {
  test('emits cwd, OS, model, and date', () => {
    const out = renderEnvironmentSection(baseInput);
    expect(out).toContain('# Environment');
    expect(out).toContain('cwd: `/repo`');
    expect(out).toContain('os: Linux');
    expect(out).toContain('model: `anthropic/claude-sonnet-4-6`');
    expect(out).toContain('today: 2026-05-07');
  });

  test('OS labels: linux/darwin/win32 get friendly names; others pass through', () => {
    expect(renderEnvironmentSection({ ...baseInput, platform: 'linux' })).toContain('os: Linux');
    expect(renderEnvironmentSection({ ...baseInput, platform: 'darwin' })).toContain('os: macOS');
    expect(renderEnvironmentSection({ ...baseInput, platform: 'win32' })).toContain('os: Windows');
    // Unknown platform passes verbatim — better honest than mislabeled.
    expect(renderEnvironmentSection({ ...baseInput, platform: 'freebsd' })).toContain(
      'os: freebsd',
    );
  });

  test('omits git block entirely when git is null (cwd not a git repo)', () => {
    const out = renderEnvironmentSection({ ...baseInput, git: null });
    expect(out).not.toContain('## Git');
    expect(out).not.toContain('branch:');
  });

  test('renders the git block when git context is provided', () => {
    const out = renderEnvironmentSection({
      ...baseInput,
      git: {
        branch: 'feat/m4-context-tuning',
        modified: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
      },
    });
    expect(out).toContain('## Git');
    expect(out).toContain('branch: `feat/m4-context-tuning`');
    expect(out).toContain('status: clean');
    expect(out).toContain('upstream: in sync');
    // Recent commit subjects are intentionally NOT rendered —
    // see git-context.ts threat model. Pin the absence so a
    // future contributor reintroducing the field doesn't
    // silently elevate repo-controlled text into the system
    // prompt.
    expect(out).not.toContain('recent commits');
    expect(out).not.toContain('recent commit');
  });

  test('renders dirty status when working tree has changes', () => {
    const out = renderEnvironmentSection({
      ...baseInput,
      git: {
        branch: 'develop',
        modified: 5,
        untracked: 2,
      },
    });
    expect(out).toContain('status: 5 modified, 2 untracked');
    // No upstream sub-line when ahead/behind absent (no tracking branch).
    expect(out).not.toContain('upstream:');
  });

  test('renders ahead/behind when not in sync', () => {
    const out = renderEnvironmentSection({
      ...baseInput,
      git: {
        branch: 'develop',
        modified: 0,
        untracked: 0,
        ahead: 3,
        behind: 1,
      },
    });
    expect(out).toContain('upstream: ahead 3, behind 1');
  });

  test('omits branch line when branch is undefined (detached HEAD)', () => {
    const out = renderEnvironmentSection({
      ...baseInput,
      git: {
        modified: 0,
        untracked: 0,
      },
    });
    expect(out).toContain('## Git');
    expect(out).not.toContain('branch:');
    expect(out).toContain('status: clean');
  });

  test('omits the entire ## Git block when no sub-field renders', () => {
    // Reachable degenerate case: detached HEAD (branch=undef) +
    // failed status probe (modified/untracked=undef) + no
    // upstream (ahead/behind=undef). Without this guard the
    // section would emit `## Git` with nothing under it —
    // visually broken in the rendered prompt and confusing to
    // the model.
    const out = renderEnvironmentSection({
      ...baseInput,
      git: {},
    });
    expect(out).not.toContain('## Git');
    // Env-only fields still render correctly.
    expect(out).toContain('# Environment');
    expect(out).toContain('cwd: `/repo`');
  });
});

describe('composeWithEnvironment', () => {
  test('returns the section alone when downstream is undefined', () => {
    const out = composeWithEnvironment(undefined, baseInput);
    expect(out.startsWith('# Environment')).toBe(true);
  });

  test('prepends the section to non-empty downstream with blank-line separator', () => {
    const out = composeWithEnvironment('downstream body', baseInput);
    expect(out.startsWith('# Environment')).toBe(true);
    expect(out.endsWith('downstream body')).toBe(true);
    expect(out).toContain('\n\ndownstream body');
  });
});
