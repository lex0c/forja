// /pin — manage session-scoped pinned context (CONTEXT_TUNING.md §12.4).
//
// Subcommands:
//   /pin <text...> [--kind K] [--expires-in DUR]   create a pin
//   /pin --list                                     list active pins
//   /pin --remove <id>                              remove a pin
//   /pin --help                                     show usage
//
// Direct-user action: /pin is operator-typed, so it persists WITHOUT
// going through a confirmation modal. The model-facing equivalent
// is the `pin_context` tool (1.1.b) which always opens a confirm
// modal — that's the surface §12.4.1 names "idêntico a memory
// writes." Splitting the two surfaces means `created_by` carries
// who originated the pin (operator → `user` here; model → `model_
// proposed_user_approved` from the tool).
//
// Notes on parsing:
//   - The shared slash parser (src/cli/slash/parse.ts) splits on
//     whitespace and does NOT support quoted args. /pin <text...>
//     joins all positional (non-flag) tokens with ' ' to recover
//     multi-word text. This matches what /memory show / /memory
//     delete already do for names.
//   - Flag order is flexible: `--kind X` and `--expires-in D` can
//     appear before, between, or after text tokens.
//   - Mode flags (`--list`, `--remove`, `--help`) are mutually
//     exclusive with each other AND with text/create flags. The
//     first mode flag wins; other args after a mode flag (except
//     the value consumed by `--remove`) raise an error so a typo
//     like `/pin --list foo` doesn't silently behave as `--list`.

import { scanForSecrets } from '../../../memory/index.ts';
import {
  type ContextPinsStore,
  InvalidDurationError,
  InvalidPinError,
  PIN_CAP,
  PIN_KINDS,
  PIN_TEXT_MAX_LENGTH,
  PinCapExceededError,
  type PinKind,
  parseDuration,
} from '../../../storage/repos/context-pins.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

interface ParsedArgs {
  mode: 'create' | 'list' | 'remove' | 'help';
  text?: string;
  kind: PinKind;
  expiresInRaw?: string;
  removeId?: string;
}

const USAGE = [
  'usage: /pin <text...> [--kind constraint|workflow|invariant|reminder] [--expires-in 30m|2h|1d]',
  '       /pin --list',
  '       /pin --remove <id>',
  '       /pin --help',
  '',
  'pinned context survives compaction, re-injected with the goal, shows up in auto-rehydrate.',
  `cap: ${PIN_CAP} per session. promote a pin to a memory entry (/memory) for cross-session reach.`,
];

const formatUsage = (header?: string): SlashResult => ({
  kind: 'ok',
  notes: header !== undefined ? [header, '', ...USAGE] : USAGE,
});

const parseArgs = (args: readonly string[]): ParsedArgs | { error: string } => {
  let mode: ParsedArgs['mode'] | undefined;
  let kind: PinKind = 'constraint';
  let expiresInRaw: string | undefined;
  let removeId: string | undefined;
  const textTokens: string[] = [];

  let i = 0;
  while (i < args.length) {
    const tok = args[i] as string;
    if (tok === '--help' || tok === '-h') {
      if (mode !== undefined && mode !== 'help') {
        return { error: `/pin: cannot combine --help with --${mode}` };
      }
      mode = 'help';
      i += 1;
      continue;
    }
    if (tok === '--list') {
      if (mode !== undefined && mode !== 'list') {
        return { error: `/pin: cannot combine --list with --${mode}` };
      }
      mode = 'list';
      i += 1;
      continue;
    }
    if (tok === '--remove') {
      if (mode !== undefined && mode !== 'remove') {
        return { error: `/pin: cannot combine --remove with --${mode}` };
      }
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/pin: --remove needs an id (try /pin --list to see ids)' };
      }
      mode = 'remove';
      removeId = next;
      i += 2;
      continue;
    }
    if (tok === '--kind') {
      const next = args[i + 1];
      if (next === undefined) {
        return { error: `/pin: --kind needs a value (one of: ${PIN_KINDS.join(', ')})` };
      }
      if (!(PIN_KINDS as readonly string[]).includes(next)) {
        return {
          error: `/pin: invalid kind '${next}' (expected: ${PIN_KINDS.join(', ')})`,
        };
      }
      kind = next as PinKind;
      i += 2;
      continue;
    }
    if (tok === '--expires-in') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/pin: --expires-in needs a duration (e.g. 30m, 2h, 1d)' };
      }
      expiresInRaw = next;
      i += 2;
      continue;
    }
    if (tok.startsWith('--')) {
      return { error: `/pin: unknown flag '${tok}' (try /pin --help)` };
    }
    // Positional token → part of the text.
    textTokens.push(tok);
    i += 1;
  }

  // Mode disambiguation. Text + a mode flag is an error so a typo
  // like `/pin --list world` doesn't silently behave as `--list`.
  if (mode === undefined) mode = textTokens.length > 0 ? 'create' : 'help';

  if (mode === 'list' || mode === 'remove' || mode === 'help') {
    if (textTokens.length > 0) {
      return {
        error: `/pin: positional text not allowed with --${mode}`,
      };
    }
    if (expiresInRaw !== undefined) {
      return { error: `/pin: --expires-in not allowed with --${mode}` };
    }
    // Default `kind` is `'constraint'` whether the user supplied it
    // or not. To detect an *explicit* `--kind` paired with a mode
    // flag (so we can reject the typo `/pin --list --kind reminder`)
    // peek at the raw args. Cheaper than threading "was set
    // explicitly?" through parseArgs.
    if (args.includes('--kind')) {
      return { error: `/pin: --kind not allowed with --${mode}` };
    }
  }

  if (mode === 'create' && textTokens.length === 0) {
    return { error: '/pin: missing text (try /pin --help)' };
  }

  return {
    mode,
    ...(mode === 'create' ? { text: textTokens.join(' ') } : {}),
    kind,
    ...(expiresInRaw !== undefined ? { expiresInRaw } : {}),
    ...(removeId !== undefined ? { removeId } : {}),
  };
};

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

