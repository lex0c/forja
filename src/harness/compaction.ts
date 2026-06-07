import { computeCost, emptyUsage } from '../providers/cost.ts';
import type {
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  UsageInfo,
} from '../providers/index.ts';
import { stripAnsi } from '../sanitize/index.ts';
import type { DB } from '../storage/db.ts';
import {
  type AppendCompactionEventInput,
  appendCompactionEvent,
} from '../storage/repos/compaction-events.ts';
import { hashPromptContent } from '../storage/repos/prompt-versions.ts';
import { abortableIterable } from './abortable.ts';
import { CollectStepError, collectStep } from './collect.ts';

// Compaction shrinks the in-memory conversation history when the
// provider's prompt is approaching its context window. AGENTIC_CLI §6
// and ORCHESTRATION.md §4 spec the policy:
//
//   - Trigger at 70% of context_window (see the harness loop for the
//     check; this module just executes when called).
//   - Preserve the first user message (goal) literal and the last K
//     turns literal; summarize everything in between.
//   - LLM call is the canonical path; deterministic fallback when
//     the LLM call fails so a compaction failure never aborts a run.
//
// Scope intentionally trimmed for M2 Step 3:
//   - No PreCompact hook (hooks subsystem is M4).
//   - Active pins ARE preserved: the caller reads them from the store and
//     passes a pre-formatted block (options.pinnedBlock) that is inserted
//     literally into the [compacted_history] block. The deterministic
//     fallback keeps whatever prior block the goal carried but does not
//     refresh it (degraded path; pins reappear on the next LLM compaction
//     or on resume).
//   - No DB persistence of the synthetic summary message — replay
//     re-reads the original messages from `messages` table and can
//     re-compact if needed. Audit captures the event via the
//     harness's onEvent callback only.
//   - Single provider for the summary call (same provider as the
//     run); cheaper-model selection per profile is M3+.
//   - Fallback drops tool_result bodies; advanced ranking (writes,
//     decision references) is deferred.

export interface CompactionOptions {
  // Number of trailing turns preserved literally. ORCHESTRATION §4.6
  // recommends K=3; configurable so tests can exercise smaller
  // histories without staging an artificial 10-turn fixture.
  preserveTail: number;
  // Cap on the summary's `max_tokens`. Default 1024 — long enough to
  // capture goal + decisions + files + errors + pending, short enough
  // that the call doesn't burn through what compaction is trying to
  // free up.
  maxTokens?: number;
  // Forwarded to the provider so a wall-clock timeout or user abort
  // interrupts the summary call mid-stream.
  signal?: AbortSignal;
  // Pre-formatted block of active pins (CONTEXT_TUNING §12.4) the caller
  // read from the store. Inserted LITERALLY inside the [compacted_history]
  // block (never sent to the summary LLM), so pinned constraints survive
  // compaction instead of being elided with the middle. Undefined ⇒ no
  // active pins. Living inside the markers means the NEXT compaction
  // strips it as a unit with the summary — no unbounded growth.
  pinnedBlock?: string;
}

// Single source for the strategy names — the runtime array drives the
// eval loader's allowlist (`evals/loader.ts`, mirroring its VALID_EXIT_REASONS
// pattern) and the type is derived from it, so adding a strategy here
// can't leave a hand-rolled mirror silently rejecting it.
export const COMPACTION_STRATEGIES = ['llm', 'fallback', 'skipped', 'relevance'] as const;
export type CompactionStrategy = (typeof COMPACTION_STRATEGIES)[number];

export interface CompactionResult {
  messages: ProviderMessage[];
  strategy: CompactionStrategy;
  // Number of original messages folded into the summary (counts the
  // middle slice that got replaced; excludes preserved goal + tail).
  foldedCount: number;
  // Token usage for the compaction LLM call itself. Zero when
  // strategy='skipped' (no call was made). On 'fallback' it carries
  // whatever partial usage the failed call reported before throwing
  // (some providers emit usage events even on stream errors). The
  // caller MUST fold this into session totals — a compaction call is
  // a billed provider request and ignoring it underreports spend.
  usage: UsageInfo;
  // Whether the compaction call's stream reported usage telemetry.
  // False on skipped (no call) and on fallback paths where usage
  // never arrived. The caller should downgrade `usageComplete` when
  // an LLM-or-fallback strategy reports false, mirroring the
  // per-turn logic in the harness loop.
  usageSeen: boolean;
  // Optional reason when strategy='fallback' or 'skipped' — surfaces
  // through the harness event for observability.
  reason?: string;
  // The LLM summary text on the `llm` strategy (the non-deterministic content
  // folded into the goal). Persisted to `compaction_events` for replay/audit —
  // it is otherwise LOST (resume re-derives from the log and re-compacts → a
  // different summary). Undefined on fallback / skipped / relevance.
  summary?: string;
}

