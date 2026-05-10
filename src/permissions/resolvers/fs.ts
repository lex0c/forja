// FS resolvers per PERMISSION_ENGINE.md §5.2 (read_file, write_file,
// edit_file) + the search-tool extensions (grep, glob). Each is
// pure, deterministic, returns Ok or Refuse — Conservative is
// reserved for inputs whose shape we can't decide on; for fs tools
// a missing or malformed `path` arg is structural failure and earns
// Refuse, not Conservative.

import { isAbsolute, resolve } from 'node:path';
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

// Resolve a path arg into a textual absolute form. Mirrors the
// matcher's resolve order (isAbsolute → cwd-relative resolve) but
// does NOT follow symlinks — the engine's path-matching pipeline
// already resolves them via `realpath`; doing it here would
// double the syscalls per check and produce a `read-fs(realpath)`
// capability whose scope no longer matches the policy YAML the
// operator authored. Capabilities carry the textual path; the
// runtime classifier (slice 1) is the symlink defense.
const resolveAbs = (path: string, ctx: ResolverContext): string =>
  isAbsolute(path) ? path : resolve(ctx.cwd, path);

const readFileResolver: Resolver = (args, ctx): ResolverResult => {
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

registerResolver('read_file', readFileResolver);
registerResolver('write_file', writeFileResolver);
registerResolver('edit_file', editFileResolver);
registerResolver('grep', grepResolver);
registerResolver('glob', globResolver);
