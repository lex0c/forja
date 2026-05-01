#!/usr/bin/env bun
import { parseArgs, usage } from './args.ts';

const VERSION = '0.0.0';

const main = async (): Promise<number> => {
  const parsed = parseArgs(Bun.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`forja: ${parsed.message}\n\n${usage()}\n`);
    return 1;
  }
  const { args } = parsed;

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (args.version) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return 0;
  }

  // Subagent-child mode (Step 4.2b.ii.a). The parent process
  // spawns the same binary with this flag set; the value is the
  // pre-created child session id. Short-circuits ALL other entry
  // paths — no prompt, no list-sessions, no resume, no plan.
  // Lazy import for the same reason as `./run.ts` below: keeps
  // the help/version branches above immune to provider/storage
  // wiring failures.
  if (args.subagentSessionId !== undefined) {
    const { runSubagentChild } = await import('./subagent-child.ts');
    return runSubagentChild({
      sessionId: args.subagentSessionId,
      // Pass the recursion depth carried across the subprocess
      // boundary. Defaults to 0 (top-level shape) when omitted —
      // older parent versions or programmatic callers that
      // didn't supply the flag get the conservative default.
      ...(args.subagentDepth !== undefined ? { depth: args.subagentDepth } : {}),
      // Same shape for sampling temperature — undefined means
      // "use provider default", explicit value pins the child's
      // sampling for determinism.
      ...(args.subagentTemperature !== undefined ? { temperature: args.subagentTemperature } : {}),
      // Plan-mode flag (presence-only). Forwards the parent's
      // run-wide read-only profile so the child's harness gate
      // refuses writing tools too — defense in depth for any
      // programmatic caller that invokes runSubagent with
      // planMode:true.
      ...(args.subagentPlanMode === true ? { planMode: true } : {}),
      // Per-subagent bg log directory. Threaded across by the
      // parent so background-process tools work for the child
      // without colliding with the parent's bg state.
      ...(args.subagentBgLogDir !== undefined ? { bgLogDir: args.subagentBgLogDir } : {}),
    });
  }

  // Inspection / lifecycle modes don't need a prompt:
  //   - --list-sessions: pure DB read.
  //   - --undo / --checkpoints: DB + git only, no provider call.
  // Every other entry path (normal run, --plan, --resume) does need
  // an instruction for the model. Resume's empty-prompt check fires
  // inside run() with a more specific error.
  const promptOptional =
    args.listSessions ||
    args.undo !== undefined ||
    args.checkpoints !== undefined ||
    args.worktrees !== undefined ||
    args.codeIndex !== undefined;
  if (args.prompt.length === 0 && !promptOptional) {
    process.stderr.write(`forja: missing prompt\n\n${usage()}\n`);
    return 1;
  }

  // `--code-index` short-circuits the run path. Independent of
  // bootstrap (no provider, no harness), only DB + tree-sitter
  // + FS. Mirrors the worktrees handler.
  if (args.codeIndex !== undefined) {
    const { runCodeIndexCli } = await import('./code-index.ts');
    return runCodeIndexCli({
      verb: args.codeIndex.verb as 'scan' | 'status' | 'rebuild',
      positionals: args.codeIndex.positionals,
      json: args.json === true,
      cwd: process.cwd(),
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  }

  // Lazy import: pulling `./run.ts` transitively loads provider SDKs,
  // storage, permissions — the whole stack. Keeping it behind the help/
  // version branches means a broken or missing provider dep can't break
  // `forja --help` or `forja --version`, which users hit first when
  // diagnosing install issues.
  const { run } = await import('./run.ts');
  return run({ args });
};

// `run()` has its own try/catch for expected failures (bootstrap, runtime).
// This outer wrap catches anything synchronous in `main` itself or any
// stray throw `run()` doesn't handle, so the user gets a diagnostic
// instead of Bun's default unhandled-rejection trace.
let code: number;
try {
  code = await main();
} catch (e) {
  const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
  process.stderr.write(`forja: unexpected error: ${msg}\n`);
  code = 1;
}
process.exit(code);
