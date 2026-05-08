// Slice B helpers — pure functions the harness loop uses to gate
// the critique pass and translate its result back into something the
// model sees on `redo`. Kept out of `engine.ts` so the LLM call path
// stays focused on "how to call the critic"; these helpers know
// "when to call" and "how to render the answer".

import type { CollectedToolUse } from '../harness/collect.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type {
  CritiqueConfig,
  CritiqueInput,
  CritiqueIssue,
  CritiqueToolPlanEntry,
} from './types.ts';

// Decide whether the engine should run for this step. Mirrors the
// matrix in ORCHESTRATION.md §6.1:
//
//   off          → never
//   on_writes    → step with no tool_use AND non-empty text → yes
//                  step with any writes:true tool_use       → yes
//                  step with only read-only tool_uses       → no
//   always       → step with any tool_use that is NOT all-read-only
//                  step with no tool_use AND non-empty text → yes
//
// `toolUses === []` AND `text === ''` collapses to no — there's
// nothing to critique (a step that produced literally no output is
// itself a degenerate condition the harness handles elsewhere).
//
// Tools the registry doesn't recognize count as NOT read-only — a
// completely unknown name might be writes-equivalent and we'd rather
// false-positive a critique than skip one for a real write.
export const shouldCritique = (
  config: CritiqueConfig,
  toolUses: readonly CollectedToolUse[],
  assistantText: string,
  toolRegistry: ToolRegistry,
): boolean => {
  if (config.mode === 'off') return false;
  const hasText = assistantText.trim().length > 0;
  if (toolUses.length === 0) return hasText;

  let hasWrites = false;
  let hasNonReadOnly = false;
  for (const tu of toolUses) {
    const tool = toolRegistry.get(tu.name);
    const writes = tool?.metadata.writes === true;
    if (writes) {
      hasWrites = true;
      hasNonReadOnly = true;
    }
    // Unknown tool name: be safe in `always` mode and treat it as
    // non-read-only. `on_writes` still requires a registered
    // writes:true tool to fire (an unknown tool never proves
    // writes-intent), matching the checkpoint code's convention
    // at loop.ts:1674 where unknown tools are not snapshotted.
    if (tool === null) hasNonReadOnly = true;
  }

  if (config.mode === 'on_writes') return hasWrites;
  // `always`: critique unless every tool_use is a known read-only.
  return hasNonReadOnly;
};

// Map collected tool_uses into the CritiqueInput's toolPlan shape.
// Each entry carries the tool's `writes` flag so the critic can
// frame its review correctly (a tool plan with mutations gets
// stricter scrutiny than a plan with reads only). Returns undefined
// when there are no tool_uses — the engine treats undefined as
// "no plan to review".
export const buildCritiqueToolPlan = (
  toolUses: readonly CollectedToolUse[],
  toolRegistry: ToolRegistry,
): CritiqueToolPlanEntry[] | undefined => {
  if (toolUses.length === 0) return undefined;
  return toolUses.map((tu) => ({
    name: tu.name,
    input: tu.input,
    writes: toolRegistry.get(tu.name)?.metadata.writes === true,
  }));
};

// Build the CritiqueInput payload for one step. The userPrompt is
// the operator's original prompt for the run (the goal). For
// multi-step runs the goal stays the same across steps; subsequent
// turns don't have new user prompts unless the operator types
// again.
export const buildCritiqueInput = (
  userPrompt: string,
  systemPrompt: string | undefined,
  assistantText: string,
  toolPlan: CritiqueToolPlanEntry[] | undefined,
): CritiqueInput => ({
  userPrompt,
  ...(systemPrompt !== undefined ? { executorSystemPrompt: systemPrompt } : {}),
  assistantText,
  ...(toolPlan !== undefined ? { toolPlan } : {}),
});

// Render the synthetic user message the harness pushes onto the
// messages array when the operator chooses `redo`. The model sees
// this as the next turn's user content — its job is to address the
// issues in its next attempt.
//
// Format chosen for readability AND token economy: severity tag in
// brackets, confidence to two decimals, description as the body,
// optional suggestion under an arrow. No JSON wrapping — the model
// reads this as instruction, not as data to parse.
export const renderCritiqueHint = (issues: readonly CritiqueIssue[]): string => {
  const lines: string[] = [
    'The previous attempt was reviewed by a critic and flagged the following issues. Address them in this attempt before proceeding.',
  ];
  for (const issue of issues) {
    lines.push('');
    lines.push(
      `[${issue.severity}] (confidence ${issue.confidence.toFixed(2)}) ${issue.description}`,
    );
    if (issue.suggestion.length > 0) {
      lines.push(`  → suggestion: ${issue.suggestion}`);
    }
  }
  return lines.join('\n');
};

// True iff the toolPlan contains at least one `writes:true` entry.
// The harness passes this through to confirmCritique so the modal
// renders the right framing (a writes-step critique deserves a
// stronger warning than an end-of-step text critique).
export const toolPlanHasWrites = (plan: CritiqueToolPlanEntry[] | undefined): boolean => {
  if (plan === undefined) return false;
  for (const entry of plan) {
    if (entry.writes) return true;
  }
  return false;
};
