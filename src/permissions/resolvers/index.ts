// Public re-exports for the resolver subsystem. The registry lives
// in `./registry.ts` to break a circular import (see registry.ts
// for the rationale). This file pulls in every builtin resolver so
// a single `import './resolvers/index.ts'` from the engine wires
// the full set.

export type {
  Resolver,
  ResolverConfidence,
  ResolverContext,
  ResolverResult,
} from './registry.ts';
export {
  __resetResolversForTest,
  conservativeFallback,
  getResolver,
  registerResolver,
  resolveCapabilities,
} from './registry.ts';

// Side-effecting imports: each resolver module calls
// `registerResolver` at top level. Importing them here guarantees
// every builtin is in the registry by the time consumers of this
// file get hold of `resolveCapabilities`.
import './fs.ts';
import './fetch.ts';
import './bash.ts';
