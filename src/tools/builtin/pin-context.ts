import { scanForInjection } from '../../memory/index.ts';
import {
  InvalidDurationError,
  InvalidPinError,
  PIN_KINDS,
  PIN_TEXT_MAX_LENGTH,
  type PinKind,
  parseDuration,
} from '../../storage/repos/context-pins.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// pin_context — pin a session-scoped constraint that survives compaction,
// is re-injected with the goal, and shows up in auto-rehydrate
// (CONTEXT_TUNING.md §12.4). Always-available and model-driven, like the
// todolist: the model pins directly, no operator modal. The pin list is a
// bounded ring buffer of 10 (PIN_CAP) — at the cap a new pin evicts the
// OLDEST, so there's no remove tool and no cap error; the model only adds
// and the most recent pins win.
//
// Use for facts that must be honored MULTIPLE TIMES this session (e.g.
// "API pública de X não pode mudar", "rodar pnpm fmt antes de commitar").
// NOT for: TODOs (todo_create), one-shot decisions (decisions[]),
// cross-session facts (memory_write).
//
// Pipeline: plumbing (abort / store) → schema → injection scan → persist.
// The injection scan stays even without a modal — a pin rides the prompt-
// injection surface on every re-injection, so a pin proposed from
// untrusted content is blocked before it lands in the goal block.

export interface PinContextInput {
  text: string;
  // Optional — defaults to 'constraint' per §12.4.1.
  kind?: PinKind;
  // Optional duration string ("30m" | "2h" | "1d"). Omitted ⇒ pin lives
  // until end of session (cascade reaps on session purge).
  expires_in?: string;
}
export interface PinContextOutput {
  pinId: string;
  text: string;
  kind: PinKind;
}

// True if `s` has a C0 control char or DEL, allowing only tab. Mirrors the
// todolist guard (todo-shared.ts hasControlChar) — charCodeAt, not a regex,
// so the source carries no literal control bytes. Rejected AT THE SOURCE
// because a `\n` in pin text breaks the one-line-per-pin contract in BOTH
// the resume block (resume-context.ts) and the compaction pin block.
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

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
  if (hasControlChar(args.text)) {
    return toolError(
      ERROR_CODES.invalidArg,
      'text must not contain control characters (newlines included) — a pin renders as one line',
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
    "Pin a session-scoped constraint that survives compaction, is re-injected with the goal, and shows up in auto-rehydrate. The model pins directly — no confirmation. The pin list keeps the 10 most recent: pinning past 10 silently drops the oldest, so you never need to remove one. Use for facts to honor MULTIPLE TIMES this session (e.g. 'API pública de X não pode mudar', 'rodar pnpm fmt antes de commitar'). NOT for: TODOs (use todo_create), one-shot decisions (already in decisions[]), cross-session facts (use memory_write).",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'Constraint text to pin. Short and self-contained — must fit ≤ 500 chars. Re-injected literally on every goal-reinjection / compaction / resume.',
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
    // The persistence is in `sessions.db`, outside the worktree — same
    // reasoning as memory_write: checkpoint --undo restores the worktree
    // but not the db row. Surface the warning per CHECKPOINTS.md §2.6.
    escapesCwd: true,
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
        { hint: 'The harness was constructed without a contextPinsStore. Check HarnessConfig.' },
      );
    }

    const validationErr = validateInput(args);
    if (validationErr !== null) return validationErr;

    const kind: PinKind = args.kind ?? 'constraint';

    // Injection scanner — reuse the memory subsystem's heuristic. Pin text
    // is short, so false-positive cost is tiny; the upside is blocking a pin
    // proposed from untrusted content (e.g. "ignore previous instructions")
    // before it's re-injected into the goal block on every turn.
    const scan = scanForInjection(args.text);
    if (!scan.ok) {
      return toolError(
        'pin.scanner_blocked',
        'text matches an injection / secret heuristic; refusing to pin',
        { hint: 'Rephrase without prompt-injection language; do not include credentials.' },
      );
    }

    let expiresAt: number | null = null;
    if (args.expires_in !== undefined) {
      try {
        expiresAt = Date.now() + parseDuration(args.expires_in);
      } catch (err) {
        if (err instanceof InvalidDurationError) {
          return toolError(ERROR_CODES.invalidArg, err.message, {
            hint: 'expires_in accepts "30m", "2h", "1d" — positive integer + single unit.',
          });
        }
        throw err;
      }
    }

    // Persist directly. The store is a ring buffer of PIN_CAP: at the cap it
    // evicts the oldest active pin, so there's no cap error to handle.
    try {
      const pin = store.createPin({
        sessionId: ctx.sessionId,
        text: args.text,
        kind,
        createdBy: 'model',
        expiresAt,
        sourceStepId: ctx.stepId,
      });
      return { pinId: pin.id, text: pin.text, kind: pin.kind };
    } catch (err) {
      if (err instanceof InvalidPinError) {
        // Unreachable — validateInput covered the same fields — but surface
        // a structured error instead of an unhandled throw on shape drift.
        return toolError(ERROR_CODES.invalidArg, err.message);
      }
      throw err;
    }
  },
};