// The accounting consequences of folding a CompactionResult: what the
// (billed) compaction call cost, and whether it leaves the session's usage a
// lower bound. BOTH surfaces that fold a result must apply BOTH fields — the
// loop's maybeCompact (in-memory run totals → completeSession) and operator
// /compact (direct session-row writes). Decided here once because
// hand-reimplementing it is exactly what drifted: /compact recomputed cost
// but dropped the usageIncomplete half, leaving sessions marked complete over
// a lower-bound spend. Destinations still differ (in-memory vs row); only the
// DECISION is shared, so a caller can't silently disagree on it again.
export interface CompactionAccounting {
  costUsd: number;
  usageIncomplete: boolean;
}
export const accountCompaction = (
  result: CompactionResult,
  capabilities: Provider['capabilities'],
): CompactionAccounting => ({
  costUsd: computeCost(capabilities, result.usage),
  usageIncomplete: result.strategy !== 'skipped' && !result.usageSeen,
});

const SUMMARY_MARKER_OPEN = '[compacted_history]';
const SUMMARY_MARKER_CLOSE = '[/compacted_history]';

// Structured compaction prompt. The shape matters: the next agent
// turn reads this block in place of the folded messages, so any
// fact NOT preserved here gets re-investigated (extra grep / read /
// test calls). The prompt nudges the model toward concrete
// pointers (file:line, exact error strings) over narrative prose,
// and adds two sections — ANCHORS and REJECTED — that target the
// dominant re-investigation costs in long sessions:
//
//   - ANCHORS: code facts the agent had to use tools to find
//     (symbol locations, struct shapes, framework idioms in this
//     codebase). Without these, the next turn re-runs the same
//     grep / read sequence to relearn what the prior turn already
//     paid for.
//   - REJECTED: approaches that were tried and dismissed, with a
//     one-line reason. Without these, the next turn can rediscover
//     the same dead end and burn cost on a path the prior turn
//     already proved unviable.
//
// FILES_TOUCHED stays as-is rather than splitting into read/wrote;
// the split is nice-to-have but FILES_TOUCHED is already
// structurally adequate and the section count hits a usability
// floor where adding more granularity costs more attention than
// it saves.
const COMPACTION_SYSTEM_PROMPT = `You are summarizing a long conversation between a user and an autonomous coding agent. Your output replaces the middle turns of the transcript so the model can continue without losing critical context. The next agent turn reads this block in place of those messages — anything not preserved here will be re-investigated next turn (extra grep / read / test calls), so prefer concrete pointers (file:line, symbol names, exact error strings) over prose. Every word costs tokens the agent could use to keep working.

Preserve facts exactly as established — copy names, paths, line numbers, and error strings verbatim from the transcript; do not rewrite, generalize, or infer beyond what was stated. When unsure whether a detail matters, keep it: a dropped fact costs a full re-investigation next turn, a kept one costs a few tokens.

Output ONLY the following structured block, nothing else:

${SUMMARY_MARKER_OPEN}
GOAL: <single line restating the user's original request>
DECISIONS: <bullet list of concrete decisions taken with a brief rationale each; empty list if none>
ANCHORS: <bullet list of code facts found via tools that the next turn should NOT re-discover; format \`path/file.ts:line — what\`; empty if none>
REJECTED: <bullet list of approaches tried and dismissed; format \`<approach> — <why>\`; empty if none>
FILES_TOUCHED: <comma-separated list of paths read/written; empty if none>
ERRORS: <bullet list of errors hit and whether resolved>
PENDING: <bullet list of remaining sub-tasks>
${SUMMARY_MARKER_CLOSE}

Skip any section whose content would be empty by writing "(none)" after the colon. Do not editorialize, apologize, or add prose outside the markers.`;

// Spec ORCHESTRATION §4.6 step 6: when dropping tool_result bodies
// alone isn't enough (text-heavy histories with few/no tool calls),
// also truncate long text content head+tail with a size pointer.
// Without this tier, fallback on a chatty session leaves the history
// essentially the same size and the next provider call still hits
// the context cap. Threshold + slice sizes match the spec's
// "preserve first 200 chars + last 200 chars" recommendation.
const TRUNCATE_THRESHOLD = 800;
const TRUNCATE_HEAD = 200;
const TRUNCATE_TAIL = 200;

