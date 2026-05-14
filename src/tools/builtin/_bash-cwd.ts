// Shared cwd resolution + validation for the bash tool family.
// Pre-slice 160 the bash tool (and bash_background) accepted any
// `args.cwd` — relative or absolute — and resolved it against the
// session cwd OR used it directly when absolute. The permission
// engine's bash resolver, however, attributes capabilities against
// `ctx.cwd` (the SESSION cwd). Result: capability accounting
// diverged from the actual exec dir.
//
// Concrete attack closed by slice 160:
//   Model emits `bash {command: "cat foo.txt", cwd: "/etc"}`.
//   Resolver attributes `read-fs:<session_cwd>/foo.txt`. Operator's
//   `allow_paths: ['project/**']` rule passes the engine. Broker's
//   `resolvePath(baseCwd, '/etc')` honors the absolute path, so bash
//   actually reads `/etc/foo.txt`. The engine never saw `/etc/...`
//   in any capability; the audit row records the wrong path; the
//   policy authorized something it didn't intend.
//
// Fix A (chosen): refuse `args.cwd` outside the session cwd subtree.
// Operators who genuinely need a different cwd `cd` inside the
// command (the resolver sees the command text and emits capabilities
// for the cd target). Fix B (passing args.cwd into the resolver
// context) was rejected — bigger surface, every resolver branch
// would need an effective-cwd parameter, and the threat is closed
// without it.
//
// Canonicalization defeats symlinks: a symlink inside the project
// pointing at `/etc` would otherwise pass the literal-prefix check
// but actually exec outside cwd. realpath both sides before the
// subtree comparison. Pairs with slice 155's sandbox-runner
// canonicalization (which protects the wrap layer); this guard
// protects the tool-handler entry layer regardless of whether the
// session is sandboxed.

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

export interface ResolveBashCwdOptions {
  // The model-supplied cwd argument. Already type-checked as
  // string-or-undefined upstream by the tool handler.
  argsCwd: string | undefined;
  // The session's working directory (`ctx.cwd`). Treated as the
  // root of the allowed subtree.
  sessionCwd: string;
  // Test seam. Production uses node:fs.realpathSync. Tests inject
  // a stub so the suite doesn't depend on the host filesystem
  // having the test paths present.
  realpath?: (p: string) => string;
}

export type ResolveBashCwdResult = { ok: true; cwd: string } | { ok: false; error: string };

export const resolveAndValidateBashCwd = (opts: ResolveBashCwdOptions): ResolveBashCwdResult => {
  if (opts.argsCwd === undefined) {
    // No explicit cwd → use the session cwd verbatim. The bash
    // handler / bg manager will canonicalize for its own purposes;
    // we don't need to here because the engine's resolver already
    // operates against this same path.
    return { ok: true, cwd: opts.sessionCwd };
  }

  // NUL bytes in paths are rejected by node:fs APIs (since Node 7+)
  // but resolve/relative may produce unexpected output. Reject early
  // so the error message names the problem clearly instead of a
  // downstream ENOTDIR / EINVAL from realpath. Same defense pattern
  // as the buildSbplProfile NUL check (sandbox-runner-macos.ts).
  if (opts.argsCwd.includes('\0')) {
    return {
      ok: false,
      error: 'args.cwd contains a NUL byte (invalid in filesystem paths)',
    };
  }

  const realpath = opts.realpath ?? realpathSync;

  // Step 1: resolve the model's cwd against the session.
  //   - Absolute → use literally (subject to subtree check below).
  //   - Relative → join with session cwd. resolvePath collapses
  //     `..` segments; a malicious `../../etc` joins to outside
  //     the session subtree, caught by the subtree check.
  const proposed = isAbsolute(opts.argsCwd)
    ? opts.argsCwd
    : resolvePath(opts.sessionCwd, opts.argsCwd);

  // Step 2: canonicalize both sides. Symlinks would otherwise let
  // a within-subtree-looking path actually point outside.
  //
  // realpath can fail with ENOENT (the proposed dir doesn't exist
  // yet — model gave a typo'd path or one the command would create)
  // or with EACCES/ELOOP. For ENOENT we fall back to the resolved
  // form: spawn will fail with a real fs error anyway and the
  // subtree check on the resolved form catches the obvious escapes
  // (../escape, /etc/...). Other realpath errors (ELOOP, EACCES on
  // ancestors) also fall back; the spawn-fail is the operator
  // signal.
  let canonicalProposed: string;
  try {
    canonicalProposed = realpath(proposed);
  } catch {
    canonicalProposed = proposed;
  }
  let canonicalSession: string;
  try {
    canonicalSession = realpath(opts.sessionCwd);
  } catch {
    canonicalSession = opts.sessionCwd;
  }

  // Step 3: subtree check. `relative(canonicalSession, canonicalProposed)`:
  //   - `''` when equal (proposed === session) → OK.
  //   - a path like `subdir/...` when proposed is a descendant → OK.
  //   - a `..`-only or `..<sep>...` string when proposed is an
  //     ancestor / sibling / outside → REFUSE.
  //   - an ABSOLUTE path when the two roots differ (e.g. one resolved
  //     to `/private/var/...` and the other to `/var/...` due to a
  //     darwin firmlink). Treat as outside.
  //
  // Naive `rel.startsWith('..')` over-rejects: `path.relative()`
  // emits `..foo` verbatim for a legitimate descendant directory
  // literally named `..foo` (`<session>/..foo`), and the prefix-
  // string check would conflate that with a parent-traversal `..`
  // segment. Falsely-flagged paths broke bash / bash_background
  // calls into in-tree dirs whose names happened to start with two
  // dots. Match a TRUE parent traversal: the first segment of the
  // relative path equals `..` exactly. We split on both POSIX `/`
  // and Windows `\` so the check stays correct under either
  // platform's `path.relative` output.
  const rel = relative(canonicalSession, canonicalProposed);
  if (rel === '') return { ok: true, cwd: canonicalProposed };
  const firstSegment = rel.split(/[\\/]/)[0];
  if (firstSegment === '..' || isAbsolute(rel)) {
    return {
      ok: false,
      error: `args.cwd '${opts.argsCwd}' resolves to '${canonicalProposed}' which is outside session cwd '${canonicalSession}'; bash refuses cwd outside session subtree (use 'cd' inside the command to navigate within the session)`,
    };
  }
  return { ok: true, cwd: canonicalProposed };
};
