import { existsSync } from 'node:fs';
import { join } from 'node:path';

// `[project_context]` section assembly (spec CONTEXT_TUNING.md §2.0).
//
// Emits a small POINTER to `AGENTS.md` instead of loading the file
// body into the eager system prompt. The model reads the file via
// `read_file` when project conventions, idioms, or rules are
// relevant to the current task. This mirrors the memory subsystem
// (index eager, body lazy): both `[memory_index]` and
// `[project_context]` advertise registries the model can consult,
// neither pays the eager-content cost upfront.
//
// Trade-off vs eager-content (the spec position pre-amendment):
//
//   - cost: ~50 tokens vs ~1-3k tokens, on every turn / compaction
//     call / subagent spawn. Cache amortizes content cost but
//     doesn't eliminate it; the pointer keeps the cache breakpoint
//     #3 stable until AGENTS.md is renamed/removed (edits to the
//     body don't invalidate any cache).
//
//   - prompt-injection surface: smaller. Even after trust grant,
//     a maliciously inherited or pasted AGENTS.md only enters
//     the conversation when the model decides it needs the body
//     and explicitly calls read_file. The verify-on-input
//     pipeline operates on a smaller, deliberate window.
//
//   - forgetting risk: the model may not call read_file when it
//     should. The pointer's verb ("Read it via read_file when
//     project conventions matter") is explicit; if eval shows
//     that's still insufficient, the mitigation is a stronger
//     nudge or first-tool-call auto-injection, not a return to
//     eager-content default.
//
// Trust gate: pointer only emits when the path it advertises is
// trusted. Forja's trust storage (`isTrusted(path, cwd)`) is
// exact-string membership on absolute paths — a trusted
// subdirectory does NOT extend trust to its parent tree. So
// gating only on `isCwdTrusted` while still falling back to
// `repoRoot/AGENTS.md` would advertise a path the operator
// never explicitly trusted: trust was granted for `/repo/src/`,
// the modal probed `/repo/src/AGENTS.md` (absent), and the
// pointer would then nudge the model to read `/repo/AGENTS.md`,
// which the trust modal never disclosed.
//
// Two probes, two independent gates:
//
//   1. cwd: probed only when `isCwdTrusted`. Matches the trust
//      modal's own probe (`repl.ts:397` checks `cwd/AGENTS.md`).
//   2. repoRoot: probed only when `isRepoRootTrusted`. The
//      common operator workflow (trust the whole repo, run
//      `agent` from a subdir) sets both flags true, so the
//      fallback works as before. The narrow case (operator
//      explicitly trusted only the subdir) skips the fallback
//      and emits no pointer, keeping the system prompt's path
//      surface aligned with what the operator authorized.
//
// Probe order is cwd-first: when both files exist (some teams
// keep per-area AGENTS.md at `src/AGENTS.md`, `web/AGENTS.md`,
// etc.), the cwd-specific file is more relevant to the current
// task than the repo-level one.
//
// Equivalent paths (cwd === repoRoot, the common project-root
// invocation) collapse to a single check — both flags are equal
// by construction since `isTrusted` is path-keyed.

export interface ProjectPointerInput {
  // Operator's invocation directory. Probed FIRST for AGENTS.md
  // (mirrors the trust modal's probe surface).
  cwd: string;
  // Resolved repo root from `resolveRepoRoot(cwd)`. Probed as
  // fallback when `<cwd>/AGENTS.md` is absent. Bootstrap passes
  // the same `repoRoot` value it computed for memory and boot
  // triggers, so all three subsystems share one anchor.
  repoRoot: string;
  // Trust flag for the cwd path. When false the cwd probe is
  // skipped entirely.
  isCwdTrusted: boolean;
  // Trust flag for the repoRoot path. Independent of cwd trust
  // because Forja's trust storage is exact-path membership, not
  // tree-spanning. When false the repoRoot fallback is skipped
  // even if AGENTS.md exists there — the operator never
  // disclosed that path to the agent. In the typical "trust the
  // whole repo" workflow this flag matches `isCwdTrusted`; the
  // narrow "trust only this subdir" case is where the gates
  // diverge and the security distinction matters.
  isRepoRootTrusted: boolean;
}