const truncateLongText = (s: string): string => {
  if (s.length <= TRUNCATE_THRESHOLD) return s;
  const head = s.slice(0, TRUNCATE_HEAD);
  const tail = s.slice(-TRUNCATE_TAIL);
  const elided = s.length - TRUNCATE_HEAD - TRUNCATE_TAIL;
  return `${head}\n[... ${elided} chars elided — compaction fallback; recover via retrieve_context (session view) ...]\n${tail}`;
};

const fallbackElide = (block: ProviderContentBlock): ProviderContentBlock => {
  if (block.type === 'tool_result') {
    const sizeBytes = block.content.length;
    // Tool args/output get replaced with a pointer so the model
    // still sees that the call happened (and against which
    // tool_use_id) but not the body. is_error is preserved so the
    // model knows whether the call succeeded.
    return {
      ...block,
      content: `[tool_result elided: ${sizeBytes} bytes — compaction fallback; recover via retrieve_context (session view)]`,
    };
  }
  if (block.type === 'text') {
    // Long assistant text (model produced a wall of explanation
    // before invoking tools, or never invoked tools at all): head+
    // tail truncate. Short text stays intact.
    return { ...block, text: truncateLongText(block.text) };
  }
  // tool_use: args are usually small and reference IDs the next
  // turn might still cite. Preserve fidelity.
  return block;
};

const fallbackCompact = (middle: ProviderMessage[]): ProviderMessage[] =>
  middle.map((m) => {
    if (typeof m.content === 'string') {
      // String-content messages (text-only chat with no blocks) get
      // the same truncate treatment so a chatty history doesn't
      // sail through fallback unchanged.
      return { ...m, content: truncateLongText(m.content) };
    }
    return { ...m, content: m.content.map(fallbackElide) };
  });

const renderTranscriptForSummary = (middle: ProviderMessage[]): string => {
  const lines: string[] = [];
  for (const m of middle) {
    if (typeof m.content === 'string') {
      lines.push(`<${m.role}>\n${m.content}\n</${m.role}>`);
      continue;
    }
    const parts: string[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'tool_use') {
        parts.push(`[tool_use ${block.name}](${JSON.stringify(block.input)})`);
      } else {
        parts.push(
          `[tool_result ${block.name ?? '?'} is_error=${block.is_error ?? false}]\n${block.content}`,
        );
      }
    }
    lines.push(`<${m.role}>\n${parts.join('\n')}\n</${m.role}>`);
  }
  return lines.join('\n\n');
};

interface SummaryAttempt {
  text: string;
  usage: UsageInfo;
  usageSeen: boolean;
  // Stream-level errors (malformed JSON args from a thinking model,
  // etc). Non-empty list signals the caller should fall back, but we
  // still hand back any usage that arrived on the way.
  errors: { code: string; message: string }[];
}

const callSummaryProvider = async (
  provider: Provider,
  goal: ProviderMessage,
  middle: ProviderMessage[],
  options: CompactionOptions,
): Promise<SummaryAttempt> => {
  const transcript = renderTranscriptForSummary(middle);

  const req: GenerateRequest = {
    model: provider.id,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `ORIGINAL GOAL (preserve literally in summary):\n${goalText(goal)}\n\nTRANSCRIPT TO SUMMARIZE:\n${transcript}`,
      },
    ],
    max_tokens: options.maxTokens ?? 1024,
    temperature: 0,
  };

  // Stream the response and collect. signal forwards the harness's
  // combined abort signal so Ctrl+C or wall-clock timeout
  // interrupts the summary call. A `provider.generate` throw
  // propagates — caller treats that as zero-usage fallback.
  const stream =
    options.signal !== undefined
      ? abortableIterable(provider.generate(req), options.signal)
      : provider.generate(req);
  const collected = await collectStep(stream);
  return {
    text: collected.text,
    usage: collected.usage,
    usageSeen: collected.usageSeen,
    errors: collected.errors.map((e) => ({ code: e.code, message: e.message })),
  };
};

