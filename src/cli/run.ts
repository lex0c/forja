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
    if (existing.isSubagent) {
      // O5 C-block. Subagent sessions can't be resumed cleanly
      // because --resume restores messages but NOT the system
      // prompt or the tools whitelist — the resumed run would
      // get the parent's full registry and an empty system
      // prompt, diverging from how the subagent originally ran.
      // The audit snapshot from migration 012 enables future
      // re-hydration (O5b in BACKLOG) but the semantics need
      // proper design (budget conflicts, plan mode, missing
      // tools). For now we refuse and point at task().
      return {
        ok: false,
        message: `cannot --resume a subagent session (id ${resume} is a subagent run; use the \`task\` tool to spawn a fresh subagent instead)`,
      };
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
        includeSubagents: args.includeSubagents,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(options.bootstrapOverride?.dbPath !== undefined
          ? { dbPath: options.bootstrapOverride.dbPath }
          : {}),
        out: (s) => process.stdout.write(s),
        err: errSink,
      });
    }

    // --explain-permissions: pre-REPL inspection of the merged
    // policy + layer provenance. No provider, no DB, no harness —
    // just resolves the policy via the same resolver bootstrap
    // uses and prints it. Operator gets the same view they'd see
    // via /perms after entering the REPL, plus per-section layer
    // attribution that /perms doesn't currently surface.
    if (args.explainPermissions) {
      const cwd = options.bootstrapOverride?.cwd ?? process.cwd();
      const { runExplainPermissionsCli } = await import('./explain-permissions.ts');
      return await runExplainPermissionsCli({
        cwd,
        json: args.json,
        out: (s) => process.stdout.write(s),
        err: errSink,
      });
    }

    // `agent permission <verb>` — DB-only operator surface for the
    // v2 permission engine. Both verbs are read-only / one-shot,
    // never start a provider or session. They read the operator's
    // session DB and the per-install install_id only.
    if (args.permission !== undefined) {
      if (args.permission.verb === 'verify') {
        const { runPermissionVerify } = await import('./permission-verify.ts');
        return await runPermissionVerify({
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'rotate-chain') {
        // --reason is enforced at parse time; the type-checker doesn't
        // know that, so we assert non-null here. The chain-rotate
        // handler also re-validates defensively.
        const reason = args.permission.reason ?? '';
        const { runChainRotate } = await import('./chain-rotate.ts');
        return await runChainRotate({
          reason,
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'inspect') {
        const rotationId = Number.parseInt(args.permission.positionals[0] ?? '0', 10);
        const { runPermissionInspect } = await import('./permission-inspect.ts');
        return await runPermissionInspect({
          rotationId,
          ...(args.permission.clearQuarantine === true ? { clear: true } : {}),
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'diff') {
        // Both seqs validated at parse time. Defensive re-parse
        // keeps the runtime handler's contract tight when a
        // programmatic caller bypasses the CLI.
        const seq1 = Number.parseInt(args.permission.positionals[0] ?? '0', 10);
        const seq2 = Number.parseInt(args.permission.positionals[1] ?? '0', 10);
        const { runPermissionDiff } = await import('./permission-diff.ts');
        return await runPermissionDiff({
          seq1,
          seq2,
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'replay') {
        // <seq> positional + numeric range are enforced at parse time.
        // The handler re-parses defensively in case a programmatic
        // caller bypasses the CLI.
        const seq = Number.parseInt(args.permission.positionals[0] ?? '0', 10);
        const { runPermissionReplay } = await import('./permission-replay.ts');
        return await runPermissionReplay({
          seq,
          json: args.json,
          ...(args.permission.withoutClassifier === true ? { withoutClassifier: true } : {}),
          ...(args.permission.againstCurrentPolicy === true ? { againstCurrentPolicy: true } : {}),
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'grants') {
        // §8 grants list (slice 41). Active by default; --all
        // includes revoked + expired rows for forensic audit.
        const { runPermissionGrants } = await import('./permission-grants.ts');
        return await runPermissionGrants({
          all: args.permission.allGrants === true,
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      if (args.permission.verb === 'revoke') {
        // §8 grant revoke (slice 41). Idempotent per spec line 621;
        // <id> positional shape (ULID) re-validated in the handler.
        const id = args.permission.positionals[0] ?? '';
        const { runPermissionRevoke } = await import('./permission-revoke.ts');
        return await runPermissionRevoke({
          id,
          json: args.json,
          ...(args.permission.reason !== undefined ? { reason: args.permission.reason } : {}),
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      // The arg parser already rejects unknown verbs; this branch
      // catches the impossible-but-safe case of a verb the dispatch
      // doesn't know how to route.
      errSink(`forja permission: verb '${args.permission.verb}' has no handler\n`);
      return 1;
    }

    // `agent recap [args]` headless surface (RECAP §9). Tries to
    // bootstrap the real provider so `agent recap pr` exercises
    // the LLM surface when an API key is configured — bootstrap
    // throws inside the Anthropic factory when the key is absent,
    // which we catch and fall back to a stub. The stub fails the
    // `constrained` capability gate, so LLM-render flows degrade
    // to deterministic without crashing the headless caller.
    // Operators with `--no-llm-render` (or any deterministic-only
    // recap surface) still work without an API key — the stub is
    // sufficient for that path. `--json` toggles the four-event
    // NDJSON envelope (recap_start / recap_intermediate /
    // recap_render / recap_end); without it, the rendered text
    // streams to stdout verbatim.
    // `agent doctor [--json]` — §13 platform provisioning health check.
    // No provider, no DB, no harness — just probes the host and
    // emits a structured report. Exit 0 on all-pass, 1 if any check
    // fails.
    if (args.doctor !== undefined) {
      const { runDoctor } = await import('./doctor.ts');
      return await runDoctor({
        json: args.doctor.json,
        out: (s) => process.stdout.write(s),
        err: errSink,
      });
    }

    // `agent sandbox <verb> [--json]` — §13 guided sandbox bootstrap.
    // Slice 44: setup verb. Same lifecycle-mode shape as doctor.
    if (args.sandbox !== undefined) {
      if (args.sandbox.verb === 'setup') {
        const { runSandboxSetup } = await import('./sandbox-setup.ts');
        return await runSandboxSetup({
          json: args.sandbox.json,
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      }
      // Defensive: parser rejects unknown verbs, but route the
      // impossible case to a clean error.
      errSink(`forja sandbox: verb '${args.sandbox.verb}' has no handler\n`);
      return 1;
    }

    if (args.recap !== undefined) {
      const { runRecapHeadless } = await import('./recap-headless.ts');
      let provider: import('../providers/types.ts').Provider;
      let dbOverride: import('../storage/index.ts').DB | undefined;
      let bootstrappedDbCloser: (() => void) | undefined;
      try {
        // Empty prompt is safe — bootstrap doesn't append a user
        // message at construction time (that happens inside
        // `runAgent`). The recap path never calls `runAgent`,
        // so the bootstrap output is consumed only for `provider`
        // and `db`. Other fields (subagents, hookWarnings) are
        // ignored.
        const bootstrapInput: BootstrapInput = {
          prompt: '',
          ...(args.model !== undefined ? { modelId: args.model } : {}),
          signal: options.signal ?? new AbortController().signal,
          ...(options.bootstrapOverride ?? {}),
        };
        const result = await bootstrap(bootstrapInput);
        provider = result.config.provider;
        dbOverride = result.db;
        bootstrappedDbCloser = () => result.db.close();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // Whitelist for the deterministic-fallback path: ONLY a
        // missing-API-key throw degrades to the stub. Everything
        // else (unknown model, malformed policy YAML, broken
        // subagent loader, hook config errors, DB migration
        // failures, ...) is a real configuration bug that must
        // exit non-zero — `bootstrap()` throws for far more than
        // provider auth, and a catch-all fallback would mask
        // those errors behind "LLM render disabled" while still
        // shipping deterministic output and exit 0. CI would
        // see green on a broken repo setup.
        //
        // The three provider factories (anthropic / google /
        // openai) all throw `"<vendor> API key required ..."`
        // when the relevant env var is missing; matching that
        // prefix is the precise gate. Other auth shapes (network
        // unreachable, expired key) surface DURING the LLM call,
        // not during bootstrap, and the orchestrator handles
        // them via `provider-error` in `renderViaLlm`.
        if (!/API key required/i.test(reason)) {
          errSink(`forja recap: ${reason}\n`);
          return 1;
        }
        errSink(`forja recap: provider bootstrap failed (${reason}); LLM render disabled\n`);
        provider = {
          id: 'headless/stub',
          family: 'anthropic',
          capabilities: {
            tools: 'native',
            cache: 'server_5min',
            vision: false,
            streaming: true,
            constrained: false,
            context_window: 200_000,
            output_max_tokens: 4_096,
            cost_per_1k_input: 0,
            cost_per_1k_output: 0,
            notes: ['headless stub: bootstrap failed, LLM render disabled'],
          },
          generate: async function* () {},
          generateConstrained: () =>
            Promise.reject(new Error('headless recap: LLM render unavailable')),
          countTokens: async () => 0,
        };
      }
      try {
        return await runRecapHeadless({
          args: args.recap.args,
          json: args.json,
          ...(options.bootstrapOverride?.dbPath !== undefined
            ? { dbPath: options.bootstrapOverride.dbPath }
            : {}),
          ...(dbOverride !== undefined ? { dbOverride } : {}),
          // `cwd` drives the day/range cwd filter (RECAP §6.1
          // privacy guard). Honors a bootstrap override when tests
          // pin a fixture path; falls back to `process.cwd()` in
          // production.
          cwd: options.bootstrapOverride?.cwd ?? process.cwd(),
          provider,
          out: (s) => process.stdout.write(s),
          err: errSink,
        });
      } finally {
        // Bootstrap-owned DB handle (if any) is closed here so we
        // don't leak it on the success path. The stub-only path
        // (bootstrap failed) lets `runRecapHeadless` own its own
        // DB via `dbPath` and close it in its own try/finally.
        if (bootstrappedDbCloser !== undefined) bootstrappedDbCloser();
      }
    }

    // Checkpoint subcommands and `--undo` short-circuit the same way
    // list-sessions does: DB-only path, no bootstrap, no API key.
    // We dispatch BEFORE the resume branch because they're mutually
    // exclusive — combining `--undo` with `--resume` would be a
    // contradictory request and ambiguity here would surprise users.
    // Worktrees subcommands: same DB-only short-circuit pattern as
    // checkpoints. Runs before checkpoints/resume/run since it's
    // independent of all of them.
    if (args.worktrees !== undefined) {
      const cwd = options.bootstrapOverride?.cwd ?? process.cwd();
      const dbPathOverride = options.bootstrapOverride?.dbPath;
      const out = (s: string) => process.stdout.write(s);
      const err = (s: string) => errSink(s);
      const { runWorktreesCli } = await import('./worktrees.ts');
      return await runWorktreesCli({
        verb: args.worktrees.verb as 'list' | 'gc',
        positionals: args.worktrees.positionals,
        json: args.json,
        cwd,
        ...(dbPathOverride !== undefined ? { dbPath: dbPathOverride } : {}),
        out,
        err,
      });
    }

    // Memory inspection: same DB-only short-circuit pattern as
    // worktrees / checkpoints. Built on top of the registry the
    // model-facing memory_* tools use, so what the operator sees
    // and what the model sees stay consistent.
    if (args.memory !== undefined) {
      const cwd = options.bootstrapOverride?.cwd ?? process.cwd();
      const dbPathOverride = options.bootstrapOverride?.dbPath;
      const out = (s: string) => process.stdout.write(s);
      const err = (s: string) => errSink(s);
      const { runMemoryCli } = await import('./memory.ts');
      return await runMemoryCli({
        verb: args.memory.verb as 'list' | 'show',
        positionals: args.memory.positionals,
        json: args.json,
        cwd,
        ...(dbPathOverride !== undefined ? { dbPath: dbPathOverride } : {}),
        out,
        err,
      });
    }

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
      ...(args.acceptBrokenChain === true ? { acceptBrokenChain: true } : {}),
      ...(args.sandboxHost === true ? { sandboxHost: true } : {}),
      signal,
      ...(options.bootstrapOverride ?? {}),
    };
    const {
      config,
      db,
      lockConflicts,
      subagents,
      hookWarnings,
      critiqueWarnings,
      permissionState,
      permissionRefusingReason,
      permissionChain,
    } = await bootstrap(bootstrapInput);

    // Permission engine refused to come up — typically a broken
    // audit chain (PERMISSION_ENGINE.md §7.2). Surface the cause
    // to stderr with the recovery flag, then exit 2 (boot-blocking
    // configuration error). We close the DB explicitly so the WAL
    // doesn't linger across the failed boot.
    if (permissionState === 'refusing') {
      const reason = permissionRefusingReason ?? 'unknown';
      errSink(`forja: permission engine refused to start — ${reason}\n`);
      if (!permissionChain.ok) {
        errSink(`  chain broken at seq ${permissionChain.brokenAt} (${permissionChain.reason})\n`);
        errSink('  to continue under the known break, re-run with --accept-broken-chain\n');
        errSink(
          '  (the override is itself audited — a `chain-break-accepted` row lands before any new decisions)\n',
        );
      }
      db.close();
      return 2;
    }

    // Surface cross-scope subagent shadows. A user's
    // ~/.config/agent/agents/<name>.md silently being eclipsed by
    // a project-scope file is the kind of misconfiguration that
    // wastes hours when the author doesn't see it; one warning
    // per shadow on stderr makes the precedence visible. Gated on
    // non-JSON mode so NDJSON consumers get a pure stream — the
    // information is recoverable from the project tree anyway.
    if (!args.json) {
      for (const shadow of subagents.shadows) {
        errSink(
          `forja: subagent '${shadow.name}' from ${shadow.shadowed.sourcePath} (user) is shadowed by ${shadow.winning.sourcePath} (project)\n`,
        );
      }
    }

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

    // Surface hook config warnings (spec AGENTIC_CLI.md §10.4).
    // A malformed hooks.toml entry, an unknown event name, or an
    // unreadable file silently drops hooks from the chain — the
    // operator needs to know on stderr or they spend hours
    // wondering why their lint hook never fires. Gated on
    // non-JSON mode so NDJSON consumers get a pure stream — same
    // rationale as the subagent-shadow warnings above. The
    // information is recoverable from the hooks.toml files
    // themselves; admin-grade text doesn't belong in machine-
    // readable mode.
    if (!args.json) {
      for (const w of hookWarnings) {
        const layerFrag = w.layer !== null ? `${w.layer} ` : '';
        errSink(`forja: ${layerFrag}hook ${w.sourcePath}: ${w.message}\n`);
      }
      // Self-critique config warnings (spec AGENTIC_CLI.md §5.4).
      // The loader degrades to defaults on bad values rather than
      // aborting boot — operators need stderr visibility on
      // malformed [critique] blocks so they don't silently run
      // with mode='off' after typoing the config. Same JSON-mode
      // gating as the hook / subagent warnings above.
      for (const w of critiqueWarnings) {
        errSink(`forja: critique config: ${w}\n`);
      }
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
