import type { SystemSegment } from '../providers/types.ts';
import { hashPromptContent } from '../storage/repos/prompt-versions.ts';
import { guideMaxBytes, isSmallWindow } from '../tools/context-budget.ts';
import { composeSystemPrompt } from './memory-prompt.ts';
import {
  type AcquiredGuide,
  composeWithProjectContext,
  PROJECT_GUIDE_MAX_BYTES,
  renderProjectContext,
} from './project-context.ts';

// Acquire/shape split for the system prompt (CONTEXT_TUNING §2.2).
//
// ACQUISITION (bootstrap-once) does the expensive, effectful work — reading /
// trust-probing / sanitizing the project guide, assembling the (boot-window-
// capped) memory + skills segment — and produces these window-INDEPENDENT
// inputs. SHAPING (this module, per turn) is a pure, cheap function of
// (inputs, context_window): it re-clips the guide to the live window and
// recomposes the prompt. The harness calls it at the turn boundary, so a
// mid-session `/model` swap re-leans the guide on the next turn with no event
// — the same pull-at-startTurn pattern `buildToolDefs` uses for the tool list.
//
// Within a model epoch the window is constant ⇒ the output is byte-stable ⇒ the
// cache prefix holds. At a LARGE boot window (full directive tier, guide at the
// absolute cap), `shapeSystemPrompt` reproduces the legacy inline bootstrap
// composition byte-for-byte; a small boot window intentionally diverges (lean
// directive tier + tighter guide clip).
export interface SystemInputs {
  // The composeWith* chain output (identity/env/constraints/…/caller prompt) —
  // everything BEFORE the project guide. The FULL directive tier.
  stablePrefix?: string;
  // The lean directive tier (CONTEXT_TUNING §2.2): same chain minus the parallel
  // + tool-ergonomics hints, used on a tight window. Two precomputed variants so
  // shape just picks — recomputed per turn, so a /model swap re-tiers it.
  stablePrefixLean?: string;
  // The acquired guide body (sanitized, clipped to the absolute cap) plus its
  // framing metadata. Re-clipped to the window budget on every shape. Absent
  // when no trusted guide was found.
  acquiredGuide?: AcquiredGuide;
  // Memory index + skill catalog, already assembled and capped at the BOOT
  // window (eager-exposure provenance is boot-pinned, so the memory cap is a
  // boot decision — not re-applied here). Window-independent at shape time.
  memorySegmentText: string;
}

export interface ShapedSystemPrompt {
  system?: string;
  systemSegments?: SystemSegment[];
  systemPromptHash?: string;
}

export const shapeSystemPrompt = (
  inputs: SystemInputs,
  contextWindow: number,
): ShapedSystemPrompt => {
  const guideSection =
    inputs.acquiredGuide !== undefined
      ? renderProjectContext(
          inputs.acquiredGuide,
          guideMaxBytes(contextWindow, PROJECT_GUIDE_MAX_BYTES),
        ).text
      : '';
  // Directive tier (CONTEXT_TUNING §2.2): a tight window uses the lean prefix;
  // falls back to the full prefix when no lean variant was captured.
  const prefix =
    isSmallWindow(contextWindow) && inputs.stablePrefixLean !== undefined
      ? inputs.stablePrefixLean
      : inputs.stablePrefix;
  // Stable segment = prefix + (re-clipped) guide. Mirrors bootstrap's
  // composeWithProjectContext(prefix, guide) exactly.
  const stableSegmentText = composeWithProjectContext(prefix, guideSection) ?? '';
  const memorySegmentText = inputs.memorySegmentText;
  // Final string = stable ⊕ memory-segment. Equivalent to bootstrap's
  // composeSystemPrompt(composeSystemPrompt(stable, memory), skills): the
  // memory segment already folds memory+skills, and string concatenation
  // associates, so the two produce identical bytes.
  const system = composeSystemPrompt(
    stableSegmentText.length > 0 ? stableSegmentText : undefined,
    memorySegmentText,
  );
  // Segment list mirrors the composition so `flattenSystemSegments` === system
  // (CONTEXT_TUNING §3.1). The stable segment is always present (identity is the
  // outermost layer); the memory segment is omitted only if empty.
  const systemSegments: SystemSegment[] = [
    { id: 'stable', text: stableSegmentText, cacheBreakpoint: true },
    ...(memorySegmentText.length > 0
      ? [{ id: 'memory' as const, text: memorySegmentText, cacheBreakpoint: true }]
      : []),
  ];
  return {
    ...(system !== undefined ? { system } : {}),
    systemSegments,
    ...(system !== undefined ? { systemPromptHash: hashPromptContent(system) } : {}),
  };
};
