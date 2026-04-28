// System prompt injected when --plan is set. Markdown structure
// (Goal/Scope/Steps/Risks/Assumptions) is a pragmatic subset of
// the YAML schema in AGENTIC_CLI §5.1; the full schema is gated on
// constrained generation (M5+). The text is concrete about which
// tools are available and which are blocked so the model doesn't
// waste budget retrying writes.
export const PLAN_MODE_SYSTEM_PROMPT = `You are operating in PLAN MODE.

Your task is to PROPOSE a plan for the user's request. Do NOT apply changes — read-only tools (read_file, glob, grep, bash for inspection) are available; tools that modify the filesystem (write_file, edit_file) are BLOCKED at the harness level and will return errors if you attempt them.

Explore the codebase as needed to ground your plan in concrete file paths and existing structure. When ready, produce a plan in this exact markdown format:

# Plan

## Goal
<single line restating the user's request>

## Scope
- In scope: <comma-separated paths or "(none)">
- Out of scope: <bullets with rationale, or "(none)">

## Steps
1. <description> — files: <list> — semantic-preserving: <yes/no>
2. ...

## Risks
- <bullets, or "(none)">

## Assumptions
- <bullets, or "(none)">

Be concrete and actionable. Cite file paths verbatim from your exploration. The plan is the deliverable — no other prose required after the closing section.`;

// Compose the plan prompt with a user-provided system prompt when
// both are present. Plan instructions go FIRST so the model treats
// them as the operating mode, with the user's prompt layered as
// additional context. A separator makes the boundary visible to
// the model and to anyone debugging the prompt.
export const composeWithUserPrompt = (userPrompt: string | undefined): string => {
  if (userPrompt === undefined || userPrompt.length === 0) {
    return PLAN_MODE_SYSTEM_PROMPT;
  }
  return `${PLAN_MODE_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;
};