const formatActivePin = (
  pin: { id: string; text: string; kind: PinKind; createdAt: number; expiresAt: number | null },
  now: number,
): string => {
  const sid = shortId(pin.id);
  let expiresNote = '';
  if (pin.expiresAt !== null) {
    // handleList calls getActivePinsBySession with the same `now`
    // that lands here, so remainingMs is guaranteed > 0 — no
    // "expired" branch needed (a row at exactly expires_at == now
    // was already filtered out by the strict `> now` predicate).
    const remainingMs = pin.expiresAt - now;
    if (remainingMs < 60_000) {
      expiresNote = ' (expires in <1m)';
    } else if (remainingMs < 3_600_000) {
      expiresNote = ` (expires in ${Math.floor(remainingMs / 60_000)}m)`;
    } else if (remainingMs < 86_400_000) {
      expiresNote = ` (expires in ${Math.floor(remainingMs / 3_600_000)}h)`;
    } else {
      expiresNote = ` (expires in ${Math.floor(remainingMs / 86_400_000)}d)`;
    }
  }
  return `  ${sid} [${pin.kind}] ${pin.text}${expiresNote}`;
};

const handleList = (store: ContextPinsStore, sessionId: string, now: () => number): SlashResult => {
  const t = now();
  const pins = store.getActivePinsBySession(sessionId, t);
  if (pins.length === 0) {
    return { kind: 'ok', notes: ['no pins active in this session'] };
  }
  const header = `pins (${pins.length}/${PIN_CAP}):`;
  return { kind: 'ok', notes: [header, ...pins.map((p) => formatActivePin(p, t))] };
};

// Minimum prefix length operators can supply. Shorter inputs would
// collide too often (a 1-char hex prefix matches ~1/16 of UUIDs) so
// they're refused with a usability hint. /pin --list shows 8 chars,
// which sits well above any reasonable collision threshold for the
// `PIN_CAP=10` per-session limit.
const MIN_REMOVE_ID_PREFIX = 4;

const handleRemove = (
  store: ContextPinsStore,
  sessionId: string,
  removeId: string,
  now: number,
): SlashResult => {
  // Fast path: caller passed the full UUID — exact match avoids the
  // prefix scan + ambiguity check. Same semantics as before this
  // helper learned prefix resolution.
  if (removeId.length === 36 && store.getPin(removeId) !== null) {
    const ok = store.removePin(removeId);
    if (!ok) {
      // Race: pin was removed between getPin and removePin. Treat
      // as not-found from the operator's POV.
      return {
        kind: 'error',
        message: `/pin: no pin with id '${removeId}' (try /pin --list)`,
      };
    }
    return { kind: 'ok', notes: [`removed pin ${shortId(removeId)}`] };
  }

  // Prefix path: resolve operator-typed shortId (or any unique prefix)
  // against the session's active pins. Mirrors git's abbreviated SHA
  // ergonomics — short enough to type, refuses on ambiguity instead
  // of silently picking one.
  if (removeId.length < MIN_REMOVE_ID_PREFIX) {
    return {
      kind: 'error',
      message: `/pin: id prefix must be at least ${MIN_REMOVE_ID_PREFIX} chars (got '${removeId}')`,
    };
  }
  const matches = store.findActivePinsByIdPrefix(sessionId, removeId, now);
  if (matches.length === 0) {
    return {
      kind: 'error',
      message: `/pin: no pin with id '${removeId}' (try /pin --list)`,
    };
  }
  if (matches.length > 1) {
    const sids = matches.map((p) => shortId(p.id)).join(', ');
    return {
      kind: 'error',
      message: `/pin: prefix '${removeId}' is ambiguous — matches ${matches.length} pins (${sids}); lengthen the prefix`,
    };
  }
  const target = matches[0] as (typeof matches)[0];
  const ok = store.removePin(target.id);
  if (!ok) {
    return {
      kind: 'error',
      message: `/pin: no pin with id '${removeId}' (try /pin --list)`,
    };
  }
  return { kind: 'ok', notes: [`removed pin ${shortId(target.id)}`] };
};

