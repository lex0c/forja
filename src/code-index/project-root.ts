// Resolve the canonical project root for a given cwd. Used by
// every entry point that opens the code-index DB so the
// `defaultCodeIndexPath` hash lands on the same value
// regardless of which subdirectory the operator invoked from.
//
// Two callers depend on agreement: the CLI (`agent
// --code-index scan/status/rebuild`) and the harness bootstrap
// (which opens CodeIndex per session). If they diverge, the
// scan and the runtime sessions land on different hashed DB
// paths and the harness sees an empty index even after
// `--code-index scan` ran. Hence the shared helper.
//
// Algorithm: prefer `git rev-parse --show-toplevel` because it
// guarantees every subdirectory of a git project resolves to
// the same root. Fall back to `realpathSync(cwd)` for non-git
// directories. Both forms produce an absolute, canonical path
// — the contract `defaultCodeIndexPath` requires.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export const resolveProjectRoot = (cwd: string): string => {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (r.error === undefined && r.status === 0) {
    return r.stdout.trim();
  }
  return realpathSync(cwd);
};
