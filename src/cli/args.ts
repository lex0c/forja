// Minimal hand-rolled arg parser for M1. Surface area is tiny and stable
// enough that adding `commander` would be more code than this. Anything
// not a recognized flag is collected as the prompt (joined by spaces).

export interface ParsedArgs {
  prompt: string;
  json: boolean;
  version: boolean;
  help: boolean;
  // Plan mode (AGENTIC_CLI §5): harness-level read-only profile.
  // Tools that mutate (writes:true) are blocked before execution
  // regardless of policy; the model produces a structured plan and
  // exits without applying.
  plan: boolean;
  // List-sessions mode (AGENTIC_CLI §2.1): print known sessions
  // (newest first) and exit. Honors --json for headless consumers.
  listSessions: boolean;
  // When --list-sessions is set, fan each parent into its subagent
  // children one level deep. Default false: most users want the
  // top-level view; subagent rows are forensic detail.
  includeSubagents: boolean;
  // Resume mode (AGENTIC_CLI §2.1): continue a prior session by id.
  // Special value 'last' selects the most recently started session.
  // The positional prompt is the follow-up message — without it,
  // there's nothing for the model to do (the picker form `--resume`
  // without a value waits for M4 / Ink TUI).
  resume?: string;
  // Confirm-bypass for had_bash warning on `--undo` /
  // `--checkpoints restore`. Without `--yes`, the handler refuses
  // a destructive restore on a step that ran bash (because bash
  // side effects — DB, network, processes — are not reversed).
  // Pre-TUI substitute for the spec's interactive `Type 'undo' to
  // confirm` prompt; headless friendly.
  yes: boolean;
  // Undo mode (AGENTIC_CLI §12 / CHECKPOINTS.md §2.3). Restores
  // the latest checkpoint of the named session. Same semantics as
  // `agent --checkpoints restore <session> <latest-ckpt>` but
  // resolves the latest id internally.
  undo?: string;
  // Checkpoint subcommands (CHECKPOINTS.md §2.3). The verb is one
  // of `list | diff | restore | purge`; positionals follow the
  // verb until the next flag. Lifted out of `--undo` because the
  // spec keeps these as independent commands and they share a
  // dispatcher inside the handler.
  checkpoints?: { verb: string; positionals: string[] };
  model?: string;
  maxSteps?: number;
  // Cap on rows returned by --list-sessions. Defaults to 20 in
  // the handler when omitted. Only meaningful paired with
  // --list-sessions; standalone use is a parse error so the
  // truncation hint that points at this flag stays actionable.
  limit?: number;
  // Subagent-child mode (M3 §11 / Step 4.2b.ii.a). The parent
  // process spawns the same binary with this flag set; the value
  // is the pre-created child session id. Triggers a dedicated
  // entry path that loads the session + audit row, builds a
  // HarnessConfig with preassignedSessionId, runs the harness,
  // publishes the terminal payload to subagent_outputs, and
  // exits. The flag is internal — users never invoke it
  // directly. Mutually exclusive with every other CLI mode
  // (resume, list-sessions, undo, checkpoints, plan).
  subagentSessionId?: string;
}

export interface ParseError {
  ok: false;
  message: string;
}

export type ParseResult = { ok: true; args: ParsedArgs } | ParseError;

const POSITIVE_INT = /^[1-9][0-9]*$/;

