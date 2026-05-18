// Built-in subagent registry — single source of truth for
// definitions shipped with the binary (`src/subagents/builtin/*.md`)
// and operator-visible policy attached to them.
//
// This module exists so a future built-in author has ONE place to
// register the new subagent's metadata. The loader (`load.ts`) reads
// the `.md` files from disk in dev mode; THIS module declares
// cross-cutting policy (PROTECTED_BUILTIN_NAMES) and the EMBEDDED
// fallback the loader uses in compiled binaries (where `import.meta
// .dir` points at /$bunfs/... and readdirSync can't enumerate).

import verifyConflictMd from './verify-conflict.md' with { type: 'text' };
import verifyOverrideMd from './verify-override.md' with { type: 'text' };
import verifySemanticMd from './verify-semantic.md' with { type: 'text' };

/**
 * Built-in subagent definitions embedded at compile time via Bun text
 * imports. The loader (`src/subagents/load.ts:loadSubagents`) falls
 * back to this list when the default `BUILTIN_AGENTS_DIR` resolves
 * empty — which is the case under `bun build --compile`, where
 * `import.meta.dir` becomes the virtual `/$bunfs/...` path that
 * `readdirSync` cannot enumerate. Dev mode (`bun run dev`) hits the
 * filesystem path first and never reaches the fallback.
 *
 * Authors of new built-ins MUST add an entry here AND ship the `.md`
 * file alongside the other definitions. A regression test
 * (`tests/subagents/builtin-embedded.test.ts`) fails the build when
 * the on-disk set and the embedded set diverge — without it, a new
 * built-in works in `bun run dev` but is silently missing from
 * compiled binaries.
 */
export const EMBEDDED_BUILTINS: ReadonlyArray<{
  filename: string;
  raw: string;
}> = [
  { filename: 'verify-conflict.md', raw: verifyConflictMd },
  { filename: 'verify-override.md', raw: verifyOverrideMd },
  { filename: 'verify-semantic.md', raw: verifySemanticMd },
];

/**
 * Built-in subagents whose project / user-scope shadows MUST surface
 * loudly in the loader's `shadows` output (`src/subagents/load.ts`).
 *
 * The default precedence for built-ins is "shadow silently" — an
 * operator who replaces a built-in via `~/.config/agent/agents/foo.md`
 * intentionally overrode the shipped definition; surfacing the
 * shadow on every boot would be noise.
 *
 * Built-ins on this list are different: a project shipping a
 * malicious shadow (e.g., a `verify-semantic.md` that grants the
 * subagent `bash` / `write_file` tools the moment the operator opts
 * in via `--memory-verify-llm`) is a real privilege-escalation
 * vector. The loader emits the shadow row so the existing CLI
 * surface displays it on boot, giving the operator a chance to
 * notice the override before the next dispatch fires.
 *
 * Authors of future built-ins MUST add the name here if a project /
 * user-scope shadow could amplify the subagent's capability or
 * forward access to operator-trusted state. Failure to add the
 * name means the shadow is silent, which is a regression of the
 * G7 hardening.
 */
export const PROTECTED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  // S11 — runs at every step boundary when --memory-verify-llm is
  // set; tool whitelist + isolation = none keeps it safe under the
  // shipped definition, but a project shadow could widen both.
  'verify-semantic',
  // S13 — runs at every step boundary when --memory-conflict-llm
  // is set; pair-judge with memory_read whitelist only. Project
  // shadow could widen tools[] to bash / write_file under the
  // operator's opt-in. Same protection rationale as verify-semantic.
  'verify-conflict',
  // S3 — runs at every step boundary when the override threshold
  // trips (3 events in 24h). EMPTY tools[] in the shipped
  // definition; a project shadow widening tools is the canonical
  // privilege-escalation vector this list defends against.
  'verify-override',
]);
