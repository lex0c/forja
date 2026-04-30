import { type HarnessResult, runAgent } from '../harness/index.ts';
import { defaultDbPath, getSession, listSessions, migrate, openDb } from '../storage/index.ts';
import type { ParsedArgs } from './args.ts';
import { type BootstrapInput, bootstrap } from './bootstrap.ts';
import { runCheckpointsCli } from './checkpoints.ts';
import { runListSessions } from './list-sessions.ts';
import { createJsonRenderer } from './output/json.ts';
import { createPlainRenderer } from './output/plain.ts';
import type { OutputRenderer } from './output/types.ts';
import { installSignalHandler } from './signal.ts';

export interface RunOptions {
  args: ParsedArgs;
  // Test seams: defaults derive from args + process state in production.
  bootstrapOverride?: Partial<BootstrapInput>;
  signal?: AbortSignal;
  // Inject a renderer to capture output instead of writing to process
  // streams. Skips the json/plain selection branch when set.
  rendererOverride?: OutputRenderer;
  // Sink for the catastrophic "forja: <error>" line printed when
  // bootstrap or runAgent throws unexpectedly. Defaults to
  // process.stderr; tests inject a string collector.
  errSink?: (s: string) => void;
}

const pickRenderer = (args: ParsedArgs): OutputRenderer => {
  if (args.json) return createJsonRenderer();
  // ANSI colors only when stderr is a TTY and NO_COLOR is unset.
  // Stdout might be piped (`agent "..." | tee`); stderr is where indicators
  // live, so its TTY-ness is what matters for color decisions.
  const useColor = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;
  return createPlainRenderer({ useColor });
};

// Maps harness exit reasons to process exit codes per spec §2.2.
//   0  done                                 (success)
//   1  task error (provider, tool errors)   (generic failure)
//   2  exhausted (budget caps)              (per spec)
//  130 interrupted (SIGINT, abort)          (Unix convention)
export const exitCodeFor = (result: HarnessResult): number => {
  switch (result.status) {
    case 'done':
      return 0;
    case 'exhausted':
      return 2;
    case 'interrupted':
      return 130;
    case 'error':
      return 1;
  }
};

// Resolve a `--resume` CLI value into an actual session id. 'last'
// becomes the most recently started session FOR THE CURRENT CWD;
// anything else is taken as a literal id and verified to exist.
// Returns null + error message when the resolution fails so the
// caller can print a clean diagnostic and exit non-zero.
//
// The cwd filter on 'last' matters in multi-repo usage: without
// it, 'last' picks the newest session globally, which runAgent
// then rejects with a cwd-mismatch error even though a valid
// session for the current repo might be just one slot down. The
// resolver scopes 'last' to the active cwd so the user sees the
// behavior they expect (continue the latest session of THIS
// project).
//
// Literal ids stay unfiltered — if the user typed an id, they
// know what they want. Cross-cwd literal resume still trips
// runAgent's cwd guard and surfaces a clean error.
//
// Lives outside the main `run()` flow because list-sessions and
// resume both need the same DB-only pre-step before deciding
// whether to enter the harness path.
const resolveResumeId = (
  resume: string,
  dbPath: string,
  cwd: string,
): { ok: true; id: string } | { ok: false; message: string } => {
  const db = openDb(dbPath);
  try {
    migrate(db);
    if (resume === 'last') {
      const sessions = listSessions(db, { limit: 1, cwd });
      const first = sessions[0];
      if (first === undefined) {
        return {
          ok: false,
          message: `no sessions found to resume (with 'last') for cwd '${cwd}'`,
        };
      }
      return { ok: true, id: first.id };
    }
    // Literal id path. Validate upfront so a typo'd id fails with
    // a clean errSink message before bootstrap. Without this
    // pre-check, the throw inside runAgent's init block lands in
    // guardedFinish and surfaces as an internalError exit (1)
    // with no diagnostic on stderr — confusing for users.
    const existing = getSession(db, resume);
    if (existing === null) {
      return { ok: false, message: `session ${resume} not found` };
    }
    return { ok: true, id: resume };
  } finally {
    db.close();
  }
};

