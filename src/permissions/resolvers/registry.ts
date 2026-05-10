// Registry-only module. Separated from `index.ts` to break a circular
// import: each resolver file (`fs.ts`, `fetch.ts`, `bash.ts`) calls
// `registerResolver` at module load. If `index.ts` both defined the
// registry AND imported the resolvers at the bottom, the resolvers
// would try to consume `registerResolver` while `index.ts` was still
// evaluating — TDZ error. Keep the registry in its own module so the
// resolvers' import chain is `resolver-file → registry.ts` only, and
// `index.ts → resolver-files → registry.ts` flows top-down cleanly.

import type { Capability } from '../capabilities.ts';

export type ResolverConfidence = 'high' | 'medium' | 'low';

export type ResolverResult =
  | { kind: 'ok'; capabilities: Capability[]; confidence: ResolverConfidence }
  | { kind: 'conservative'; capabilities: Capability[]; reason: string }
  | { kind: 'refuse'; reason: string };

export interface ResolverContext {
  cwd: string;
  home: string;
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

export const resolveCapabilities = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ResolverContext,
): ResolverResult => {
  const resolver = REGISTRY.get(toolName);
  if (resolver === undefined) return conservativeFallback(toolName);
  return resolver(args, ctx);
};

// Test seam: clears the registry. Used by unit tests that want to
// build a controlled set of resolvers; production callers never need
// this and shouldn't call it.
export const __resetResolversForTest = (): void => {
  REGISTRY.clear();
};
