import { scanForInjection } from '../../memory/index.ts';
import {
  InvalidDurationError,
  InvalidPinError,
  PIN_CAP,
  PIN_KINDS,
  PIN_TEXT_MAX_LENGTH,
  PinCapExceededError,
  type PinKind,
  parseDuration,
} from '../../storage/repos/context-pins.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// pin_context — propose a session-scoped pinned constraint per
// CONTEXT_TUNING.md §12.4.1. Modal-confirmed by the operator, idêntico
// ao memory_write (§12.4.1 final). Distinct from /pin (slash command,
// 1.1.c) which is direct user action: this tool is the path the
// MODEL takes when it wants to pin something, and so it ALWAYS goes
// through a confirmation modal — operator approval is the only
// vector that turns a model proposal into persistent state.
//
// Pipeline (each gate independent so audit shows where the proposal
// died, same discipline as memory_write):
//
//   1. Plumbing checks: aborted? store wired?
//   2. Schema/shape: text non-empty + ≤ 500 chars, kind in enum,
//      expires_in parses cleanly (defers to parseDuration).
//   3. Injection scanner (§7.3 of MEMORY — re-used here because pins
//      ride the same prompt-injection surface). Short pin text is a
//      smaller attack surface than memory body, but the cost of
//      scanning ≤ 500 chars is trivial; block + audit early.
//   4. Headless rejection: when `confirmPinContext` is unwired (CI,
//      one-shot, subagent with no IPC modal pipe), refuse cleanly.
//      Same discipline as memory_write §5.1.6.
//   5. Modal confirm — operator decides. yes → persist with
//      `created_by: model_proposed_user_approved`; no → rejected
//      audit; cancel (Esc/timeout) → also rejected with distinct
//      reason.
//   6. Persist via store.createPin. Cap of 10 per session is
//      enforced atomically by the repo's withImmediateTransaction;
//      surfaces here as PinCapExceededError → mapped to a
//      `pin.cap_exceeded` tool error so the model can echo the
//      suggestion ("remove one via /pin --remove first").
//
// `created_by` is hard-wired to 'model_proposed_user_approved' on
// this surface — the `user` value belongs to /pin (1.1.c) where the
// operator typed the text directly. Splitting the createdBy axis
// across the two surfaces lets recap/audit see "did the model
// propose this, or did the operator pin it themselves?" without
// extra metadata.
//
// `sourceStepId` is populated from `ctx.stepId` so the recap
// projection can answer "which step led to this pin?" without
// digging through the message timeline.

export interface PinContextInput {
  text: string;
  // Optional — defaults to 'constraint' per §12.4.1.
  kind?: PinKind;
  // Optional duration string ("30m" | "2h" | "1d"). Omitted ⇒ pin
  // lives until end of session (cascade reaps on session purge).
  expires_in?: string;
}

export interface PinContextOutput {
  // 'created' on persist, 'rejected' on operator decline or
  // headless mode. The tool returns the rejected outcome as
  // success-shaped (not a ToolError) so the model sees the
  // structured answer to its proposal — same convention as
  // memory_write.
  outcome: 'created' | 'rejected';
  text: string;
  kind: PinKind;
  // On 'created', the new pin id; absent on 'rejected'.
  pinId?: string;
  // Stable reason string the model can echo back.
  reason: string;
}

const validateInput = (args: PinContextInput): ToolResult<PinContextOutput> | null => {
  if (typeof args.text !== 'string' || args.text.length === 0) {
    return toolError(ERROR_CODES.invalidArg, 'text must be a non-empty string');
  }
  if (args.text.length > PIN_TEXT_MAX_LENGTH) {
    return toolError(
      ERROR_CODES.invalidArg,
      `text must be ≤ ${PIN_TEXT_MAX_LENGTH} chars (got ${args.text.length})`,
    );
  }
  if (args.kind !== undefined) {
    if (typeof args.kind !== 'string' || !(PIN_KINDS as readonly string[]).includes(args.kind)) {
      return toolError(
        ERROR_CODES.invalidArg,
        `kind must be one of: ${PIN_KINDS.join(', ')} (got ${JSON.stringify(args.kind)})`,
      );
    }
  }
  if (args.expires_in !== undefined && typeof args.expires_in !== 'string') {
    return toolError(ERROR_CODES.invalidArg, 'expires_in must be a string when provided');
  }
  return null;
};

