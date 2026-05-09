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
  // Pre-REPL permission inspection. Resolves the merged policy
  // for the current cwd + per-section provenance (which YAML
  // wrote each section) and prints it before starting any
  // session. Lets operators audit "what would my permissions
  // look like here?" without entering the REPL — useful when
  // joining a new project / cwd, debugging a layered policy
  // setup, or scripting policy checks in CI. DB-only path; no
  // provider, no API key.
  explainPermissions: boolean;
  // When --list-sessions is set, fan each parent into its subagent
  // children one level deep. Default false: most users want the
  // top-level view; subagent rows are forensic detail.
  includeSubagents: boolean;
  // Resume mode (AGENTIC_CLI §2.1): continue a prior session by id.
  // Special value 'last' selects the most recently started session.
  // The positional prompt is the follow-up message — without it,
  // there's nothing for the model to do (the picker form `--resume`
  // without a value waits for an interactive TUI).
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
  // `--worktrees <verb> [positionals]` — operator surface for
  // gc/list of subagent worktrees. Verbs: 'list',
  // 'gc'. `gc` accepts `--dry-run` and `--force` as
  // positionals (sub-flags); the handler interprets them.
  worktrees?: { verb: string; positionals: string[] };
  // `--memory <verb> [positionals]` — operator surface for
  // inspecting cross-session memory. Verbs:
  // 'list' (optional scope positional), 'show' (name + optional
  // scope). DB-only path; no provider call needed. The handler
  // builds a memory registry from the cwd and renders entries /
  // body via the same registry the model-facing tools use.
  memory?: { verb: string; positionals: string[] };
  model?: string;
  maxSteps?: number;
  // Cap on rows returned by --list-sessions. Defaults to 20 in
  // the handler when omitted. Only meaningful paired with
  // --list-sessions; standalone use is a parse error so the
  // truncation hint that points at this flag stays actionable.
  limit?: number;
  // Subagent-child mode (spec §11). The parent
  // process spawns the same binary with this flag set; the value
  // is the pre-created child session id. Triggers a dedicated
  // entry path that loads the session + audit row, builds a
  // HarnessConfig with preassignedSessionId, runs the harness,
  // publishes the terminal payload to subagent_outputs, and
  // exits. The flag is internal — users never invoke it
  // directly. Mutually exclusive with every other CLI mode
  // (resume, list-sessions, undo, checkpoints, plan).
  subagentSessionId?: string;
  // Subagent recursion depth carried across the subprocess
  // boundary. The parent's `runSubagent` knows the depth this
  // child will run at; passing it via this flag lets the child's
  // harness config keep `subagentDepth` non-zero, so any nested
  // task() call increments from the right baseline and trips
  // MAX_SUBAGENT_DEPTH at the chain-wide limit (not per-process).
  // Without this, every subprocess would reset to 0 and a
  // sufficiently deep chain could fan out unbounded. Internal
  // flag, paired with --subagent-session-id; ignored when that
  // flag is absent.
  subagentDepth?: number;
  // Sampling temperature carried across the subprocess boundary.
  // Eval / automation workflows pin temperature=0 for
  // determinism; without this propagation, the subprocess child
  // would silently fall back to the provider default (typically
  // ~1.0) and break reproducibility. Internal flag, paired with
  // --subagent-session-id. When omitted the child runs at the
  // provider's default — same semantics as the top-level harness.
  subagentTemperature?: number;
  // Plan-mode flag carried across the subprocess boundary.
  // Presence = true (no value); absence = false. The top-level
  // `task` tool gate (planSafe:false) refuses spawning under
  // plan mode TODAY, so the practical user-visible scenario is
  // closed at a higher layer. But: programmatic callers that
  // invoke `runSubagent({ planMode: true })` directly bypass
  // the top-level gate, AND a future regression flipping the
  // task tool's planSafe back to true would reopen the surface.
  // Forwarding here is defense in depth — the child's harness
  // gate also refuses writes under planMode, so a write tool
  // in the whitelist is doubly blocked.
  subagentPlanMode?: boolean;
  // Trust state carried across the subprocess boundary.
  // Presence = true (no value); absence = false. Spec §9 trust
  // is per-PROJECT, not per-instance: the parent already
  // resolved trust against `~/.config/agent/trust.json` at
  // bootstrap, and the child must run under that same verdict.
  // Without this forwarding the child's harness defaults
  // `isCwdTrusted` to false (fail-closed) — even when the
  // operator explicitly trusted the cwd. Tools that gate on
  // trust (e.g., `memory_write` refuses inferred writes on
  // untrusted cwd) silently degrade for every subagent the
  // operator spawns. Worktree-isolated subagents particularly
  // hit this: the worktree path under `~/.cache/agent/worktrees/`
  // is never on the trusted list, so re-resolving trust from
  // `session.cwd` would also default false. Carrying the
  // parent's verdict explicitly is the only correct option.
  subagentCwdTrusted?: boolean;
  // Internal: per-subagent bg log directory. The parent's
  // runSubagent computes
  // `<parentCwd>/.agent/bg/<childSessionId>/` and forwards via
  // `--subagent-bg-log-dir <path>`. The child wires this into
  // its harness's bg manager so background-process tools
  // (`bash_background` / `bash_output` / `bash_kill` /
  // process-aware `wait_for` and `monitor`) work without
  // colliding with the parent's bg state. Undefined when the
  // flag is absent (older parents, tests).
  subagentBgLogDir?: string;
  // Internal: parent's cwd carried across the subprocess boundary
  // so the child's MemoryRegistry uses the parent's memory tree
  // (project_local + project_shared anchored at the parent's
  // repo) rather than the worktree's. Memory is per-repo
  // logically, not per-worktree — a worktree-isolated subagent
  // shouldn't lose access to project_local just because its cwd
  // is the cache directory. The child resolves
  // `resolveScopeRoots(<this path>)` to anchor roots, but anchors
  // audit `cwd` events to its own session.cwd so forensic
  // queries can distinguish "where the read happened" from
  // "which project the memory belongs to". Undefined when the
  // flag is absent (older parents, in-process tests, or
  // operator-driven `--subagent-session-id` invocations without
  // a parent runtime to set it).
  subagentMemoryCwd?: string;
  // Internal: IPC protocol version. Set when the parent spawns
  // the child with `--ipc=<n>` to enable the parent↔child stream
  // (spec docs/spec/IPC.md). Absent ⇒ child runs in the legacy
  // SQLite-only mode (no live event channel). The protocol is
  // versioned so future bumps can be detected at handshake; an
  // older child that doesn't recognize the version refuses
  // before emitting any message (spec §4.2). `undefined` is the
  // default — present-but-mismatched is a hard refusal at
  // child boot.
  subagentIpcVersion?: number;
  // `agent init` mode (AGENTIC_CLI §2.1). Scaffolds
  // `.agent/permissions.yaml` and exits. The first positional
  // arg `init` triggers it — diverging from the `--<flag>`
  // convention every other subcommand uses, but matching shell
  // muscle memory (`git init`, `npm init`, `cargo init`). When
  // set, the parser stops collecting prompt fragments and
  // accepts only the init-specific sub-flags (`--force`,
  // `--mode`, `--playbooks`). Mutually exclusive with --json
  // (init is operator-facing, not scriptable yet) and every
  // other run mode; the dispatcher checks.
  //
  // `playbooks` switches the handler to the alternate path
  // (`PLAYBOOKS.md` §14): instead of writing
  // `.agent/permissions.yaml`, the handler writes the canonical
  // .md playbooks under `.agent/agents/`. Mode is irrelevant on
  // that path (mode is a permissions concept) and gets ignored
  // by the handler. Force still gates overwrites — shared with
  // the permissions path so the operator does not have to
  // remember per-flag semantics.
  init?: { force: boolean; mode: 'strict' | 'acceptEdits'; playbooks: boolean };
  // `agent recap [args]` headless subcommand (RECAP.md §9). Routes
  // to the `runRecapHeadless` handler — same surface as the
  // `/recap` slash but invoked from a non-REPL context (CI, scripts,
  // `gh pr create --body $(agent recap pr ...)`). The args array is
  // forwarded verbatim to the slash parser so every recap form
  // (`pr`, `changelog`, `slack`, `terse`, `last <N>`, `session
  // <id>`, `list [filtros]`, `json`, etc.) works the same way the
  // operator types it in the REPL. Pairs with the global `--json`
  // flag to emit the §9 NDJSON event stream
  // (recap_start / recap_intermediate / recap_render / recap_end);
  // without `--json`, headless output is the rendered string only.
  recap?: { args: string[] };
}

