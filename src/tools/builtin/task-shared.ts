// Shared output-reduction helpers for the subagent collection tools
// (`task` / `task_sync` and `task_async` + `task_await`). Both
// surfaces return the child's terminal text as `output` and echo a
// raw `output` inside the error envelope's `details`; that text
// re-enters the parent context as a tool_result and is re-sent every
// subsequent turn (the dominant write-cost axis). The helpers here
// head-tail that field so the two surfaces stay byte-identical in
// policy — a fix applied to one but not the other would let the
// async path leak exactly what the sync path now caps
// (OUTPUT_POLICY §6 exception).

import { HEAD_TAIL_DEFAULT_LINES, headTailSummary } from '../output-summarizer.ts';
import type { SummarizedOutput } from '../types.ts';

// Byte threshold above which the child's terminal `output` is
// head-tailed before the parent sees it. Asymmetric counterpart to
// the per-tool prompt cap: the prompt INTO the child is capped by
// rejection (the work hasn't run yet), but the output BACK is capped
// by reduction (the work already ran — we can't reject it, only trim
// what re-enters the parent's context every subsequent turn).
//
// 16 KB matches bash's threshold (OUTPUT_POLICY §3.1): a child's
// conclusion that crosses 16 KB is carrying detail the parent
// re-pays for on every turn, while the full text stays recoverable
// via the audit row (`session_id`). 80 + 80 lines (HEAD_TAIL_DEFAULT)
// keeps the opening framing and the closing verdict — the two ends a
// subagent report concentrates signal in.
export const OUTPUT_SUMMARIZE_THRESHOLD = 16 * 1024;

// Head-tail a child's terminal output string. Used both by the
// `metadata.summarize` success path (via `summarizeChildEnvelope`)
// and by the error path's inline trim at each tool's call site (the
// harness routes ToolError around `summarize`, OUTPUT_POLICY §0.4).
export const childOutputHeadTail = (output: string) =>
  headTailSummary(output, {
    maxBytes: OUTPUT_SUMMARIZE_THRESHOLD,
    headLines: HEAD_TAIL_DEFAULT_LINES,
    tailLines: HEAD_TAIL_DEFAULT_LINES,
  });

// `metadata.summarize` for the subagent success envelope. The harness
// calls this AFTER persisting the raw envelope to `tool_calls.output`
// (OUTPUT_POLICY §0.1, §2), so the audit keeps the child's full text;
// only the model-facing copy is reduced, with the harness prepending
// the `[forja:output_summarized policy=head_tail …]` marker. Every
// scalar field (session_id, status, cost, steps, …) is load-bearing
// and tiny — only `output` is head-tailed.
//
// Generic over the envelope shape: `TaskOutput` and `TaskAwaitOutput`
// both carry `output: string`, so one summarizer serves both. The
// reduced result is a COPY (spread) — the function never mutates the
// raw object the harness already persisted.
//
// Contract: invoked only on success results. The status≠done path
// returns a ToolError, which the harness routes around `summarize`
// (§0.4) — that path trims `details.output` inline via
// `childOutputHeadTail` at the call site.
export const summarizeChildEnvelope = (result: unknown): SummarizedOutput => {
  const out = result as Record<string, unknown>;
  const output = out.output;
  if (typeof output !== 'string' || output.length === 0) {
    return { result, reduced: false, originalBytes: 0, policy: 'noop' };
  }
  const summary = childOutputHeadTail(output);
  if (!summary.reduced) {
    return { result, reduced: false, originalBytes: summary.originalBytes, policy: 'noop' };
  }
  return {
    result: { ...out, output: summary.text },
    reduced: true,
    originalBytes: summary.originalBytes,
    policy: 'head_tail',
  };
};