export const pinContextTool: Tool<PinContextInput, PinContextOutput> = {
  name: 'pin_context',
  description:
    "Propose a session-scoped pinned constraint that survives compaction, is re-injected with the goal, and shows up in auto-rehydrate. ALWAYS opens an operator-confirmation modal — only persists on accept. Use for facts that must be remembered MULTIPLE TIMES in this session (e.g. 'API pública de X não pode mudar', 'rodar pnpm fmt antes de commitar'). NOT for: TODOs (use todo_write), one-shot decisions (already in decisions[]), cross-session facts (use memory_write). Cap of 10 pins per session; rejected with pin.cap_exceeded when exceeded. In headless mode the call is rejected with pin.headless_mode.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'Constraint text to pin. Short and self-contained — must fit ≤ 500 chars. Will be re-injected literally on every goal-reinjection / compaction / resume.',
      },
      kind: {
        type: 'string',
        enum: ['constraint', 'workflow', 'invariant', 'reminder'],
        description:
          "Constraint kind (default: constraint). 'constraint' = thing to never do or always do; 'workflow' = step to always run; 'invariant' = property to preserve; 'reminder' = transient note for current phase.",
      },
      expires_in: {
        type: 'string',
        description:
          'Optional auto-expiry duration: "30m", "2h", "1d". Omitted ⇒ pin lives until end of session. Use for phase-bounded pins ("fase de refactor — não tocar em testes").',
      },
    },
    required: ['text'],
  },
  metadata: {
    category: 'misc',
    // Persists to SQLite (context_pins table).
    writes: true,
    // The persistence is in `sessions.db`, which sits outside the
    // worktree (in `~/.local/share/forja/` or per-project). Same
    // reasoning as memory_write: checkpoint --undo restores the
    // worktree but not the db row. Surface the warning per
    // CHECKPOINTS.md §2.6.
    escapesCwd: true,
    // Awaits the modal-bridge `confirmPinContext` callback before
    // persisting. Subagent contexts don't have one (no IPC modal
    // pipe), same shape as memory_write — the subagent validator
    // rejects whitelists that include this tool.
    requiresOperatorConfirm: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 30 },
  },
  async execute(args, ctx): Promise<ToolResult<PinContextOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before pin', { retryable: true });
    }
    const store = ctx.contextPinsStore;
    if (store === undefined) {
      return toolError(
        'pin.store_unavailable',
        'pin_context requires a context pins store but none was provided',
        {
          hint: 'The harness was constructed without a contextPinsStore. Check HarnessConfig.',
        },
      );
    }

    const validationErr = validateInput(args);
    if (validationErr !== null) return validationErr;

    const kind: PinKind = args.kind ?? 'constraint';

    // Injection scanner — reuse the memory subsystem's heuristic.
    // Pin text is short (≤ 500 chars) so false-positive cost is
    // tiny; the upside is closing a vector where a model proposes
    // a pin like "ignore previous instructions" and the operator
    // habit-confirms it. Audited reason on refusal so an operator
    // looking at /pin --list can see what was blocked.
    const scan = scanForInjection(args.text);
    if (!scan.ok) {
      return toolError(
        'pin.scanner_blocked',
        'text matches an injection / secret heuristic; refusing to propose pin',
        {
          // Don't echo the matched pattern — same reasoning as
          // memory_write: surfacing it would teach a future
          // prompt how to bypass the scanner. Operator-side trace
          // carries the detail when it lands.
          hint: 'Rephrase the text without prompt-injection language; do not include credentials.',
        },
      );
    }

    // Resolve expires_at if expires_in was supplied. Parse before
    // headless gate so a malformed duration surfaces as the
    // structured error the caller can fix, not as "headless mode"
    // confusion.
    let expiresAt: number | null = null;
    if (args.expires_in !== undefined) {
      try {
        const ms = parseDuration(args.expires_in);
        expiresAt = Date.now() + ms;
      } catch (err) {
        if (err instanceof InvalidDurationError) {
          return toolError(ERROR_CODES.invalidArg, err.message, {
            hint: 'expires_in accepts "30m", "2h", "1d" — positive integer + single unit.',
          });
        }
        throw err;
      }
    }

    // Headless rejection (mirror of memory_write §5.1.6).
    const confirm = ctx.confirmPinContext;
    if (confirm === undefined) {
      return toolError(
        'pin.headless_mode',
        'pin_context rejected: headless mode (no confirmation surface attached)',
        {
          hint: 'Run inside an interactive REPL, or use /pin directly when the slash command lands.',
        },
      );
    }

    const answer = await confirm({
      text: args.text,
      kind,
      expiresAt,
    });

    if (answer !== 'yes') {
      return {
        outcome: 'rejected',
        text: args.text,
        kind,
        reason: answer === 'no' ? 'operator declined' : 'operator cancelled (esc/timeout)',
      };
    }

    // Persist. Cap of 10 (PIN_CAP) is enforced atomically inside
    // the repo; surface as a tool error so the model can act on it
    // — the rejected outcome is reserved for operator decisions.
    try {
      const pin = store.createPin({
        sessionId: ctx.sessionId,
        text: args.text,
        kind,
        createdBy: 'model_proposed_user_approved',
        expiresAt,
        sourceStepId: ctx.stepId,
      });
      return {
        outcome: 'created',
        text: pin.text,
        kind: pin.kind,
        pinId: pin.id,
        reason: 'pinned',
      };
    } catch (err) {
      if (err instanceof PinCapExceededError) {
        return toolError(
          'pin.cap_exceeded',
          `session already has ${err.currentCount} pins (cap ${PIN_CAP}); remove one first`,
          {
            hint: 'Use /pin --list to see active pins, then /pin --remove <id> to free a slot.',
            details: {
              currentCount: err.currentCount,
              cap: PIN_CAP,
              sessionId: err.sessionId,
            },
          },
        );
      }
      if (err instanceof InvalidPinError) {
        // Should be unreachable — validateInput already covered
        // the same fields. Surface as invalid_arg so an unexpected
        // shape mismatch still gives the model a structured error
        // instead of an unhandled throw.
        return toolError(ERROR_CODES.invalidArg, err.message);
      }
      throw err;
    }
  },
};