export interface ParseError {
  ok: false;
  message: string;
}

export type ParseResult = { ok: true; args: ParsedArgs } | ParseError;

const POSITIVE_INT = /^[1-9][0-9]*$/;

// Positional subcommand dispatch. The verb has to be the very
// first token on the command line — anywhere else it's a prompt
// fragment (the operator can write `agent "review the init
// script"` without it being mis-parsed as a verb). Returns null
// when argv[0] isn't a known subcommand, so the caller falls
// through to the main flag-parser. Sub-flags allowed inside the
// verb's tail are validated here; unknown flags surface a verb-
// scoped error so the diagnostic points at the right surface.
const parseInitSubcommand = (argv: readonly string[]): ParseResult | null => {
  if (argv.length === 0 || argv[0] !== 'init') return null;
  let force = false;
  let mode: 'strict' | 'acceptEdits' = 'strict';
  let playbooks = false;
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      i += 1;
      continue;
    }
    if (token === '--force') {
      force = true;
      i += 1;
      continue;
    }
    if (token === '--playbooks') {
      // Switches init to the canonical-playbooks path
      // (`PLAYBOOKS.md` §14). Mutually compatible with --force;
      // --mode is ignored on this path and silently dropped (the
      // handler does not consult it). Erroring on the
      // combination would be operator-hostile — the muscle
      // memory `agent init --mode strict --playbooks` should
      // just work.
      playbooks = true;
      i += 1;
      continue;
    }
    if (token === '--mode') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: '--mode requires a value (strict|acceptEdits)' };
      }
      if (value !== 'strict' && value !== 'acceptEdits') {
        return {
          ok: false,
          message: `--mode must be one of strict|acceptEdits, got '${value}'`,
        };
      }
      mode = value;
      i += 2;
      continue;
    }
    if (token === '--help' || token === '-h') {
      // Threaded through args so the dispatcher's --help branch
      // still fires (pre-existing top-level behavior). Init has no
      // separate help text — the global usage already lists it.
      return {
        ok: true,
        args: {
          prompt: '',
          json: false,
          version: false,
          help: true,
          plan: false,
          listSessions: false,
          includeSubagents: false,
          explainPermissions: false,
          yes: false,
        },
      };
    }
    return { ok: false, message: `init: unknown argument '${token}'` };
  }
  return {
    ok: true,
    args: {
      prompt: '',
      json: false,
      version: false,
      help: false,
      plan: false,
      listSessions: false,
      includeSubagents: false,
      explainPermissions: false,
      yes: false,
      init: { force, mode, playbooks },
    },
  };
};

