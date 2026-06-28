// Registry-only module. Separated from `index.ts` to break a circular
// import: each resolver file (`fs.ts`, `fetch.ts`, `bash.ts`) calls
// `registerResolver` at module load. If `index.ts` both defined the
// registry AND imported the resolvers at the bottom, the resolvers
// would try to consume `registerResolver` while `index.ts` was still
// evaluating — TDZ error. Keep the registry in its own module so the
// resolvers' import chain is `resolver-file → registry.ts` only, and
// `index.ts → resolver-files → registry.ts` flows top-down cleanly.

import type { Capability } from '../capabilities.ts';
import { isMcpToolName } from '../mcp-naming.ts';

export type ResolverConfidence = 'high' | 'medium' | 'low';

export type ResolverResult =
  | { kind: 'ok'; capabilities: Capability[]; confidence: ResolverConfidence }
  | { kind: 'conservative'; capabilities: Capability[]; reason: string }
  | { kind: 'refuse'; reason: string };

export interface ResolverContext {
  cwd: string;
  home: string;
  // Slice 176 (review — command-bypass P0). Optional realpath seam
  // for the bash analyzer's per-arg protected-path classifier. When
  // set, the resolver canonicalizes lexically-resolved paths before
  // classification so a symlink shape like
  //   /work/proj/legit.txt → /etc/shadow
  // (created by the operator or by a prior write) doesn't slip past
  // the §11 deny tier when `cat legit.txt` is analyzed. Without
  // canonicalization, the lexical `/work/proj/legit.txt` doesn't
  // match any protected zone, but the kernel follows the symlink at
  // exec time and reads `/etc/shadow`. The seam is optional so
  // tests (which build paths that don't exist on disk) can omit it
  // and stay on the lexical-only path; production wiring (engine
  // proper) passes `fs.realpathSync` wrapped in try/catch so missing
  // paths fall back to the lexical form (correct for write-creates-
  // new-file).
  realpath?: (p: string) => string;
  // Slice 178 (review). Optional readlink seam for the dangling-
  // symlink fallback path: when `realpath(lexicalAbs)` throws
  // (target removed or never existed) but the lexical path is
  // itself a symlink, `readlink` still returns the stored target.
  // Without this seam the resolver's parent-realpath fallback
  // rejoins basename and concludes "no escape" — the kernel,
  // however, follows the symlink at exec time and the read/write
  // lands at the (possibly outside-cwd) target. Same optional
  // posture as `realpath`: tests omit and stay on the lexical-
  // only path; production wiring passes `fs.readlinkSync`.
  readlink?: (p: string) => string;
  // Silences the one-time stderr warning the bash resolver emits
  // when it observes `realpath` as undefined. The warning exists
  // to flag accidental regression in production wiring; tests that
  // INTENTIONALLY omit `realpath` (per the comments above) set
  // this flag to keep the test log clean.
  //
  // Production callers MUST leave this undefined / false — the
  // warning is the audit signal that flags accidental removal of
  // the symlink-escape defense.
  suppressDegradeWarnings?: boolean;
}

export type Resolver = (args: Record<string, unknown>, ctx: ResolverContext) => ResolverResult;

const REGISTRY = new Map<string, Resolver>();

export const registerResolver = (toolName: string, resolver: Resolver): void => {
  REGISTRY.set(toolName, resolver);
};

export const getResolver = (toolName: string): Resolver | undefined => REGISTRY.get(toolName);

export const conservativeFallback = (toolName: string): ResolverResult => ({
  kind: 'conservative',
  capabilities: [],
  reason: `no resolver registered for tool '${toolName}'`,
});

// MCP tools (`mcp__<server>__<tool>`) carry dynamic, server-supplied names,
// so they cannot be pre-registered by exact name. Their effects are
// remote/opaque (a JSON-RPC call into a trusted server subprocess), so they
// resolve to NO statically-known local capabilities at HIGH confidence — NOT
// the conservative fallback, which would force a confirm on every call and
// defeat the "allow a trusted-manifest MCP tool by default" posture
// (PERMISSION dispatch case 'mcp'). The real controls are the per-manifest-
// hash trust gate, the `mcp_tool` risk weight (name-based, still applies),
// and the stdio sandbox. The `mcp__` prefix predicate is shared with the risk
// scorer + tool-factory via `permissions/mcp-naming.ts` so the three can't drift.
export const resolveCapabilities = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ResolverContext,
): ResolverResult => {
  const resolver = REGISTRY.get(toolName);
  if (resolver !== undefined) return resolver(args, ctx);
  if (isMcpToolName(toolName)) {
    return { kind: 'ok', capabilities: [], confidence: 'high' };
  }
  return conservativeFallback(toolName);
};

// Test seam: clears the registry. Used by unit tests that want to
// build a controlled set of resolvers; production callers never need
// this and shouldn't call it.
export const __resetResolversForTest = (): void => {
  REGISTRY.clear();
};