export interface ProjectPointerSection {
  text: string;
  // Path the pointer advertised, exposed for tests / observability
  // ("did the bootstrap actually wire AGENTS.md in?"). Absent when
  // the section was suppressed.
  agentsMdPath?: string;
}

// Section header. Verification rule kept terse — the memory
// section (composed AFTER this one) carries the full
// FACT-vs-PREFERENCE nuance and the canonical list of categories
// (file paths, exported names, schema shape) for cross-session
// memories, and that rule transfers conceptually to AGENTS.md
// content. Restating the same parenthetical list here would
// duplicate token cost in every cached prefix without adding
// signal; the bare "verify factual claims" anchors the posture,
// and the model reads the fuller rule a few hundred tokens later
// in the same prompt.
const SECTION_HEADER = `# Project context

Project-specific conventions, idioms, and rules live at the path below. Read it via read_file when those matter for the current task; re-read if you suspect drift since you last read it this session. The file may be stale — verify factual claims against the live tree before acting.`;

// Probe + assemble the pointer section. Returns an empty-text
// section when no trusted-and-existing AGENTS.md is found at
// the cwd or repoRoot; the caller's compose helper passes empty
// sections through unchanged so the upstream prompt stays
// identical.
//
// Each probe is gated on its own trust flag — the cwd probe on
// `isCwdTrusted`, the repoRoot probe on `isRepoRootTrusted`.
// Trust storage is exact-path membership, so a trusted subdir
// does not implicitly trust its parent; advertising the parent's
// AGENTS.md without an explicit trust grant for that path would
// surface conventions the operator never disclosed at the trust
// modal. Each gate's `false` value is fail-closed (skip the
// probe).
//
// `existsSync` is fine here: cheap stat on at most two fixed
// paths, runs once per session bootstrap, and missing-permissions
// / ENOENT resolve cleanly to false (no probe → no pointer →
// unchanged behavior). Errors that escape `existsSync` propagate
// — the operator should see disk-level failures, not silently
// lose the pointer.
export const assembleProjectPointer = (input: ProjectPointerInput): ProjectPointerSection => {
  const cwdPath = join(input.cwd, 'AGENTS.md');
  const repoRootPath = join(input.repoRoot, 'AGENTS.md');
  const samePath = cwdPath === repoRootPath;
  // cwd-first: when both exist AND both gates pass, the cwd-
  // specific file wins (matches operators using per-area
  // AGENTS.md at `src/`, `web/`, etc.). When cwd === repoRoot
  // the repoRoot branch is unreachable by construction (the cwd
  // probe already covers it); the explicit `!samePath` guard
  // documents that and avoids redundant existsSync calls.
  let agentsMdPath: string | undefined;
  if (input.isCwdTrusted && existsSync(cwdPath)) {
    agentsMdPath = cwdPath;
  } else if (!samePath && input.isRepoRootTrusted && existsSync(repoRootPath)) {
    agentsMdPath = repoRootPath;
  }
  if (agentsMdPath === undefined) return { text: '' };
  return {
    text: `${SECTION_HEADER}\n\n- AGENTS.md at \`${agentsMdPath}\``,
    agentsMdPath,
  };
};

// Compose the project-pointer section onto an optional base
// prompt. Symmetric with `composeSystemPrompt` (memory-prompt.ts):
// pointer is appended after the base. Empty pointer leaves the
// base unchanged — preserves the "no project context" path for
// sessions where AGENTS.md is absent or the dir is untrusted.
//
// Layout note (spec CONTEXT_TUNING.md §2): the actual order in
// the composed string is `system → project_pointer → memory_index`.
// Bootstrap calls this BEFORE `composeSystemPrompt(..., memory)`
// so the memory section ends up after the pointer, matching the
// spec's cache-breakpoint stability ranking (most-stable first).
export const composeWithProjectPointer = (
  basePrompt: string | undefined,
  pointer: string,
): string | undefined => {
  if (pointer.length === 0) return basePrompt;
  if (basePrompt === undefined || basePrompt.length === 0) return pointer;
  return `${basePrompt}\n\n${pointer}`;
};