// Strip any prior `[compacted_history]...[/compacted_history]` block(s)
// from a string. Cumulative compactions previously appended a new
// summary on top of every prior wrap, growing the goal monotonically:
// after compaction N the wrapped goal contained N summaries. Each new
// compaction's LLM call would also see all prior summaries inside the
// "ORIGINAL GOAL" the LLM was told to preserve literally — they got
// re-quoted in the new summary, snowballing further. Stripping resets
// to "original goal + LATEST summary", which is what subsequent
// compactions actually need.
//
// Non-greedy match across newlines so multiple consecutive blocks are
// each removed independently. A goal that legitimately contained the
// markers (extreme edge case) would be partially corrupted; we accept
// that to avoid the unbounded-growth bug in practice.
const SUMMARY_BLOCK_RE = /\n*\[compacted_history\][\s\S]*?\[\/compacted_history\]\n*/g;
const stripPriorSummary = (text: string): string => text.replace(SUMMARY_BLOCK_RE, '').trim();

// Extract plain text from a goal message regardless of whether the
// content was set as a string or as a list of blocks, then strip any
// prior summary block. The harness always uses string content for the
// initial user prompt, but compaction may rewrite messages[0] into a
// wrapped goal that already carries a summary; subsequent compactions
// must see the ORIGINAL goal, not the prior summary.
export const goalText = (goal: ProviderMessage): string => {
  const raw =
    typeof goal.content === 'string'
      ? goal.content
      : goal.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  return stripPriorSummary(raw);
};

// Merge the LLM-produced summary INTO the goal message rather than
// emitting a separate synthetic message. Two reasons:
//   1. Tool-pair integrity — the tail must start with the assistant
//      message that emitted the tool_use referenced by following
//      user_tool_result blocks. If we inserted a separate summary
//      message and forced the tail to start with `user`, that user
//      tool_result would be orphaned (its matching tool_use was in
//      the middle, now folded into the summary), and providers
//      reject orphaned tool_result blocks with 400.
//   2. Alternation — Anthropic rejects consecutive same-role
//      messages. With tail starting at `assistant` we'd need the
//      preceding message to be `user`. Merging into the goal keeps
//      `[user_goal+summary, assistant_first_tail, ...]` as a clean
//      user→assistant→user→... sequence.
const wrapGoalWithSummary = (
  goal: ProviderMessage,
  summary: string,
  pinnedBlock?: string,
): ProviderMessage => {
  // Strip ANSI from the LLM-produced summary before it lands in the
  // model's context (and the audit log via the provider response
  // path). Compaction calls go through our trusted provider, but a
  // hijacked or buggy proxy could inject control bytes; the
  // sanitization layer is the canonical defense and applying it
  // here keeps the invariant from §SECURITY_GUIDELINE §5/4
  // consistent across compaction paths.
  const trimmed = stripAnsi(summary).trim();
  // Defensive: model may forget one or both markers, or pad text
  // around them. We accept anywhere-in-the-string occurrences and
  // only re-wrap when at least one marker is missing entirely.
  const hasMarkers =
    trimmed.includes(SUMMARY_MARKER_OPEN) && trimmed.includes(SUMMARY_MARKER_CLOSE);
  const body = hasMarkers ? trimmed : `${SUMMARY_MARKER_OPEN}\n${trimmed}\n${SUMMARY_MARKER_CLOSE}`;
  // Active pins go INSIDE the block, before the close marker: preserved
  // literally (never summarized), yet stripped as a unit by goalText on the
  // next compaction, so they don't accumulate.
  let withPins = body;
  if (pinnedBlock !== undefined) {
    // Neutralize our own markers in the (model- or untrusted-content-
    // authored) pin text: a pin containing `[/compacted_history]` would
    // prematurely close the block and break stripPriorSummary's OPEN..CLOSE
    // match on the next compaction (corruption + unbounded accumulation).
    const safePins = pinnedBlock
      .replaceAll(SUMMARY_MARKER_OPEN, '(compacted_history)')
      .replaceAll(SUMMARY_MARKER_CLOSE, '(/compacted_history)');
    // Insert before the LAST close marker via slice — NOT String.replace,
    // whose string form interprets $&/$`/$'/$$ in the pin text (a pin with
    // "$&" would inject the matched marker; "$`" would delete the summary).
    // Last (not first) so a stray marker the summary LLM emitted mid-text
    // doesn't misplace the pins.
    const close = body.lastIndexOf(SUMMARY_MARKER_CLOSE);
    withPins = close >= 0 ? `${body.slice(0, close)}\n${safePins}\n${body.slice(close)}` : body;
  }
  // goalText already strips any prior summary block, so this never
  // accumulates: the wrap is always [original_goal]\n\n[latest summary(+pins)].
  return { role: 'user', content: `${goalText(goal)}\n\n${withPins}` };
};

