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
  // Resume mode (AGENTIC_CLI §2.1): continue a prior session by id.
  // Special value 'last' selects the most recently started session.
  // The positional prompt is the follow-up message — without it,
  // there's nothing for the model to do (the picker form `--resume`
  // without a value waits for M4 / Ink TUI).
  resume?: string;
  model?: string;
  maxSteps?: number;
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
    '  --resume <id|last>     Continue a prior session; positional prompt is the follow-up',
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
