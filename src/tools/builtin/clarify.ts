import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// clarify — ask the operator instead of presuming (CONTRACTS §2.6.5e,
// STATE_MACHINE §12). The anti-presumption tool: when the model hits a
// load-bearing interpretive ambiguity, it emits clarify(...) with a
// question + options for the operator to pick, rather than silently
// guessing. The behavioral arm of the root premise — measure (ask)
// before you cut (act).
//
// Design intent: `clarify` is a CORE tool, always exposed alongside
// read/write/edit — never gated by a playbook. It renders as a confirm-
// modal flavor (`flavor:'clarify'`, one question + options); the REPL
// wires `ctx.clarify` to the ModalManager. Multiple pending clarifies
// stack in the FIFO queue.
//
// EVERY call asks the operator. There is no severity level the model
// self-classifies — a `blast_radius` the model could mis-set, silently
// auto-assuming when it should have asked. If the model doesn't want to
// interrupt (a low-stakes choice), it simply doesn't call clarify and
// records the assumption itself. Calling clarify == wanting an answer.
//
// Without the modal bridge (headless one-shot, subagent with no IPC
// confirm pipe), it returns `clarify.modal_unavailable` — the same
// fail-clean shape memory_write uses for its missing confirm callback.
//
// Deferred to a later slice: audit (clarification_events, §12.4) and
// the per-session budget (clarify.budget_exceeded, §2.6.5e) — they
// need a storage table / session counter not wired yet.

export interface ClarifyOption {
  id: string;
  label: string;
}

export interface ClarifyInput {
  question: string;
  options: ClarifyOption[];
  why_it_matters?: string;
}

export type ClarifyOutcome = 'resolved' | 'skipped' | 'escalated';

export interface ClarifyOutput {
  // resolved — operator picked an option (chosen_option_id set).
  // skipped — operator skipped / modal timed out; proceed with the
  //   auto-assumed default (chosen_option_id = options[0]).
  // escalated — operator signaled the GOAL is wrong, not just
  //   ambiguous (user_text carries the reason); caller re-grounds.
  outcome: ClarifyOutcome;
  chosen_option_id?: string;
  user_text?: string;
  // One-line display detail for the finished tool card (TUI). The
  // generic `result_detail` convention the harness plumbs to
  // `tool_finished` (invoke-tool's readResultDetail → tool:end summary),
  // so the scrollback chip reads `Called clarify  └─ <question> →
  // <answer>` instead of a bare verb. Also informative to the model: it
  // pairs the question with the resolved label in one field.
  result_detail?: string;
}