// The token count at which compaction fires: a fraction of the provider
// context window (CONTEXT_TUNING §12). One source for the loop's trigger
// check, the `/compact` command, and the relevance verbatim-budget
// derivation below — so the trigger definition can't drift between
// callers (e.g. if it ever gains a clamp or per-provider floor).
export const compactionTriggerTokens = (threshold: number, contextWindow: number): number =>
  threshold * contextWindow;

// Verbatim byte budget for the relevance pre-pass, derived from the
// compaction trigger (CONTEXT_TUNING §12) rather than a magic constant:
// keep up to ~30% of the threshold as verbatim tool_result bytes
// (~4 bytes/token is a coarse proxy). Shared by the loop's auto path and
// the `/compact` command so the heuristic the eval tunes lives in ONE
// place, not duplicated per caller.
export const relevanceVerbatimBudgetBytes = (triggerAtTokens: number): number =>
  Math.floor(triggerAtTokens * 0.3 * 4);

// Walk the tail boundary back to the nearest assistant message so the
// preserved tail starts at an assistant (keeps tool_use → tool_result
// pairs intact; providers reject orphaned tool_results). Returns the
// aligned tailStart, or null when no assistant sits between the goal and
// the requested tail (pathological history). Shared by compactMessages
// (the fold tail) and SessionContext.relevanceElide (the preserved tail)
// so both paths agree on what "the last K turns" means.
export const alignTailStartToAssistant = (
  messages: ProviderMessage[],
  safeTail: number,
): number | null => {
  let tailStart = messages.length - safeTail;
  while (tailStart > 1 && messages[tailStart]?.role !== 'assistant') {
    tailStart -= 1;
  }
  if (tailStart < 1 || messages[tailStart]?.role !== 'assistant') return null;
  return tailStart;
};

// sha256 of the live message array — the before/after context hash on a
// compaction_events row. One definition so every writer (loop + /compact)
// hashes the SAME serialization; a divergent stringify would silently make
// before/after non-comparable across paths (defeating the replay check).
export const hashContext = (messages: readonly ProviderMessage[]): string =>
  hashPromptContent(JSON.stringify(messages));