export const parseArgs = (argv: readonly string[]): ParseResult => {
  const args: ParsedArgs = {
    prompt: '',
    json: false,
    version: false,
    help: false,
    plan: false,
    listSessions: false,
    includeSubagents: false,
    yes: false,
  };
  const promptParts: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    switch (arg) {
      case '--version':
      case '-v':
        args.version = true;
        i += 1;
        break;
      case '--json':
        args.json = true;
        i += 1;
        break;
      case '--plan':
        args.plan = true;
        i += 1;
        break;
      case '--list-sessions':
        args.listSessions = true;
        i += 1;
        break;
      case '--include-subagents':
        args.includeSubagents = true;
        i += 1;
        break;
      case '--resume': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          // Bare `--resume` (interactive picker) lands in M4 with the
          // Ink TUI. Until then, require an explicit id or 'last'.
          return {
            ok: false,
            message:
              "--resume requires a session id or 'last' (interactive picker requires the TUI)",
          };
        }
        args.resume = value;
        i += 2;
        break;
      }
      case '--yes':
      case '-y':
        args.yes = true;
        i += 1;
        break;
      case '--undo': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { ok: false, message: '--undo requires a session id' };
        }
        args.undo = value;
        i += 2;
        break;
      }
      case '--checkpoints': {
        const verb = argv[i + 1];
        const known = ['list', 'diff', 'restore', 'purge'] as const;
        if (verb === undefined || verb.startsWith('--')) {
          return {
            ok: false,
            message: `--checkpoints requires a subcommand (${known.join('|')})`,
          };
        }
        if (!known.includes(verb as (typeof known)[number])) {
          return {
            ok: false,
            message: `unknown --checkpoints subcommand: ${verb}. Use one of ${known.join('|')}`,
          };
        }
        // Greedy collection of positionals until the next flag. The
        // sub-handler validates arity per verb (list takes 1, diff
        // and restore take 2, purge takes 1). Centralizing arity
        // here would couple the parser to handler shape; let the
        // handler own that contract.
        //
        // Stop at any token starting with `-` — both long flags
        // (`--json`) and short flags (`-y`). Earlier the scan only
        // stopped at `--`, so `--checkpoints restore <s> <c> -y`
        // swallowed `-y` as a positional and left yes=false. Session
        // and checkpoint ids are UUIDs (start with hex), so the
        // unambiguous-positional case never produces a `-` prefix.
        const positionals: string[] = [];
        let j = i + 2;
        while (j < argv.length) {
          const next = argv[j];
          if (next === undefined) break;
          if (next.startsWith('-')) break;
          positionals.push(next);
          j += 1;
        }
        args.checkpoints = { verb, positionals };
        i = j;
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        i += 1;
        break;
      case '--model': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { ok: false, message: '--model requires a value' };
        }
        args.model = value;
        i += 2;
        break;
      }
      case '--max-steps': {
        const value = argv[i + 1];
        if (value === undefined) {
          return { ok: false, message: '--max-steps requires a value' };
        }
        // Validate the literal first — `Number.parseInt('3.5', 10)` would
        // silently truncate to 3 and pass the numeric checks below.
        if (!POSITIVE_INT.test(value)) {
          return {
            ok: false,
            message: `--max-steps must be a positive integer, got '${value}'`,
          };
        }
        args.maxSteps = Number.parseInt(value, 10);
        i += 2;
        break;
      }
      case '--limit': {
        const value = argv[i + 1];
        if (value === undefined) {
          return { ok: false, message: '--limit requires a value' };
        }
        if (!POSITIVE_INT.test(value)) {
          return {
            ok: false,
            message: `--limit must be a positive integer, got '${value}'`,
          };
        }
        args.limit = Number.parseInt(value, 10);
        i += 2;
        break;
      }
      case '--subagent-session-id': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return {
            ok: false,
            message:
              '--subagent-session-id requires a session id (internal flag; not for user invocation)',
          };
        }
        args.subagentSessionId = value;
        i += 2;
        break;
      }
      default:
        // Anything still starting with `--` after the explicit cases above
        // is an unknown flag. Single-dash tokens (`-foo`) fall through as
        // prompt fragments, which matches users who quote prompts loosely.
        if (arg.startsWith('--')) {
          return { ok: false, message: `unknown flag: ${arg}` };
        }
        promptParts.push(arg);
        i += 1;
        break;
    }
  }
  args.prompt = promptParts.join(' ').trim();

  // --include-subagents only makes sense paired with --list-sessions.
  // Refuse the combination at parse time so the user gets a clear
  // error instead of the flag being silently ignored when typed alone
  // (which used to happen — the flag fell through to the run-mode
  // branch where nothing read it).
  if (args.includeSubagents && !args.listSessions) {
    return {
      ok: false,
      message: '--include-subagents requires --list-sessions',
    };
  }
  // --limit governs the listing cap. The truncation hint emitted
  // by `runListSessions` points users at this flag explicitly, so
  // it MUST exist and be reachable. Same combo-validation as
  // --include-subagents: standalone use is a parse error.
  if (args.limit !== undefined && !args.listSessions) {
    return {
      ok: false,
      message: '--limit requires --list-sessions',
    };
  }
  return { ok: true, args };
};

export const usage = (): string =>
  [
    'Usage: agent [options] <prompt>',
    '',
    'Options:',
    '  --version, -v          Print version and exit',
    '  --help, -h             Show this help and exit',
    '  --json                 Emit NDJSON events to stdout (headless)',
    '  --plan                 Read-only mode: produce a plan, do not apply changes',
    '  --list-sessions        Print known sessions (newest first) and exit',
    '  --include-subagents    With --list-sessions, fan parents into their subagent children (requires --list-sessions)',
    '  --limit <n>            With --list-sessions, cap rows returned (default 20; requires --list-sessions)',
    '  --resume <id|last>     Continue a prior session; positional prompt is the follow-up',
    '  --undo <session>       Restore the latest checkpoint of a session',
    '  --checkpoints <cmd>    Checkpoint subcommands: list <session> | diff <session> <ckpt>',
    '                          | restore <session> <ckpt> | purge <session>',
    '  --yes, -y              Skip the bash-side-effect confirm on undo/restore',
    '  --model <id>           Model id (default: anthropic/claude-sonnet-4-6)',
    '  --max-steps <n>        Override harness step budget',
    '',
    'Examples:',
    '  agent "summarize the README"',
    '  agent --model openai/gpt-4o "list the source files"',
    '  agent --json "what changed in the last commit?" > events.ndjson',
    '  agent --list-sessions --json',
    '  agent --resume last "now refactor the parts you flagged"',
  ].join('\n');
