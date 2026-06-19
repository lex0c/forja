import type { ToolMetadata } from './types.ts';

// Window-relative budget for the FIXED prefix (system prompt + tool schemas —
// the cached region). CONTEXT_TUNING §2.2.
//
// The prefix is a pure derivation of (stable inputs, context_window): the
// harness shapes it per turn from the live `provider.capabilities.context_window`,
// so a mid-session `/model` switch re-leans it on the NEXT turn with no
// event/listener — the same pull-at-startTurn pattern `/budget` and the footer
// already use. The budget is a function of the window ONLY (never of conversation
// position), so within a model epoch the shaped prefix is byte-stable and the
// cache prefix (§3 breakpoints) holds. The only thing that changes the bytes is a
// model switch, which already cold-starts the per-model cache — so recomputing
// then is free, and deriving the budget from anything that varies WITHIN an epoch
// (e.g. history size) is forbidden: it would thrash the cache and cost more.
//
// Lives at the tools layer (the lowest common denominator both the harness tool
// list and the cli guide clip already import) so a builtin can opt into a tier
// via `deferBelowTokens` without an upward tools→harness dependency. Only a
// type import out of `./types.ts`.

// chars/4 ≈ tokens (mirrors `estimatePromptTokens` in providers/tokens.ts), and
// ~1 byte/char for ASCII guides, so tokens × 4 ≈ bytes. Converts a token-fraction
// budget into the byte cap `clipToByteCap` wants.
const BYTES_PER_TOKEN = 4;

// Fraction of the context window (in tokens) the eagerly-embedded project guide
// (`[project_context]`) may occupy. Tunable knob — the ship gate is eval, not a
// fixed %. At 0.10 a 200K window's cap is dominated by the absolute ceiling (no
// behavior change for frontier models); a 32K window clips the guide to ~10%
// (~3.2 KB).
export const GUIDE_WINDOW_FRACTION = 0.1;

// Window threshold (tokens) below which deferrable-but-non-core tools leave the
// base surface. 64K keeps the local-small tier (32K/40K Ollama) lean while
// leaving 128K+ models on the full base set. A tool opts in by setting its
// metadata's `deferBelowTokens` to this.
export const DEFER_BELOW_TOKENS_SMALL = 64_000;

// Byte cap for the project guide at the active window. Never exceeds the caller's
// absolute ceiling (`PROJECT_GUIDE_MAX_BYTES`): that ceiling still bounds
// ACQUISITION (the guide is read up to it at boot, model-agnostically); this only
// clips the already-acquired body FURTHER at shape time. A non-positive window
// means "unknown" (same convention as the compaction gate) → fall back to the
// absolute cap, no window-based clipping.
export const guideMaxBytes = (contextWindow: number, absoluteMaxBytes: number): number => {
  if (contextWindow <= 0) return absoluteMaxBytes;
  const windowBudget = Math.floor(contextWindow * GUIDE_WINDOW_FRACTION * BYTES_PER_TOKEN);
  return Math.min(absoluteMaxBytes, windowBudget);
};

// Whether a tool is kept OFF the base model-facing surface at this window. Two
// independent reasons: the static `deferred` flag (always deferred — §7.6) or a
// window-relative `deferBelowTokens` (deferred only when the window is smaller
// than the tool's threshold). A non-positive (unknown) window disables the
// window-relative arm, preserving the static behavior. Used by BOTH the wire tool
// list AND the `tool_search` catalog/reveal pool, so the two can't diverge.
export const isDeferred = (
  meta: Pick<ToolMetadata, 'deferred' | 'deferBelowTokens'>,
  contextWindow: number,
): boolean =>
  meta.deferred === true ||
  (meta.deferBelowTokens !== undefined &&
    contextWindow > 0 &&
    contextWindow < meta.deferBelowTokens);

// Minimum memory index entries kept even on a tight window — always show at
// least the top dozen so a small-window session isn't blinded to its own
// memories; the trimmed rest stay reachable via memory_list / memory_search.
export const MEMORY_MIN_ENTRIES = 12;

// Fraction of the context window (in tokens) the memory index LINES may occupy.
// The always-on header is excluded from this budget — it carries load-bearing
// save guidance and is not the lever here. ~20 tokens/line (≈80 chars / 4).
export const MEMORY_LINES_WINDOW_FRACTION = 0.04;
const MEMORY_LINE_TOKENS = 20;

// Max memory index entries at this window, or undefined for "no cap". The index
// is cheap relative to a large window, so only the small tier (< 64K) caps —
// this is a guardrail against a pathological memory count on a tight local
// model, not a routine trim. Applied at ASSEMBLY, not per turn: eager-exposure
// provenance is boot-pinned (MEMORY.md §11.2), so the cap is a boot decision
// (unlike the per-turn guide clip). A non-positive (unknown) window → no cap.
export const memoryMaxEntries = (contextWindow: number): number | undefined => {
  if (contextWindow <= 0 || contextWindow >= DEFER_BELOW_TOKENS_SMALL) return undefined;
  const fromWindow = Math.floor(
    (contextWindow * MEMORY_LINES_WINDOW_FRACTION) / MEMORY_LINE_TOKENS,
  );
  return Math.max(MEMORY_MIN_ENTRIES, fromWindow);
};