// Persist one compaction_events audit row (CONTEXT_TUNING §12 / AUDIT.md).
// Shared by the loop and `/compact` so the skip / hash / best-effort logic
// lives in ONE place (no per-caller drift):
//   - strategy 'skipped' ⇒ NO row — nothing happened (before === after); a
//     no-op event is pure noise in an un-GC'd table.
//   - afterHash is hashed from `messagesAfter` (the post-compaction array).
//   - best-effort, but OBSERVABLE: a persist failure (CHECK / NOT NULL /
//     binding drift) is logged to stderr, never silently swallowed — losing
//     the audit row silently is the failure this table exists to prevent.
export const recordCompactionEvent = (
  db: DB,
  input: Omit<AppendCompactionEventInput, 'afterHash'> & {
    messagesAfter: readonly ProviderMessage[];
  },
): void => {
  if (input.strategy === 'skipped') return;
  const { messagesAfter, ...row } = input;
  try {
    appendCompactionEvent(db, { ...row, afterHash: hashContext(messagesAfter) });
  } catch (err) {
    console.error(
      `forja: compaction_events persist failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export const compactMessages = async (
  provider: Provider,
  messages: ProviderMessage[],
  options: CompactionOptions,
): Promise<CompactionResult> => {
  // Clamp negative inputs and use length-relative slicing instead of
  // `slice(-tail)`. JS quirk: `[1,2,3].slice(-0)` returns the whole
  // array (since `-0 === 0` and `slice(0)` is the full array). With
  // `preserveTail=0` the original code would have produced a tail
  // overlapping the middle and double-counted every message.
  const safeTail = Math.max(0, options.preserveTail);

  // Need at least: goal + something-to-fold + tail. Anything shorter
  // means there's nothing meaningful to compact.
  if (messages.length < safeTail + 2) {
    return {
      messages,
      strategy: 'skipped',
      foldedCount: 0,
      usage: emptyUsage(),
      usageSeen: false,
      reason: `history shorter than goal+fold+tail (${messages.length} < ${safeTail + 2})`,
    };
  }

  const goal = messages[0];
  if (goal === undefined) {
    return {
      messages,
      strategy: 'skipped',
      foldedCount: 0,
      usage: emptyUsage(),
      usageSeen: false,
      reason: 'empty history',
    };
  }

  // Alignment invariant: the tail MUST start with an `assistant`
  // message so tool_use → tool_result pairs stay intact. The
  // harness loop produces [user_goal, assistant, user_tool_result,
  // assistant, user_tool_result, ...]; a user_tool_result in the
  // tail references a tool_use emitted by an assistant turn — if
  // that assistant ended up in the middle (folded into the summary
  // we're merging into the goal), the next provider call sees an
  // orphan tool_result and rejects with 400.
  //
  // Align the tail to an assistant boundary (shared helper): the summary
  // is merged into the goal (user-role), so [wrappedGoal_user,
  // tail_starts_with_assistant, ...] keeps clean user→assistant→user
  // alternation regardless of preserveTail parity. Over-preserving by one
  // position when the boundary lands on a user is the price of correctness.
  const tailStart = alignTailStartToAssistant(messages, safeTail);
  if (tailStart === null) {
    // Pathological history shape — no assistant message between the
    // goal and the requested tail. Refuse rather than emit a
    // malformed prompt.
    return {
      messages,
      strategy: 'skipped',
      foldedCount: 0,
      usage: emptyUsage(),
      usageSeen: false,
      reason: 'cannot align tail to assistant boundary',
    };
  }

  const middle = messages.slice(1, tailStart);
  if (middle.length === 0) {
    return {
      messages,
      strategy: 'skipped',
      foldedCount: 0,
      usage: emptyUsage(),
      usageSeen: false,
      reason: 'no middle messages to fold after tail alignment',
    };
  }
  const tailMessages = messages.slice(tailStart);

  // Track usage from the attempt — populated even on the fallback
  // path so callers can fold partial usage into session totals when
  // the stream errored AFTER reporting tokens.
  let attemptUsage: UsageInfo = emptyUsage();
  let attemptUsageSeen = false;

  // Try the LLM summary first.
  try {
    const attempt = await callSummaryProvider(provider, goal, middle, options);
    attemptUsage = attempt.usage;
    attemptUsageSeen = attempt.usageSeen;
    if (attempt.errors.length > 0) {
      const detail = attempt.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
      throw new Error(`compaction stream errored: ${detail}`);
    }
    // Reject an empty OR markers-only/whitespace summary. A length>0 gate
    // alone accepts "[compacted_history]\n[/compacted_history]" (a refusal
    // that emitted only the markers, or a degenerate response) as success and
    // drops the whole middle silently. Strip our markers + trim; if nothing
    // substantive remains, fall back to deterministic elision, which keeps the
    // middle as pointers instead of losing it.
    const summaryBody = stripAnsi(attempt.text)
      .replaceAll(SUMMARY_MARKER_OPEN, '')
      .replaceAll(SUMMARY_MARKER_CLOSE, '')
      .trim();
    if (summaryBody.length === 0) {
      throw new Error('compaction summary is empty or markers-only');
    }
    return {
      messages: [wrapGoalWithSummary(goal, attempt.text, options.pinnedBlock), ...tailMessages],
      strategy: 'llm',
      foldedCount: middle.length,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      summary: summaryBody,
    };
  } catch (e) {
    // If collectStep threw mid-iteration (CollectStepError), the
    // partial CollectedStep is on the error — including usage that
    // the adapter's `finally` block emitted before the stream
    // failed. Recover so compaction's billed tokens still flow into
    // session totals; without this, a failed compaction call gets
    // billed by the provider but reported as zero-usage fallback.
    if (e instanceof CollectStepError) {
      attemptUsage = e.partial.usage;
      attemptUsageSeen = e.partial.usageSeen;
    }
    // LLM path failed — apply deterministic elision so the run survives.
    // The original tool_result bodies stay in the SQLite audit log;
    // the model just sees pointers. Whatever usage we captured before
    // the throw still flows through so the caller can charge for
    // tokens the provider may already have billed.
    //
    // No synthetic note inserted between goal and middle: middle[0] is
    // always assistant (post-alignment, slice(1, tailStart) starts at
    // the first assistant turn). Wrapping the elided middle with an
    // assistant-role note would emit `[user_goal, assistant_note,
    // assistant_middle, ...]` — two consecutive assistants, which
    // OpenAI's chat API rejects with 400 and Anthropic warns against.
    // The strategy/reason/foldedCount info is already on the
    // `compaction_finished` event for observability; the model only
    // needs to see the pointers, which carry their own context.
    const reason = e instanceof Error ? e.message || e.name : String(e);
    const elided = fallbackCompact(middle);
    return {
      messages: [goal, ...elided, ...tailMessages],
      strategy: 'fallback',
      foldedCount: middle.length,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
      reason,
    };
  }
};
