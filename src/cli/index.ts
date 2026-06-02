#!/usr/bin/env bun
import { parseArgs, usage } from './args.ts';
import type { InitOptions } from './init.ts';
import { VERSION } from './version.ts';

// §13.7 broker-worker self-exec. The spawn broker's only way to
// reach the worker module in a compiled binary is to re-invoke the
// same `process.execPath` (the binary itself can't address its own
// embedded `/$bunfs/.../worker.ts` via `bun run`). The parent
// process sets `FORJA_BROKER_WORKER=1` on the spawn env; we detect
// the flag BEFORE parseArgs (the worker process gets zero CLI args
// and would otherwise hit the empty-prompt REPL gate) and hand off
// to the worker's exported entry point.
//
// In source checkout the parent uses `bun run src/broker/worker.ts`
// directly, so this branch never fires there — `import.meta.main`
// inside worker.ts handles top-level execution on that path. The
// env-driven branch and the script-driven branch produce identical
// behavior; the worker doesn't care how it was invoked.
if (process.env.FORJA_BROKER_WORKER === '1') {
  const { runWorkerProcess } = await import('../broker/worker.ts');
  await runWorkerProcess();
  process.exit(0);
}

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

  // §13.5 first-boot nudge (slice 46). Fires when install_id doesn't
  // exist yet, EXCEPT on §13 verbs (welcome/doctor/sandbox) — the
  // operator is already on the setup path and pointing them back to
  // it would be noise. Goes to stderr so stdout stays pure for JSON
  // consumers; one-shot per install (install_id gets created by the
  // next normal bootstrap and the nudge stops firing).
  const inSetupFlow =
    args.welcome === true ||
    args.doctor !== undefined ||
    args.sandbox !== undefined ||
    args.purge !== undefined ||
    args.gc !== undefined;
  if (!inSetupFlow) {
    const { isFirstBoot } = await import('../permissions/install_id.ts');
    if (isFirstBoot()) {
      process.stderr.write(
        'forja: first run detected — try `agent welcome` for a setup walkthrough.\n',
      );
    }
  }

  // `agent init` — scaffold the .agent/ bootstrap bundle
  // (permissions.yaml, .gitignore, config.toml, agents/*.md).
  // Pure filesystem work, no provider/DB needed; same lazy-import
  // posture as the other handlers below so a broken provider dep
  // can't break this. Lands BEFORE the subagent-child branch
  // because init is mutually exclusive with every other run mode
  // and the parser already rejected combos.
  if (args.init !== undefined) {
    const { runInit } = await import('./init.ts');
    // Build the options without explicit-undefined keys to satisfy
    // `exactOptionalPropertyTypes` on `InitOptions.only` / `.force`.
    const initOptions: InitOptions = {
      cwd: process.cwd(),
      mode: args.init.mode,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    };
    if (args.init.only !== undefined) initOptions.only = args.init.only;
    if (args.init.force !== undefined) initOptions.force = args.init.force;
    return runInit(initOptions);
  }

  // `agent purge [--force] [--json] [--no-audit]` — §2.1.2
  // project-scope FS reset. Pure-FS in the dry-run path; the
  // force path also writes one append-only audit row to the
  // global DB. Lazy import: pulling `./purge.ts` brings in
  // storage + install_id, so we keep the help/version/etc.
  // branches above immune to those deps failing to load. Like
  // `init`, this verb is mutually exclusive with every other
  // run mode (the parser rejected combos at parseArgs time).
  if (args.purge !== undefined) {
    const { runPurge } = await import('./purge.ts');
    return runPurge({
      cwd: process.cwd(),
      force: args.purge.force,
      json: args.purge.json,
      noAudit: args.purge.noAudit,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  }

  // `agent gc [--force] [--json] [--table=X]` — §2.1.3 retention
  // sweep age-based on the global DB. Phase 1 covers 4 tables.
  // Lazy-import shape mirrors purge: keeps help/version/etc.
  // immune to storage / audit-config dependency failures.
  if (args.gc !== undefined) {
    const { runGcCli } = await import('./gc.ts');
    return runGcCli({
      cwd: process.cwd(),
      force: args.gc.force,
      json: args.gc.json,
      tables: args.gc.tables,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  }

  // Subagent-child mode. The parent process
  // spawns the same binary with this flag set; the value is the
  // pre-created child session id. Short-circuits ALL other entry
  // paths — no prompt, no list-sessions, no resume.
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
      // Provider reasoning-effort inherited from the parent's `/effort`
      // (internal flag `--subagent-effort`). Carries only the reasoning
      // axis — operational caps stay per-playbook.
      ...(args.subagentProviderEffort !== undefined
        ? { providerEffort: args.subagentProviderEffort }
        : {}),
      // Trust verdict from the parent's bootstrap. Spec §9 trust
      // is per-project; the child runs under the parent's
      // resolved verdict instead of re-resolving from disk
      // (worktree paths are never on the trust list, so a
      // re-resolve would default-deny every worktree subagent).
      ...(args.subagentCwdTrusted === true ? { cwdTrusted: true } : {}),
      // S5 CRIT/H3: shared-corpus trust verdict from parent. Set
      // when the parent's probe returned non-confirmed; child
      // mirrors the fail-closed posture on eager-load AND
      // retrieve_context.
      ...(args.subagentSharedScopeOffline === true ? { sharedScopeOffline: true } : {}),
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
  // `--resume` with empty prompt now also enters the REPL — the
  // operator's intent is "reopen the conversation visually and keep
  // going", not "run one headless turn against the prior session".
  // run.ts still rejects --resume + empty prompt in the headless
  // path it owns (--json / piped); that branch is unreachable here
  // because the REPL gate fires first.
  const promptOptional =
    args.listSessions ||
    args.undo !== undefined ||
    args.checkpoints !== undefined ||
    args.worktrees !== undefined ||
    args.memory !== undefined ||
    args.explainPermissions ||
    // `agent recap [args]` is the headless surface for the recap
    // slash (RECAP §9). It carries its own positional verbs in
    // `args.recap.args` and never expects a free-text prompt — the
    // empty-prompt check below would otherwise route it into the
    // REPL TTY gate or the `--json requires a prompt` rejection.
    args.recap !== undefined ||
    // `agent doctor` (§13 slice 43) is the headless platform-health
    // surface. No prompt, no provider, no REPL — same exemption as
    // the other lifecycle modes above.
    args.doctor !== undefined ||
    // `agent sandbox setup` (§13 slice 44) — same lifecycle-mode
    // exemption as doctor. Pure informational verb.
    args.sandbox !== undefined ||
    // `agent welcome` (§13.5 slice 45) — first-boot walkthrough.
    // Composes doctor + sandbox setup; same lifecycle-mode shape.
    args.welcome === true ||
    // `agent permission <verb>` (PERMISSION_ENGINE.md operator
    // surface) — every verb is DB-only and one-shot; no prompt,
    // no provider, no REPL. Pre-fixup the empty-prompt branch
    // hit before the run.ts dispatcher could route the verb, so
    // `agent permission verify --json` produced "--json requires
    // a prompt" instead of the chain integrity report.
    args.permission !== undefined ||
    // `agent purge` (§2.1.2) — operator-fired FS reset. Lifecycle
    // mode: no prompt, no provider, no REPL. Same exemption shape
    // as init/doctor/sandbox/permission.
    args.purge !== undefined ||
    // `agent gc` (§2.1.3) — retention sweep. Lifecycle mode; no
    // prompt, no provider, no REPL.
    args.gc !== undefined;
  if (args.prompt.length === 0 && !promptOptional) {
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
