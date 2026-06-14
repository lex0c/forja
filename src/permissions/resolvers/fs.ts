// FS resolvers per PERMISSION_ENGINE.md §5.2 (read_file, write_file,
// edit_file) + the search-tool extensions (grep, glob). Each is
// pure, deterministic, returns Ok or Refuse — Conservative is
// reserved for inputs whose shape we can't decide on; for fs tools
// a missing or malformed `path` arg is structural failure and earns
// Refuse, not Conservative.

import { resolve } from 'node:path';
import type { Capability } from '../capabilities.ts';
import { readFs, writeFs } from '../capabilities.ts';
import {
  type Resolver,
  type ResolverContext,
  type ResolverResult,
  registerResolver,
} from './registry.ts';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Some tools historically named the path arg `path` (the v1 contract
// at CONTRACTS §9) while the slice-3 spec examples use `file_path`
// (matches Anthropic SDK tool conventions). Resolvers accept either;
// new tools should standardize on `file_path` going forward.
const filePathOf = (args: Record<string, unknown>): string | null => {
  if (isNonEmptyString(args.file_path)) return args.file_path;
  if (isNonEmptyString(args.path)) return args.path;
  return null;
};

// Parser-differential guard (confused-deputy). The engine classifies
// on `file_path` (preferred by `filePathOf` above), but the
// read_file / write_file / edit_file TOOLS read ONLY `args.path` —
// their inputSchema doesn't even declare `file_path`. When BOTH keys
// are present and DIFFER, the engine would gate `file_path` while the
// tool touches `path`: e.g. `{file_path:'./README.md',
// path:'/home/op/.ssh/id_rsa'}` classifies as a benign read but the
// tool reads the key — bypassing deny_paths, allow_paths scoping, and
// the sensitive-path engine-floor. The two sides disagree on which
// arg is authoritative, so refuse outright rather than silently pick
// one. Equal values (or only one key present) are unambiguous and
// pass through unchanged.
const conflictingPathArgsRefuse = (
  args: Record<string, unknown>,
  tool: string,
): ResolverResult | null => {
  if (
    isNonEmptyString(args.file_path) &&
    isNonEmptyString(args.path) &&
    args.file_path !== args.path
  ) {
    return {
      kind: 'refuse',
      reason: `${tool}: conflicting 'file_path' and 'path' arguments (${JSON.stringify(
        args.file_path,
      )} vs ${JSON.stringify(args.path)}); the engine and tool would resolve different files`,
    };
  }
  return null;
};

// Resolve a path arg into a lexically-normalized textual absolute
// form. Always calls `path.resolve(cwd, ...)` even on absolute
// inputs so `..`/`./` components are normalized lexically; without
// this, a capability scope like `read-fs:/work/proj/../../etc/x`
// would carry the un-normalized form into the audit log and
// intersection checks, defeating slice-25/26 scope-level §10
// enforcement. Does NOT follow symlinks — the engine's path-matching
// pipeline already resolves them via `realpath`; doing it here would
// double the syscalls per check and produce a `read-fs(realpath)`
// capability whose scope no longer matches the policy YAML the
// operator authored. Capabilities carry the lexical path; the
// runtime classifier (slice 1) is the symlink defense.
//
// Tilde expansion (slice 97, R2 P0 finding): a model-emitted
// `'~/.ssh/id_rsa'` would otherwise resolve to `<cwd>/~/.ssh/id_rsa`
// — a literal `~` filename under cwd, which would silently bypass
// every `~`-rooted protected_paths rule because the lexical form
// no longer mentions HOME. Shells expand `~` on execution, so the
// engine has to too or the resolved capability lies about what the
// tool actually touches. Two shapes expand:
//   - bare `'~'` → `ctx.home`
//   - `'~/<rest>'` → `<ctx.home>/<rest>`
// `'~user/...'` (other-user expansion) stays literal: there's no
// safe way to resolve another user's home without an OS call, and
// agents authoring `~root/...` are far more likely an attack than
// legitimate. The literal form will land somewhere harmless or
// outside the operator's policy, surfacing a deny.
const expandTilde = (path: string, home: string): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path;
};

