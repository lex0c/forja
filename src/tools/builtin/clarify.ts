import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// clarify — ask the operator instead of presuming (CONTRACTS §2.6.5e,
// STATE_MACHINE §12). The anti-presumption tool: when the model hits a
// load-bearing interpretive ambiguity, it emits clarify(...) with a
// question + options for the operator to pick, rather than silently
// guessing. The behavioral arm of the root premise — measure (ask)
// before you cut (act).
//
// Design intent: `clarify` is a CORE tool, always exposed alongside
// read/write/edit — never gated by a playbook. The per-playbook
// `clarify_mode` modulates only the interruption behavior, never the
// availability. It renders as a confirm-modal flavor (`flavor:'clarify'`,
// one question + options); the REPL wires `ctx.clarify` to the
// ModalManager. Multiple pending clarifies stack in the FIFO queue.
//
// blast_radius routing (§12.1):
//   - low    — aesthetic / no real stakes. Auto-resolves to options[0]
//              WITHOUT a modal; returns outcome:auto_low. Never
//              interrupts the operator.
//   - medium — bufferable; needs the operator. Routes to the modal
//              bridge (ctx.clarify).
//   - high   — multi-file / external contract / irreversible. Routes
//              to the modal bridge for an immediate answer.
//
// Without the modal bridge (headless one-shot, subagent with no IPC
// confirm pipe), medium/high return `clarify.modal_unavailable` — the
// same fail-clean shape memory_write uses for its missing confirm
// callback. low still resolves, since it needs no operator.
//
// Deferred to a later slice: audit (clarification_events, §12.4) and
// the per-session budget (clarify.budget_exceeded, §2.6.5e) — they
// need a storage table / session counter not wired yet. This slice is
// the tool contract + validation + low auto-resolve + modal handoff.

export interface ClarifyOption {
  id: string;
  label: string;
}

export type BlastRadius = 'low' | 'medium' | 'high';

export interface ClarifyInput {
  question: string;
  options: ClarifyOption[];
  why_it_matters?: string;
  blast_radius: BlastRadius;
}

export type ClarifyOutcome = 'resolved' | 'skipped' | 'escalated' | 'auto_low';

export interface ClarifyOutput {
  // resolved — operator picked an option (chosen_option_id set).
  // skipped — operator skipped / modal timed out; proceed with the
  //   auto-assumed default (chosen_option_id = options[0]).
  // escalated — operator signaled the GOAL is wrong, not just
  //   ambiguous (user_text carries the reason); caller re-grounds.
  // auto_low — low blast radius auto-resolved without a modal.
  outcome: ClarifyOutcome;
  chosen_option_id?: string;
  user_text?: string;
}

const BLAST_RADII: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export const clarifyTool: Tool<ClarifyInput, ClarifyOutput> = {
  name: 'clarify',
  description:
    'Ask the operator a question instead of presuming when you hit a load-bearing ambiguity (which file, which behavior, which of two readings of the request). Provide >=2 options for them to pick. blast_radius: low = aesthetic / no real stakes (auto-resolved to the first option, no interruption — use sparingly); medium = affects one file / use-case; high = multiple files / external contract / irreversible (interrupts immediately). Prefer this over guessing on anything expensive to get wrong; do NOT use it for trivia the operator would find noisy.',
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
          'Optional one-line stakes: what diverges between the options (blast radius, cost, deadline). Shown to the operator.',
      },
      blast_radius: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'low = no real stakes, auto-resolved to options[0] with no modal; medium = needs the operator, bufferable; high = needs the operator, interrupts now.',
      },
    },
    required: ['question', 'options', 'blast_radius'],
  },
  metadata: {
    category: 'misc',
    // Pure human consultation — no filesystem / network / process
    // side effects (CONTRACTS §2.6.5e "Side effects: nenhum").
    writes: false,
    // medium/high await the operator via the modal bridge. Headless
    // and subagent contexts have no such surface, so the tool can't
    // run there — same posture as memory_write. The subagent
    // validator rejects whitelists that include it.
    requiresOperatorConfirm: true,
    // Same (question, options) recreates the same modal (§2.6.5e).
    idempotent: true,
    display: 'raw',
    // low auto-resolves in ~ms; medium/high are bound by the 60s
    // modal timeout but the cost is operator wall-clock, not compute.
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

    // low — auto-resolve to the first option, no operator, no modal.
    // The model reads outcome:auto_low and proceeds knowing it assumed
    // options[0] (§12.1).
    if (args.blast_radius === 'low') {
      return { outcome: 'auto_low', chosen_option_id: defaultOptionId };
    }

    // medium / high — needs the operator. Route to the modal bridge.
    const bridge = ctx.clarify;
    if (bridge === undefined) {
      return toolError(
        'clarify.modal_unavailable',
        'clarify (medium/high) needs an interactive operator surface, but none is attached',
        {
          hint: 'Runs in an interactive REPL. In headless / subagent contexts, proceed and record the choice in assumptions[] instead.',
        },
      );
    }

    const resolution = await bridge({
      question: args.question,
      options: args.options,
      ...(args.why_it_matters !== undefined ? { why_it_matters: args.why_it_matters } : {}),
      blast_radius: args.blast_radius,
    });

    // skipped → proceed with the assumed default so the model has a
    // concrete choice to act on, mirroring the low path (§12.3
    // 60s-timeout default = skip-and-proceed-with-auto).
    if (resolution.outcome === 'skipped') {
      return {
        outcome: 'skipped',
        chosen_option_id: resolution.chosen_option_id ?? defaultOptionId,
      };
    }
    return {
      outcome: resolution.outcome,
      ...(resolution.chosen_option_id !== undefined
        ? { chosen_option_id: resolution.chosen_option_id }
        : {}),
      ...(resolution.user_text !== undefined ? { user_text: resolution.user_text } : {}),
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
  if (typeof args.blast_radius !== 'string' || !BLAST_RADII.has(args.blast_radius)) {
    return toolError(
      ERROR_CODES.invalidArg,
      `blast_radius must be one of: low, medium, high (got ${JSON.stringify(args.blast_radius)})`,
    );
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