const handleCreate = (
  store: ContextPinsStore,
  sessionId: string,
  parsed: ParsedArgs,
  nowMs: number,
): SlashResult => {
  if (parsed.text === undefined) {
    // Unreachable — parseArgs would have errored. Belt + braces.
    return { kind: 'error', message: '/pin: missing text (internal)' };
  }
  if (parsed.text.length > PIN_TEXT_MAX_LENGTH) {
    return {
      kind: 'error',
      message: `/pin: text must be ≤ ${PIN_TEXT_MAX_LENGTH} chars (got ${parsed.text.length})`,
    };
  }

  // Secret-only scan (skip the injection-phrase pass — operator
  // typed this themselves; a /pin like "ignore previous
  // instructions" may be a legitimate note about a failure mode).
  // Credential leaks still need to be blocked: a copy-paste from
  // a log line with `sk-ant-...` would otherwise land literal in
  // context_pins.text and re-inject on every goal / resume.
  // Mirror of the asymmetry the `/memory promote shared` slash
  // command makes — the model-facing tool (pin_context) runs the
  // full scanForInjection per CONTEXT_TUNING.md §12.4 discipline.
  // The hint deliberately omits the matched pattern so an operator
  // can't accidentally double-paste the credential into the
  // error string.
  const scan = scanForSecrets(parsed.text);
  if (!scan.ok) {
    return {
      kind: 'error',
      message:
        '/pin: refusing to pin text that matches a credential pattern (rotate the secret and retry without it)',
    };
  }

  let expiresAt: number | null = null;
  if (parsed.expiresInRaw !== undefined) {
    try {
      expiresAt = nowMs + parseDuration(parsed.expiresInRaw);
    } catch (err) {
      if (err instanceof InvalidDurationError) {
        return { kind: 'error', message: `/pin: ${err.message}` };
      }
      throw err;
    }
  }

  try {
    const pin = store.createPin({
      sessionId,
      text: parsed.text,
      kind: parsed.kind,
      createdBy: 'user',
      ...(expiresAt !== null ? { expiresAt } : {}),
      createdAt: nowMs,
    });
    const remaining = store.countActivePinsBySession(sessionId, nowMs);
    return {
      kind: 'ok',
      notes: [
        `pinned ${shortId(pin.id)} [${pin.kind}] (${remaining}/${PIN_CAP} active): ${pin.text}`,
      ],
    };
  } catch (err) {
    if (err instanceof PinCapExceededError) {
      return {
        kind: 'error',
        message: `/pin: cap reached (${err.currentCount}/${PIN_CAP}); remove one first via /pin --remove <id>`,
      };
    }
    if (err instanceof InvalidPinError) {
      return { kind: 'error', message: `/pin: ${err.message}` };
    }
    throw err;
  }
};

export const pinCommand: SlashCommand = {
  name: 'pin',
  description: 'Pin session-scoped constraints (survive compaction/resume)',
  exec: async (args: string[], ctx: SlashContext): Promise<SlashResult> => {
    const store = ctx.contextPinsStore;
    if (store === undefined) {
      return {
        kind: 'error',
        message: '/pin: pin store unavailable (harness not wired with contextPinsStore)',
      };
    }

    const parsed = parseArgs(args);
    if ('error' in parsed) return { kind: 'error', message: parsed.error };

    if (parsed.mode === 'help') {
      return formatUsage();
    }

    // Pins are session-scoped — the FK on context_pins.session_id
    // is NOT NULL, so we can't persist before the first turn lands
    // a sessions row. Same gate /memory show uses, with a clearer
    // hint pointing at the resolution.
    const sessionId = ctx.currentSessionId();
    if (sessionId === null) {
      return {
        kind: 'error',
        message: '/pin: no active session yet — submit a prompt first',
      };
    }

    if (parsed.mode === 'list') return handleList(store, sessionId, ctx.now);
    if (parsed.mode === 'remove') {
      // parseArgs guarantees removeId is set when mode is 'remove'.
      const id = parsed.removeId;
      if (id === undefined) {
        return { kind: 'error', message: '/pin: --remove needs an id (internal)' };
      }
      return handleRemove(store, sessionId, id, ctx.now());
    }
    return handleCreate(store, sessionId, parsed, ctx.now());
  },
};
