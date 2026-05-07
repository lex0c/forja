import type { GitContext } from './git-context.ts';

// Environment block for the system prompt. Gives the model a
// situational anchor at session boot:
//
//   - cwd (where `agent` was invoked)
//   - os (linux / darwin / win32 — drives "use this command on
//     macOS, that on Linux" decisions)
//   - model id (provider/model that's actually running)
//   - today's date (YYYY-MM-DD — lets the model interpret
//     "yesterday's commit" / "log since today" requests without
//     a tool call)
//   - git context (when in a repo): branch, dirty/clean, ahead/
//     behind. Recent commit subjects are intentionally NOT
//     included — see `git-context.ts` for the threat model
//     (commit messages are repo-controlled text and would
//     elevate untrusted content to system-level context).
//
// All fields are stable WITHIN a session (snapshot at boot, not
// re-probed per turn) so the section sits inside cache breakpoint
// #1 and stays there. Across sessions the block varies — date
// rolls forward, working tree changes — but that's per-session
// cache invalidation, not per-turn.

export interface EnvironmentInput {
  cwd: string;
  // OS family. Bootstrap passes `process.platform` directly
  // (`'linux' | 'darwin' | 'win32' | ...`); the composer
  // formats it human-readably.
  platform: string;
  // Provider id, e.g. `anthropic/claude-sonnet-4-6`.
  modelId: string;
  // ISO date `YYYY-MM-DD`. Bootstrap supplies the value so
  // tests can inject a fixed date and the composer stays
  // pure.
  today: string;
  // Git probe result. Null when cwd is not a git repo —
  // the composer omits the git sub-block entirely in that
  // case rather than rendering "branch: (none)".
  git: GitContext | null;
}

const formatPlatform = (p: string): string => {
  // Friendly labels for the common cases. Anything unexpected
  // falls through verbatim — better to show a raw `freebsd`
  // than to claim it's something it isn't.
  if (p === 'linux') return 'Linux';
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  return p;
};

const renderGitBlock = (git: GitContext): string => {
  // Build the sub-content first; only emit the `## Git` header
  // when at least one sub-field renders. Reachable degenerate
  // case (detached HEAD + clean tree + no upstream + empty
  // repo) would otherwise leave a header with nothing under
  // it — visually broken in the rendered prompt.
  const sub: string[] = [];
  if (git.branch !== undefined) {
    sub.push(`- branch: \`${git.branch}\``);
  }
  if (git.modified !== undefined && git.untracked !== undefined) {
    if (git.modified === 0 && git.untracked === 0) {
      sub.push('- status: clean');
    } else {
      const parts: string[] = [];
      if (git.modified > 0) parts.push(`${git.modified} modified`);
      if (git.untracked > 0) parts.push(`${git.untracked} untracked`);
      sub.push(`- status: ${parts.join(', ')}`);
    }
  }
  if (git.ahead !== undefined && git.behind !== undefined) {
    if (git.ahead === 0 && git.behind === 0) {
      sub.push('- upstream: in sync');
    } else {
      sub.push(`- upstream: ahead ${git.ahead}, behind ${git.behind}`);
    }
  }
  if (sub.length === 0) return '';
  return ['', '## Git', ...sub].join('\n');
};

export const renderEnvironmentSection = (input: EnvironmentInput): string => {
  const lines: string[] = [
    '# Environment',
    '',
    `- cwd: \`${input.cwd}\``,
    `- os: ${formatPlatform(input.platform)}`,
    `- model: \`${input.modelId}\``,
    `- today: ${input.today}`,
  ];
  let body = lines.join('\n');
  if (input.git !== null) {
    body += renderGitBlock(input.git);
  }
  return body;
};

// Compose the environment section onto a downstream system prompt.
// Section is PREPENDED so it lands at the top — the model reads
// "where am I, what date is it, what's the working tree state"
// before consuming any task-specific instructions.
export const composeWithEnvironment = (
  downstream: string | undefined,
  input: EnvironmentInput,
): string => {
  const section = renderEnvironmentSection(input);
  if (downstream === undefined || downstream.length === 0) return section;
  return `${section}\n\n${downstream}`;
};