const resolveAbs = (path: string, ctx: ResolverContext): string =>
  resolve(ctx.cwd, expandTilde(path, ctx.home));

const readFileResolver: Resolver = (args, ctx): ResolverResult => {
  const conflict = conflictingPathArgsRefuse(args, 'read_file');
  if (conflict !== null) return conflict;
  const path = filePathOf(args);
  if (path === null) {
    return { kind: 'refuse', reason: "read_file: missing or non-string 'file_path' argument" };
  }
  return {
    kind: 'ok',
    capabilities: [readFs(resolveAbs(path, ctx))],
    confidence: 'high',
  };
};

const writeFileResolver: Resolver = (args, ctx): ResolverResult => {
  const conflict = conflictingPathArgsRefuse(args, 'write_file');
  if (conflict !== null) return conflict;
  const path = filePathOf(args);
  if (path === null) {
    return {
      kind: 'refuse',
      reason: "write_file: missing or non-string 'file_path' argument",
    };
  }
  const abs = resolveAbs(path, ctx);
  // write_file implies BOTH a write and the consequent read (the
  // tool reads the existing file before applying changes when
  // applicable). Pairing both capabilities makes the audit row a
  // truthful summary of what the tool will touch.
  const caps: Capability[] = [writeFs(abs), readFs(abs)];
  return { kind: 'ok', capabilities: caps, confidence: 'high' };
};

const editFileResolver: Resolver = (args, ctx): ResolverResult => {
  const conflict = conflictingPathArgsRefuse(args, 'edit_file');
  if (conflict !== null) return conflict;
  const path = filePathOf(args);
  if (path === null) {
    return { kind: 'refuse', reason: "edit_file: missing or non-string 'file_path' argument" };
  }
  const abs = resolveAbs(path, ctx);
  return {
    kind: 'ok',
    capabilities: [writeFs(abs), readFs(abs)],
    confidence: 'high',
  };
};

const grepResolver: Resolver = (args, ctx): ResolverResult => {
  // grep accepts an optional `path`; absent → falls back to cwd
  // (same convention as the engine's `checkPath` for search tools).
  // Non-string path is structural — refuse rather than coerce.
  const path = args.path;
  if (path !== undefined && !isNonEmptyString(path)) {
    return { kind: 'refuse', reason: "grep: non-string 'path' argument" };
  }
  const target = isNonEmptyString(path) ? resolveAbs(path, ctx) : ctx.cwd;
  return {
    kind: 'ok',
    capabilities: [readFs(target)],
    confidence: 'high',
  };
};

const globResolver: Resolver = (args, ctx): ResolverResult => {
  // glob's surface differs from grep — its search root is `cwd` (the
  // arg, not the session cwd), and `pattern` controls what's matched
  // but not what's allowed. Same defaulting + refusal logic.
  const cwdArg = args.cwd;
  if (cwdArg !== undefined && !isNonEmptyString(cwdArg)) {
    return { kind: 'refuse', reason: "glob: non-string 'cwd' argument" };
  }
  const target = isNonEmptyString(cwdArg) ? resolveAbs(cwdArg, ctx) : ctx.cwd;
  return {
    kind: 'ok',
    capabilities: [readFs(target)],
    confidence: 'high',
  };
};

// `git` is read-only: every mode (log/show/diff/blame/status/ls_files)
// reads the repo. Like grep it takes an optional `path` and defaults
// to cwd when absent; the capability is always a `read-fs` over that
// target. Without this resolver the engine's resolver gate forces a
// conservative `confirm` on every git call ("no resolver registered").
const gitResolver: Resolver = (args, ctx): ResolverResult => {
  const path = args.path;
  if (path !== undefined && !isNonEmptyString(path)) {
    return { kind: 'refuse', reason: "git: non-string 'path' argument" };
  }
  const target = isNonEmptyString(path) ? resolveAbs(path, ctx) : ctx.cwd;
  return {
    kind: 'ok',
    capabilities: [readFs(target)],
    confidence: 'high',
  };
};

registerResolver('read_file', readFileResolver);
registerResolver('write_file', writeFileResolver);
registerResolver('edit_file', editFileResolver);
registerResolver('grep', grepResolver);
registerResolver('glob', globResolver);
registerResolver('git', gitResolver);