export const clarifyTool: Tool<ClarifyInput, ClarifyOutput> = {
  name: 'clarify',
  description:
    'Ask the operator a question instead of presuming when you hit a load-bearing ambiguity (which file, which behavior, which of two readings of the request). Provide >=2 options for them to pick; the operator picks one, or skips (then you proceed with the FIRST option). EVERY call opens a prompt and waits — so use it only for ambiguity that is expensive to get wrong. For a low-stakes choice, do NOT call this: pick a sensible default and note the assumption. Never use it for trivia the operator would find noisy.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The single, specific question. One decision per call.',
      },
      options: {
        type: 'array',
        description:
          'At least 2 distinct choices, each with a short stable `id` and a human `label`. The operator picks one; on skip/timeout the FIRST option is the assumed default, so order it as the safest assumption.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable short id, unique within this call.' },
            label: { type: 'string', description: 'Human-readable choice.' },
          },
          required: ['id', 'label'],
        },
      },
      why_it_matters: {
        type: 'string',
        description:
          'Optional one-line stakes: what diverges between the options (cost, blast radius, deadline). Shown to the operator.',
      },
    },
    required: ['question', 'options'],
  },
  metadata: {
    category: 'misc',
    // Pure human consultation — no filesystem / network / process
    // side effects (CONTRACTS §2.6.5e "Side effects: nenhum").
    writes: false,
    // Awaits the operator via the modal bridge. Headless and subagent
    // contexts have no such surface, so the tool can't run there — same
    // posture as memory_write. The subagent validator rejects whitelists
    // that include it.
    requiresOperatorConfirm: true,
    // Same (question, options) recreates the same modal (§2.6.5e).
    idempotent: true,
    display: 'raw',
    // Bound by the 60s modal timeout, but the cost is operator
    // wall-clock, not compute.
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<ClarifyOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before clarify', { retryable: true });
    }

    const invalid = validateInputs(args);
    if (invalid !== null) return invalid;

    // validateInputs guarantees >= 2 well-formed options; pin the
    // default (first option — the skip/timeout assumption) once. The
    // guard is unreachable after validation but narrows the indexed
    // access for the type checker (noUncheckedIndexedAccess).
    const defaultOptionId = args.options[0]?.id;
    if (defaultOptionId === undefined) {
      return toolError('clarify.options_invalid', 'options must contain at least one valid choice');
    }

    // Every clarify asks the operator — route to the modal bridge.
    const bridge = ctx.clarify;
    if (bridge === undefined) {
      return toolError(
        'clarify.modal_unavailable',
        'clarify needs an interactive operator surface, but none is attached',
        {
          hint: 'Runs in an interactive REPL. In headless / subagent contexts, proceed and record the choice in assumptions[] instead.',
        },
      );
    }

    const resolution = await bridge({
      question: args.question,
      options: args.options,
      ...(args.why_it_matters !== undefined ? { why_it_matters: args.why_it_matters } : {}),
      // Forward the run's abort signal so a wall-clock / producer abort
      // closes the modal immediately instead of stranding it until the
      // operator answers or the 60s timeout fires.
      signal: ctx.signal,
    });

    // Display line for the finished card: pair the question with the
    // resolved answer (`→` reads as "answered with"). Built here because
    // this is the only point with the question, the option labels, and
    // the chosen id together; invoke-tool sanitizes + caps it downstream.
    const labelFor = (id: string): string => args.options.find((o) => o.id === id)?.label ?? id;
    // Cap each side independently so the assembled line stays under
    // invoke-tool's 200-char display cap WITH the answer intact: capping
    // the whole line downstream would truncate the tail — the answer, the
    // part that matters most — whenever the question runs long.
    const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const detailLine = (answer: string): string =>
      `${cap(args.question, 120)} → ${cap(answer, 70)}`;

    // skipped → proceed with the assumed default so the model has a
    // concrete choice to act on (§12.3 60s-timeout default =
    // skip-and-proceed-with-options[0]).
    if (resolution.outcome === 'skipped') {
      const chosen = resolution.chosen_option_id ?? defaultOptionId;
      return {
        outcome: 'skipped',
        chosen_option_id: chosen,
        result_detail: detailLine(`${labelFor(chosen)} (default)`),
      };
    }
    return {
      outcome: resolution.outcome,
      ...(resolution.chosen_option_id !== undefined
        ? { chosen_option_id: resolution.chosen_option_id }
        : {}),
      ...(resolution.user_text !== undefined ? { user_text: resolution.user_text } : {}),
      result_detail:
        resolution.outcome === 'escalated'
          ? detailLine(
              resolution.user_text !== undefined
                ? `re-grounded: ${resolution.user_text}`
                : 're-grounded',
            )
          : detailLine(
              resolution.chosen_option_id !== undefined
                ? labelFor(resolution.chosen_option_id)
                : 'resolved',
            ),
    };
  },
};

// Validation mirrors the failure modes CONTRACTS §2.6.5e enumerates:
// options.invalid (< 2 or duplicate ids) is its own code; the rest are
// shape errors surfaced as invalid_arg. budget_exceeded is a later
// slice (needs a per-session counter).
const validateInputs = (args: ClarifyInput): ToolResult<ClarifyOutput> | null => {
  if (typeof args.question !== 'string' || args.question.length === 0) {
    return toolError(ERROR_CODES.invalidArg, 'question must be a non-empty string');
  }
  if (args.why_it_matters !== undefined && typeof args.why_it_matters !== 'string') {
    return toolError(ERROR_CODES.invalidArg, 'why_it_matters must be a string when provided');
  }
  if (!Array.isArray(args.options) || args.options.length < 2) {
    return toolError('clarify.options_invalid', 'options must be an array of at least 2 choices', {
      hint: 'Give the operator >=2 distinct options to pick from.',
    });
  }
  const seen = new Set<string>();
  for (const opt of args.options) {
    if (
      opt === null ||
      typeof opt !== 'object' ||
      typeof opt.id !== 'string' ||
      opt.id.length === 0 ||
      typeof opt.label !== 'string' ||
      opt.label.length === 0
    ) {
      return toolError(
        'clarify.options_invalid',
        'each option must be an object with non-empty string `id` and `label`',
      );
    }
    if (seen.has(opt.id)) {
      return toolError(
        'clarify.options_invalid',
        `duplicate option id ${JSON.stringify(opt.id)}; ids must be unique within a call`,
      );
    }
    seen.add(opt.id);
  }
  return null;
};
