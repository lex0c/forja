// Canonical parsers for retrieval node ids (RETRIEVAL.md §8.1).
//
// Two view-emitted shapes:
//   - `memory:<scope>/<name>` — scope-qualified registry pointer.
//   - `session:<kind>:<id>` — kind ∈ { message, tool_call, failure }.
//
// Extracted out of compression.ts (where these started, defensive
// against corrupt trace replays) so the session view can use the
// same parser instead of doing prefix-slice and trusting the result.
// Both call sites needed a small set of invariants:
//   - reject empty after-prefix segments
//   - reject unknown scope / kind values
//   - return a discriminated null on malformed input so the caller
//     can branch instead of carrying an empty-string forward
//
// Workspace ids land here when 4.4 ships its view (`workspace:…`).

import type { MemoryScope } from '../memory/index.ts';

const VALID_MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set([
  'user',
  'project_shared',
  'project_local',
]);

const isMemoryScope = (s: string): s is MemoryScope => VALID_MEMORY_SCOPES.has(s as MemoryScope);

// `memory:<scope>/<name>`. Scope must be a canonical MemoryScope.
// Returns null on any malformed shape so the caller can branch
// (compression.ts skips the candidate; views log + drop).
export const parseMemoryNodeId = (nodeId: string): { scope: MemoryScope; name: string } | null => {
  const prefix = 'memory:';
  if (!nodeId.startsWith(prefix)) return null;
  const rest = nodeId.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash < 0) return null;
  const scope = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (scope.length === 0 || name.length === 0) return null;
  if (!isMemoryScope(scope)) return null;
  return { scope, name };
};

export type SessionNodeKind = 'message' | 'tool_call' | 'failure';

const SESSION_KINDS: ReadonlySet<string> = new Set(['message', 'tool_call', 'failure']);

// `session:<kind>:<id>` where kind ∈ { message, tool_call, failure }.
// Returns null on malformed shape so the caller distinguishes a
// genuine map miss from a parse failure.
export const parseSessionNodeId = (
  nodeId: string,
): { kind: SessionNodeKind; id: string } | null => {
  const prefix = 'session:';
  if (!nodeId.startsWith(prefix)) return null;
  const rest = nodeId.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const kind = rest.slice(0, firstColon);
  const id = rest.slice(firstColon + 1);
  if (kind.length === 0 || id.length === 0) return null;
  if (!SESSION_KINDS.has(kind)) return null;
  return { kind: kind as SessionNodeKind, id };
};
