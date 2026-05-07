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
// Trust gate: pointer only emits when the cwd is trusted. An
// untrusted cwd already blocks the boot at the trust modal in
// the REPL path; one-shot mode bypasses the modal but the same
// flag (`isCwdTrusted`) gates downstream surfaces (memory write,
// permission policy). Following the existing convention here
// keeps the pointer consistent with the rest of the bootstrap.
//
// Probe location: cwd FIRST, repoRoot as fallback. Two reasons:
//
//   1. The trust modal in `cli/repl.ts` probes `cwd/AGENTS.md`,
//      not `repoRoot/AGENTS.md`. Probing only repoRoot here would
//      open an asymmetry: an operator running `agent` from a
//      subdir would never see the trust-time "AGENTS.md present"
//      warning, but the bootstrap would still surface a pointer
//      to a file outside the cwd they trusted. cwd-first matches
//      the modal's surface and only falls back to repoRoot when
//      that cwd-specific probe returns nothing — which catches
//      the common case (operator in a subdir, AGENTS.md at the
//      project root) without the asymmetry.
//
//   2. Some teams keep multiple per-area AGENTS.md files (one at
//      `src/AGENTS.md` for the engine, one at `web/AGENTS.md` for
//      the frontend, etc.). In that layout the cwd-specific file
//      is more relevant to the current task than the repo-level
//      one. cwd-first picks the right anchor without operator
//      configuration.
//
// Both gates pass → emit pointer with the resolved path. Neither
// path has a file → empty section, base prompt unchanged.

export interface ProjectPointerInput {
  // Operator's invocation directory. Probed FIRST for AGENTS.md
  // (mirrors the trust modal's probe surface).
  cwd: string;
  // Resolved repo root from `resolveRepoRoot(cwd)`. Probed as
  // fallback when `<cwd>/AGENTS.md` is absent — catches the
  // common case of running `agent` from a subdirectory while
  // AGENTS.md lives at the project root. Bootstrap passes the
  // same `repoRoot` value it computed for memory and boot
  // triggers, so all three subsystems share one anchor.
  repoRoot: string;
  // Cwd-trust flag from `isTrusted(trustListPath, cwd)`. Pointer
  // suppressed when false: a session running in an untrusted dir
  // shouldn't be told to read project rules from a file under
  // that same untrusted tree.
  isCwdTrusted: boolean;
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
// section when AGENTS.md is absent at BOTH the cwd and the
// repoRoot, or when the cwd is untrusted; the caller's compose
// helper passes empty sections through unchanged so the upstream
// prompt stays identical.
//
// `existsSync` is fine here: cheap stat on at most two fixed
// paths, runs once per session bootstrap, and missing-permissions
// / ENOENT resolve cleanly to false (no probe → no pointer →
// unchanged behavior). Errors that escape `existsSync` propagate
// — the operator should see disk-level failures, not silently
// lose the pointer.
export const assembleProjectPointer = (input: ProjectPointerInput): ProjectPointerSection => {
  if (!input.isCwdTrusted) return { text: '' };
  const cwdPath = join(input.cwd, 'AGENTS.md');
  const repoRootPath = join(input.repoRoot, 'AGENTS.md');
  // cwd-first: when both exist, the cwd-specific file wins. This
  // matches the operator running with a subdir-scoped AGENTS.md
  // (per-area conventions), and incidentally collapses to "use
  // the repoRoot file" when cwd === repoRoot (the same path on
  // both checks).
  let agentsMdPath: string | undefined;
  if (existsSync(cwdPath)) {
    agentsMdPath = cwdPath;
  } else if (cwdPath !== repoRootPath && existsSync(repoRootPath)) {
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