// `agent recap [args]` — headless surface for the recap slash
// command. The verb has to be the very first token on the command
// line (same convention as `init`); when present, every following
// token is collected into `args.recap.args` verbatim and the
// slash-side parser does the heavy lifting in `runRecapHeadless`.
// `--json` is consumed at the top-level scan that wraps this
// subcommand (the dispatcher sets it before routing), so the
// headless handler decides "NDJSON or rendered text" from
// `args.json`.
const parseRecapSubcommand = (argv: readonly string[]): ParseResult | null => {
  if (argv.length === 0 || argv[0] !== 'recap') return null;
  let json = false;
  const recapArgs: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      return {
        ok: true,
        args: {
          prompt: '',
          json: false,
          version: false,
          help: true,
          plan: false,
          listSessions: false,
          includeSubagents: false,
          explainPermissions: false,
          yes: false,
        },
      };
    }
    if (token === '--json') {
      // `--json` toggles NDJSON output mode (§9). Consumed at the
      // subcommand boundary so the recap-side parser does not see
      // it as a renderer flag.
      json = true;
      i += 1;
      continue;
    }
    // Every other token — including recap-specific flags
    // (`--no-llm-render`, `--out`, `--limit`, `--project`, etc.)
    // and positional subcommand verbs (`pr`, `last`, `session`,
    // `list`, `json`) — is forwarded as-is. The slash parser
    // owns the vocabulary; redoing it here would be duplication
    // and a place to drift.
    recapArgs.push(token);
    i += 1;
  }
  return {
    ok: true,
    args: {
      prompt: '',
      json,
      version: false,
      help: false,
      plan: false,
      listSessions: false,
      includeSubagents: false,
      explainPermissions: false,
      yes: false,
      recap: { args: recapArgs },
    },
  };
};

