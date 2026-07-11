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

// Why a result is `conservative`. The shapes bucketed under that kind have
// DIFFERENT trust properties, and the autonomous approval posture
// (AGENTIC_CLI.md §8.1) must tell them apart. It is a typed field rather than
// something parsed back out of `reason` for the same reason `confirmCause` is:
// so the auto-approve rule can never drift on a reworded string.
//
//   - 'unknown-command'   — command_resolver_registry miss (`./deploy.sh`,
//                           `somebinary`). The caps emitted for the REST of the
//                           command are honest; the only unknown is what the
//                           binary does internally, which the sandbox's
//                           `cwd-rw` floor contains. Auto-approvable.
//   - 'dynamic-dataflow'  — soft control flow, `$var`, loop over a glob. Caps
//                           are BEST-EFFORT and can UNDER-represent the runtime
//                           target: `for f in /tmp/*; do rm "$f"; done` models
//                           the body's `$f` as `<cwd>/$f` and emits no cap for
//                           the `/tmp/*` loop source. Never auto-approved.
//   - 'cwd-escape'        — a path (or orphan redirect target) resolves OUTSIDE
//                           the cwd via a symlink. The lexical cap
//                           `write-fs:<cwd>/escape` READS as repo-confined while
//                           the write lands outside. This cause exists
//                           PRECISELY to hold the modal against the posture's
//                           confinement check (slices 176/178). Never
//                           auto-approved.
//   - 'unmodeled-tool'    — no resolver registered for the tool at all. No caps,
//                           no basis. Never auto-approved.
//
// Precedence when a shape matches more than one: cwd-escape >
// dynamic-dataflow > unknown-command (most restrictive wins — an
// `unknown-command` INSIDE a `for` loop is `dynamic-dataflow`).
export type ConservativeCause =
  | 'unknown-command'
  | 'dynamic-dataflow'
  | 'cwd-escape'
  | 'unmodeled-tool';

// Whether a conservative result's capability set is a COMPLETE, honest
// representation of the command's effect. Only `unknown-command` qualifies:
// every other cause either under-represents the target or lies about it.
// Fail-closed by construction — an unrecognized future cause is not listed and
// therefore not trusted.
export const conservativeCapsAreHonest = (cause: ConservativeCause): boolean =>
  cause === 'unknown-command';

export type ResolverResult =
  | { kind: 'ok'; capabilities: Capability[]; confidence: ResolverConfidence }
  | {
      kind: 'conservative';
      capabilities: Capability[];
      reason: string;
      cause: ConservativeCause;
    }
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
  cause: 'unmodeled-tool',
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
