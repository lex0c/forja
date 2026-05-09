#!/usr/bin/env bun
import { parseArgs, usage } from './args.ts';
import { VERSION } from './version.ts';

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

  // `agent init` — scaffold .agent/permissions.yaml. Pure
  // filesystem work, no provider/DB needed; same lazy-import
  // posture as the other handlers below so a broken provider
  // dep can't break this. Lands BEFORE the subagent-child
  // branch because init is mutually exclusive with every
  // other run mode and the parser already rejected combos.
  if (args.init !== undefined) {
    const { runInit } = await import('./init.ts');
    return runInit({
      cwd: process.cwd(),
      force: args.init.force,
      mode: args.init.mode,
      playbooks: args.init.playbooks,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  }

  // Subagent-child mode. The parent process
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
      // Trust verdict from the parent's bootstrap. Spec §9 trust
      // is per-project; the child runs under the parent's
      // resolved verdict instead of re-resolving from disk
      // (worktree paths are never on the trust list, so a
      // re-resolve would default-deny every worktree subagent).
      ...(args.subagentCwdTrusted === true ? { cwdTrusted: true } : {}),
      // Per-subagent bg log directory. Threaded across by the
      // parent so background-process tools work for the child
      // without colliding with the parent's bg state.
      ...(args.subagentBgLogDir !== undefined ? { bgLogDir: args.subagentBgLogDir } : {}),
      // Parent's cwd. Anchors the child's MemoryRegistry roots so
      // worktree-isolated subagents share the parent's memory
      // tree (project_local + project_shared anchored at the
      // parent's repo, not the worktree's cache dir).
      ...(args.subagentMemoryCwd !== undefined ? { memoryCwd: args.subagentMemoryCwd } : {}),
      // IPC protocol version. When the parent set `--ipc=<n>`,
      // the child opens the parent↔child channel (spec
      // docs/spec/IPC.md). Older parents that don't pass the
      // flag leave this undefined and the child runs in legacy
      // SQLite-only mode — no live event channel.
      ...(args.subagentIpcVersion !== undefined ? { ipcVersion: args.subagentIpcVersion } : {}),
    });
  }

  // Inspection / lifecycle modes don't need a prompt:
  //   - --list-sessions: pure DB read.
  //   - --undo / --checkpoints: DB + git only, no provider call.
  // For everything else, an empty prompt enters the interactive
  // REPL (UI.md §2 — `forja` with no prompt opens the inline TUI).
  // Resume's empty-prompt check fires inside run() with a more
  // specific error so the user knows --resume needs a follow-up.
  const promptOptional =
    args.listSessions ||
    args.undo !== undefined ||
    args.checkpoints !== undefined ||
    args.worktrees !== undefined ||
    args.memory !== undefined ||
    args.explainPermissions;
  if (args.prompt.length === 0 && !promptOptional && args.resume === undefined) {
    // JSON mode + REPL is meaningless (NDJSON consumers don't have
    // a TTY to type into) — refuse rather than open a TTY-only loop
    // that nobody can drive.
    if (args.json) {
      process.stderr.write(
        `forja: --json requires a prompt (REPL mode is TTY only)\n\n${usage()}\n`,
      );
      return 1;
    }
    // TTY gate BEFORE loading the REPL. ./repl.ts has top-level
    // imports of the harness/provider/storage stack — if any of
    // those fail to load (broken native binding, missing peer dep,
    // partial install), the dynamic import throws and the outer
    // catch surfaces "unexpected error" instead of the clean TTY
    // diagnostic. The fail-fast path matters most for non-
    // interactive invocations (CI / piped stdin / `forja` typed by
    // accident in a tmux scratch buffer) — exactly the cases where
    // the install-troubleshooting message should land without
    // touching the runtime stack.
    //
    // The check is duplicated inside repl.ts (defense in depth and
    // for callers that import runRepl programmatically). Keep both
    // — pre-import and inside-the-function — emitting the IDENTICAL
    // message so behavior doesn't shift when the import does
    // succeed.
    const stdinIsTTY = (process.stdin as { isTTY?: boolean }).isTTY === true;
    const stdoutIsTTY = (process.stdout as { isTTY?: boolean }).isTTY === true;
    if (!stdinIsTTY || !stdoutIsTTY) {
      process.stderr.write(
        'forja: interactive mode requires a TTY (stdin/stdout must be a terminal)\n',
      );
      return 1;
    }
    const { runRepl } = await import('./repl.ts');
    return runRepl({ args });
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