export const parseArgs = (argv: readonly string[]): ParseResult => {
  const initParsed = parseInitSubcommand(argv);
  if (initParsed !== null) return initParsed;
  const recapParsed = parseRecapSubcommand(argv);
  if (recapParsed !== null) return recapParsed;
  const args: ParsedArgs = {
    prompt: '',
    json: false,
    version: false,
    help: false,
    plan: false,
    listSessions: false,
    includeSubagents: false,
    explainPermissions: false,
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
      case '--explain-permissions':
        args.explainPermissions = true;
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
      case '--worktrees': {
        const verb = argv[i + 1];
        const known = ['list', 'gc'] as const;
        if (verb === undefined || verb.startsWith('-')) {
          return {
            ok: false,
            message: `--worktrees requires a subcommand (${known.join('|')})`,
          };
        }
        if (!known.includes(verb as (typeof known)[number])) {
          return {
            ok: false,
            message: `unknown --worktrees subcommand: ${verb}. Use one of ${known.join('|')}`,
          };
        }
        // Greedy collection of positionals until the next
        // unrecognized flag-shaped token. The earlier
        // implementation stopped only on `--json`/`--help`/`-h`,
        // which silently swallowed every OTHER top-level flag
        // (--yes, --model, etc.) into positionals — those tokens
        // were then ignored by the handler, so `agent --worktrees
        // list --model foo` ran the list with `foo` as a stray
        // positional and the operator wondered why --model didn't
        // do anything.
        //
        // Verb-aware allowlist: only the verb's known sub-flags
        // are kept inside positional collection. Any other `-`
        // / `--` prefixed token breaks the loop so the outer
        // parser sees it on the next iteration. `list` has no
        // sub-flags so it stops at every flag-shaped token.
        const verbSubFlags: Readonly<Record<string, ReadonlySet<string>>> = {
          gc: new Set(['--dry-run', '--force']),
          list: new Set(),
        };
        const allowed = verbSubFlags[verb] ?? new Set<string>();
        const positionals: string[] = [];
        let j = i + 2;
        while (j < argv.length) {
          const next = argv[j];
          if (next === undefined) break;
          if (next.startsWith('-') && !allowed.has(next)) break;
          positionals.push(next);
          j += 1;
        }
        args.worktrees = { verb, positionals };
        i = j;
        break;
      }
      case '--memory': {
        const verb = argv[i + 1];
        const known = ['list', 'show'] as const;
        if (verb === undefined || verb.startsWith('-')) {
          return {
            ok: false,
            message: `--memory requires a subcommand (${known.join('|')})`,
          };
        }
        if (!known.includes(verb as (typeof known)[number])) {
          return {
            ok: false,
            message: `unknown --memory subcommand: ${verb}. Use one of ${known.join('|')}`,
          };
        }
        // Positionals stop at any flag-shaped token. `list` takes
        // an optional scope positional; `show` takes name +
        // optional scope. Arity is enforced by the handler.
        const positionals: string[] = [];
        let j = i + 2;
        while (j < argv.length) {
          const next = argv[j];
          if (next === undefined) break;
          if (next.startsWith('-')) break;
          positionals.push(next);
          j += 1;
        }
        args.memory = { verb, positionals };
        i = j;
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
      case '--subagent-depth': {
        const value = argv[i + 1];
        if (value === undefined) {
          return {
            ok: false,
            message: '--subagent-depth requires a non-negative integer (internal flag)',
          };
        }
        // Allow 0 (top-level shape, just in case) — POSITIVE_INT
        // would reject it. Hand-validated.
        if (!/^(0|[1-9][0-9]*)$/.test(value)) {
          return {
            ok: false,
            message: `--subagent-depth must be a non-negative integer, got '${value}'`,
          };
        }
        args.subagentDepth = Number.parseInt(value, 10);
        i += 2;
        break;
      }
      case '--subagent-plan-mode':
        // Presence-only flag (no value), mirroring `--plan`.
        // Setting to false would require the absence form; we
        // never need to pass a literal "false" because the
        // child defaults to non-plan-mode when the flag isn't
        // supplied.
        args.subagentPlanMode = true;
        i += 1;
        break;
      case '--subagent-cwd-trusted':
        // Presence-only flag, same pattern as `--subagent-plan-mode`.
        // Absence = false (fail-closed). Parent only emits this
        // when its OWN bootstrap resolved the cwd as trusted
        // against `~/.config/agent/trust.json`, so the child
        // inherits the same verdict without re-resolving.
        args.subagentCwdTrusted = true;
        i += 1;
        break;
      case '--subagent-temperature': {
        const value = argv[i + 1];
        if (value === undefined) {
          return {
            ok: false,
            message: '--subagent-temperature requires a finite non-negative number (internal flag)',
          };
        }
        // Provider temperature is conventionally 0..2 but the
        // exact upper bound varies; we accept any finite
        // non-negative number and let the provider clamp/refuse.
        // Use `Number()` (NOT `Number.parseFloat`) — parseFloat
        // accepts leading-digit garbage (`'1abc'` → 1) which
        // would silently swallow a typo. `Number()` returns NaN
        // for any partial match. The explicit empty-check
        // catches the one Number() footgun: `Number('')` is 0,
        // which would otherwise pass the finite/non-negative
        // tests and land as temperature=0 silently.
        if (value.trim().length === 0) {
          return {
            ok: false,
            message: '--subagent-temperature got an empty value',
          };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return {
            ok: false,
            message: `--subagent-temperature must be a finite non-negative number, got '${value}'`,
          };
        }
        args.subagentTemperature = parsed;
        i += 2;
        break;
      }
      case '--subagent-bg-log-dir': {
        const value = argv[i + 1];
        // Reject flag-shaped values (`--subagent-bg-log-dir
        // --subagent-depth 2`) — without the `--` check, the
        // path consumer would silently swallow the next flag
        // and start the child with the WRONG runtime state.
        // Mirrors the guard on `--subagent-session-id`. Numeric
        // flags (`--subagent-depth`, `--subagent-temperature`)
        // get implicit protection via their stricter regex /
        // Number() parse; the path flag accepts any string and
        // needs the explicit guard.
        if (value === undefined || value.length === 0 || value.startsWith('--')) {
          return {
            ok: false,
            message: '--subagent-bg-log-dir requires a directory path (internal flag)',
          };
        }
        args.subagentBgLogDir = value;
        i += 2;
        break;
      }
      case '--subagent-memory-cwd': {
        const value = argv[i + 1];
        // Same guard as --subagent-bg-log-dir — flag-shaped
        // values would silently swallow the next flag.
        if (value === undefined || value.length === 0 || value.startsWith('--')) {
          return {
            ok: false,
            message: '--subagent-memory-cwd requires a directory path (internal flag)',
          };
        }
        args.subagentMemoryCwd = value;
        i += 2;
        break;
      }
      default: {
        // `--ipc=<n>` (spec IPC.md §4.2). Equals-shape because
        // the value carries protocol semantics, not arbitrary
        // user input — matching `--key=value` mirrors how
        // POSIX-style flags carry version negotiation in tools
        // like `git`. Standalone `--ipc` (no value) is also
        // accepted as version=1 for ergonomic invocations during
        // dev / manual debugging.
        if (arg === '--ipc') {
          args.subagentIpcVersion = 1;
          i += 1;
          break;
        }
        if (arg.startsWith('--ipc=')) {
          const raw = arg.slice('--ipc='.length);
          if (!/^[1-9][0-9]*$/.test(raw)) {
            return {
              ok: false,
              message: `--ipc requires a positive integer version, got '${raw}'`,
            };
          }
          args.subagentIpcVersion = Number.parseInt(raw, 10);
          i += 1;
          break;
        }
        // Anything still starting with `--` after the explicit
        // cases above is an unknown flag. Single-dash tokens
        // (`-foo`) fall through as prompt fragments.
        if (arg.startsWith('--')) {
          return { ok: false, message: `unknown flag: ${arg}` };
        }
        promptParts.push(arg);
        i += 1;
        break;
      }
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
  // `--ipc[=<n>]` is an INTERNAL flag the parent appends to the
  // child's argv when spawning. The dispatcher in cli/index.ts
  // only reads `args.subagentIpcVersion` inside the
  // `subagentSessionId !== undefined` branch — every other entry
  // path ignores it silently. Pre-fix: an operator typing `agent
  // --ipc=1 "fix the bug"` would have the flag silently consumed
  // (no error, no IPC channel actually wired anywhere), and a
  // prompt fragment that legitimately starts with `--ipc=...`
  // gets parsed as the flag and stripped from the user's prompt.
  // Both surfaces are unsupported invocations; reject loudly so
  // the misconfiguration surfaces at parse time.
  if (args.subagentIpcVersion !== undefined && args.subagentSessionId === undefined) {
    return {
      ok: false,
      message: '--ipc is an internal flag and requires --subagent-session-id',
    };
  }
  return { ok: true, args };
};

export const usage = (): string =>
  [
    'Usage: agent [options] <prompt>',
    '       agent init [--force] [--mode strict|acceptEdits]',
    '       agent init --playbooks [--force]',
    '',
    'Subcommands:',
    '  init                   Scaffold .agent/permissions.yaml (refuse-on-exists; --force overwrites)',
    '  init --playbooks       Copy the 10 canonical playbooks to .agent/agents/ (skip-if-exists; --force overwrites)',
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
    '  --worktrees <verb>     Inspect / gc subagent worktrees (verb: list, gc)',
    '  --memory <verb>        Inspect cross-session memory (verb: list [scope] | show <name> [scope])',
    '  --explain-permissions  Print the resolved permission policy + per-section layer attribution and exit',
    '  --checkpoints <cmd>    Checkpoint subcommands: list <session> | diff <session> <ckpt>',
    '                          | restore <session> <ckpt> | purge <session>',
    '  --yes, -y              Skip the bash-side-effect confirm on undo/restore',
    '  --model <id>           Model id (default: anthropic/claude-opus-4-7)',
    '  --max-steps <n>        Override harness step budget',
    '',
    'Examples:',
    '  agent init',
    '  agent "summarize the README"',
    '  agent --model openai/gpt-4o "list the source files"',
    '  agent --json "what changed in the last commit?" > events.ndjson',
    '  agent --list-sessions --json',
    '  agent --resume last "now refactor the parts you flagged"',
  ].join('\n');