export const run = async (options: RunOptions): Promise<number> => {
  const { args } = options;
  const errSink = options.errSink ?? ((s: string) => process.stderr.write(s));
  // Single top-level try wraps both the preflight branches
  // (--list-sessions short-circuit, --resume id resolution) AND
  // the main run path. Without this, an exception from openDb
  // inside the preflight (corrupt DB, unreadable path) escaped
  // run() instead of routing through errSink → exit 1, breaking
  // the contract that run() always returns a number. Signal
  // handler is installed inside the try only when the main run
  // path needs it — list-sessions is synchronous and short, no
  // need to wire SIGINT for it.
  let restoreSignal: () => void = () => undefined;

  try {
    // List-sessions short-circuit. No provider, no policy engine, no
    // harness — only the DB. Lets `agent --list-sessions` work
    // without an API key set, which is the right shape for an
    // inspection tool.
    if (args.listSessions) {
      return runListSessions({
        json: args.json,
        ...(options.bootstrapOverride?.dbPath !== undefined
          ? { dbPath: options.bootstrapOverride.dbPath }
          : {}),
        out: (s) => process.stdout.write(s),
      });
    }

    // Checkpoint subcommands and `--undo` short-circuit the same way
    // list-sessions does: DB-only path, no bootstrap, no API key.
    // We dispatch BEFORE the resume branch because they're mutually
    // exclusive — combining `--undo` with `--resume` would be a
    // contradictory request and ambiguity here would surprise users.
    if (args.checkpoints !== undefined || args.undo !== undefined) {
      const cwd = options.bootstrapOverride?.cwd ?? process.cwd();
      const dbPathOverride = options.bootstrapOverride?.dbPath;
      const out = (s: string) => process.stdout.write(s);
      const err = (s: string) => errSink(s);
      if (args.undo !== undefined) {
        return await runCheckpointsCli({
          verb: 'undo',
          positionals: [args.undo],
          json: args.json,
          yes: args.yes,
          cwd,
          ...(dbPathOverride !== undefined ? { dbPath: dbPathOverride } : {}),
          out,
          err,
        });
      }
      // args.checkpoints is set; verb has been validated by the parser.
      const ckpt = args.checkpoints;
      if (ckpt !== undefined) {
        return await runCheckpointsCli({
          verb: ckpt.verb as 'list' | 'diff' | 'restore' | 'purge',
          positionals: ckpt.positionals,
          json: args.json,
          yes: args.yes,
          cwd,
          ...(dbPathOverride !== undefined ? { dbPath: dbPathOverride } : {}),
          out,
          err,
        });
      }
    }

    // Resume: require a follow-up prompt — without it there's no new
    // user turn to drive the loop, and the model would just see its
    // own last assistant message replayed. Resolve 'last' / id BEFORE
    // bootstrap so a typo fails fast with a clean error.
    let resumeFromSessionId: string | undefined;
    if (args.resume !== undefined) {
      if (args.prompt.length === 0) {
        errSink('forja: --resume requires a follow-up prompt\n');
        return 1;
      }
      const dbPath = options.bootstrapOverride?.dbPath ?? defaultDbPath();
      // Use the same cwd resolution bootstrap will — without this
      // the resume resolution and the harness's cwd guard might
      // disagree on which directory is "current".
      const cwd = options.bootstrapOverride?.cwd ?? process.cwd();
      const resolved = resolveResumeId(args.resume, dbPath, cwd);
      if (!resolved.ok) {
        errSink(`forja: ${resolved.message}\n`);
        return 1;
      }
      resumeFromSessionId = resolved.id;
    }

    const renderer = options.rendererOverride ?? pickRenderer(args);

    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;
    // In production, wire SIGINT to abort. Tests pass their own signal and
    // skip the handler.
    if (options.signal === undefined) {
      restoreSignal = installSignalHandler(controller);
    }

    const bootstrapInput: BootstrapInput = {
      prompt: args.prompt,
      ...(args.model !== undefined ? { modelId: args.model } : {}),
      ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
      ...(args.plan === true ? { plan: true } : {}),
      ...(resumeFromSessionId !== undefined ? { resumeFromSessionId } : {}),
      signal,
      ...(options.bootstrapOverride ?? {}),
    };
    const { config, db, lockConflicts } = bootstrap(bootstrapInput);

    // Plan mode indicator on stderr — stdout stays a clean
    // transcript / NDJSON. Skip in JSON mode (per spec §2.2 stdout
    // is NDJSON only; admin-style output goes to stderr regardless).
    if (args.plan === true) {
      errSink('[plan mode] read-only run; write tools are blocked at the harness\n');
    }

    // Surface lock-conflict warnings before the run starts. Each
    // conflict means an enterprise/user/project layer marked a
    // section as locked and a lower-precedence layer tried to
    // override it; the override was dropped from the merged policy.
    // Admins need this signal — silently swallowing it defeats the
    // whole point of `locked: true`.
    for (const c of lockConflicts) {
      errSink(
        `⚠ permission policy: ${c.section} locked by ${c.lockedBy}; ${c.attemptedBy}'s override dropped\n`,
      );
    }

    const cfg = {
      ...config,
      onEvent: (e: Parameters<OutputRenderer['onEvent']>[0]) => renderer.onEvent(e),
    };
    try {
      const result = await runAgent(cfg);
      renderer.flush();
      return exitCodeFor(result);
    } finally {
      db.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    errSink(`forja: ${msg}\n`);
    return 1;
  } finally {
    restoreSignal();
  }
};
