import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Auto-generated `.agent/.gitignore` per spec §2.5.
//
// The agent owns this file on first invocation and NEVER
// overwrites it after creation. Operators are free to edit
// freely — adding entries, removing the auto-generated ones, or
// changing comments. Re-running `ensureAgentGitignore` after
// edits is a no-op.
//
// Default contents are intentionally minimal: the rules cover
// runtime data (sessions.db, traces, checkpoints), the
// per-developer memory + skills subtrees (`memory/local/` and
// `skills/local/`), and generic log noise. Anything else (dotenvs,
// build artifacts) belongs in the project's top-level `.gitignore`
// because it isn't agent state.

export const DEFAULT_AGENT_GITIGNORE = `# .agent/.gitignore (auto-generated; safe to edit)
sessions.db
sessions.db-*
traces/
checkpoints/
memory/local/
skills/local/
*.log
`;

export interface EnsureAgentGitignoreResult {
  // Absolute path to the resulting `.gitignore` file.
  path: string;
  // True iff the file was created by this call. False means it
  // already existed and we left it alone (operator-owned after
  // first generation).
  created: boolean;
}

// Idempotent. Creates the parent `.agent/` directory (and any
// intermediates) if missing. Atomic-ish: we write directly with
// `wx` to avoid clobbering a file that materialized between the
// existsSync check and the write. ENOENT on the parent dir is
// covered by the mkdirSync above.
//
// Errors from disk (EACCES, EROFS, ENOSPC) propagate to the
// caller — these aren't graceful-degradation cases at this
// layer; the bootstrap path decides whether to surface to the
// operator or continue without the gitignore.
export const ensureAgentGitignore = (repoRoot: string): EnsureAgentGitignoreResult => {
  const gitignorePath = join(repoRoot, '.agent', '.gitignore');

  if (existsSync(gitignorePath)) {
    return { path: gitignorePath, created: false };
  }

  mkdirSync(dirname(gitignorePath), { recursive: true });

  try {
    // `wx` flag fails with EEXIST if the file appeared between
    // the existsSync check and now (concurrent agent invocation
    // racing on first init). Treat EEXIST as "someone else
    // created it, we're done", same end-state as the existsSync
    // hit.
    writeFileSync(gitignorePath, DEFAULT_AGENT_GITIGNORE, { flag: 'wx' });
    return { path: gitignorePath, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path: gitignorePath, created: false };
    }
    throw err;
  }
};
