import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Atomic-write helpers shared across the memory subsystem
// (writer.ts, transitions.ts, lifecycle.ts, seeds-installer.ts).
//
// Slice 1's transitions.ts hardening picked `crypto.randomUUID()`
// over the older `process.pid + Math.random()` shape because the
// latter collides if two processes share `pid % 2^16` AND
// Math.random's PRNG state — which happens on process clone on
// some platforms. Slices 1-2 left the writer.ts/lifecycle.ts
// copies on the older shape; slice 3 propagated it into
// seeds-installer.ts. This module consolidates all four call
// sites so the suffix policy and rename semantics can't drift.
//
// POSIX rename is atomic on the same filesystem (Bun honors this),
// so a concurrent reader sees either the old bytes or the new —
// never a torn write. Cross-filesystem renames degrade to
// copy+unlink and lose atomicity; the memory subsystem's scope
// roots are always single-fs (under homedir or repo root), so the
// cross-fs case is intentionally out of scope.

// Compose the temp filename for an atomic-write to `finalPath`.
// Exported so callers writing through a different mechanism (e.g.
// streaming) can reuse the suffix policy.
export const tempPathFor = (finalPath: string): string => `${finalPath}.tmp-${crypto.randomUUID()}`;

// Write `content` atomically to `path`: ensure the destination
// directory exists, write to a temp file next to the target, then
// rename onto the target. The mkdir is idempotent (`{ recursive:
// true }` no-ops when the directory already exists), so callers
// that pre-create the directory pay only a single extra stat.
export const atomicWrite = (path: string, content: string): void => {
  const tmp = tempPathFor(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};
