import { emptyUsage } from '../providers/cost.ts';
import type {
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  UsageInfo,
} from '../providers/index.ts';
import { abortableIterable } from './abortable.ts';
import { collectStep } from './collect.ts';

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
//   - No pinned context (M3+).
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
}

export type CompactionStrategy = 'llm' | 'fallback' | 'skipped';

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
}

const SUMMARY_MARKER_OPEN = '[compacted_history]';
const SUMMARY_MARKER_CLOSE = '[/compacted_history]';

const COMPACTION_SYSTEM_PROMPT = `You are summarizing a long conversation between a user and an autonomous coding agent. Your output replaces the middle turns of the transcript so the model can continue without losing critical context. Be precise — every word costs tokens the agent could use to keep working.

Output ONLY the following structured block, nothing else:

${SUMMARY_MARKER_OPEN}
GOAL: <single line restating the user's original request>
DECISIONS: <bullet list of concrete decisions taken; empty list if none>
FILES_TOUCHED: <comma-separated list of paths read/written; empty if none>
ERRORS: <bullet list of errors hit and whether resolved>
PENDING: <bullet list of remaining sub-tasks>
${SUMMARY_MARKER_CLOSE}

Skip any section whose content would be empty by writing "(none)" after the colon. Do not editorialize, apologize, or add prose outside the markers.`;

const fallbackElide = (block: ProviderContentBlock): ProviderContentBlock => {
  if (block.type !== 'tool_result') return block;
  const sizeBytes = block.content.length;
  // Tool args/output get replaced with a pointer so the model still
  // sees that the call happened (and against which tool_use_id) but
  // not the body. is_error is preserved so the model knows whether
  // the call succeeded.
  return {
    ...block,
    content: `[tool_result elided: ${sizeBytes} bytes — compaction fallback, original in audit log]`,
  };
};

const fallbackCompact = (middle: ProviderMessage[]): ProviderMessage[] =>
  middle.map((m) => {
    if (typeof m.content === 'string') return m;
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
  const goalText =
    typeof goal.content === 'string'
      ? goal.content
      : goal.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

  const transcript = renderTranscriptForSummary(middle);

  const req: GenerateRequest = {
    model: provider.id,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `ORIGINAL GOAL (preserve literally in summary):\n${goalText}\n\nTRANSCRIPT TO SUMMARIZE:\n${transcript}`,
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

// Wrap the LLM-produced summary in a synthetic assistant message. Two
// consecutive user messages would also work (Anthropic accepts), but
// presenting the summary as the agent's own context note keeps the
// next turn's user/assistant alternation obvious to the model.
const wrapSummary = (summary: string): ProviderMessage => {
  const trimmed = summary.trim();
  // Defensive: model may forget one or both markers, or pad text
  // around them. We accept anywhere-in-the-string occurrences and
  // only re-wrap when at least one marker is missing entirely. A
  // strict start/end check would re-wrap perfectly-marked output
  // that has trailing whitespace or stray prose, producing nested
  // markers that confuse downstream scanners.
  const hasMarkers =
    trimmed.includes(SUMMARY_MARKER_OPEN) && trimmed.includes(SUMMARY_MARKER_CLOSE);
  const body = hasMarkers ? trimmed : `${SUMMARY_MARKER_OPEN}\n${trimmed}\n${SUMMARY_MARKER_CLOSE}`;
  return { role: 'assistant', content: body };
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

  // Alignment invariant: the inserted summary message has role
  // 'assistant'. Whatever follows it must be role 'user', otherwise
  // we ship a prompt with two consecutive assistant messages and
  // Anthropic's API rejects it with 400. The harness loop pushes
  // messages in [user, assistant, user, ...] alternation, so an
  // even `preserveTail` lands the slice on an assistant boundary.
  // Shift the slice one earlier (effectively `preserveTail+1`) when
  // that happens — over-preserving is honest, broken alternation is
  // a wire-level failure.
  let tailStart = messages.length - safeTail;
  if (safeTail > 0 && messages[tailStart]?.role === 'assistant') {
    if (tailStart <= 1) {
      // Can't expand without eating the goal slot. The history is
      // pathological (very short, off-alignment); refuse instead of
      // emitting a malformed prompt.
      return {
        messages,
        strategy: 'skipped',
        foldedCount: 0,
        usage: emptyUsage(),
        usageSeen: false,
        reason: 'cannot align tail without overlapping goal',
      };
    }
    tailStart -= 1;
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
    if (attempt.text.length === 0) {
      throw new Error('compaction produced empty summary');
    }
    return {
      messages: [goal, wrapSummary(attempt.text), ...tailMessages],
      strategy: 'llm',
      foldedCount: middle.length,
      usage: attemptUsage,
      usageSeen: attemptUsageSeen,
    };
  } catch (e) {
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
