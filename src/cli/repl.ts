// Interactive REPL loop. Spec: AGENTIC_CLI §17, UI.md §2 / §5.
//
// Wires the TUI building blocks (bus, focus stack, modal manager,
// renderer) to a real harness run:
//
//   stdin (raw) → keyParser → focusStack → input editor → bus events
//                                                          ↓
//                                                       reducer/renderer
//                                                          ↑
//   user:submit ──────► startTurn ──► runAgent + adapter ─┘
//                                       (HarnessEvent)
//
// One bootstrap per session — the provider, DB, registries, policies
// are stable across turns. Per-turn we rebuild a HarnessConfig from
// `baseConfig`, swapping in the new prompt and (after the first turn)
// `resumeFromSessionId` so the model sees the running conversation.
//
// Renderer-vs-shell ownership: the renderer owns raw mode + bracketed
// paste lifecycle. The REPL owns stdin data subscription, SIGINT,
// AbortController for the running turn, and the exit promise.

import { basename } from 'node:path';
import { type HarnessConfig, type HarnessResult, runAgent } from '../harness/index.ts';
import { DEFAULT_BUDGET } from '../harness/types.ts';
import { createDefaultRegistry } from '../providers/registry.ts';
import { addTrustedDir, isTrusted, trustListPath } from '../trust/index.ts';
import {
  type FocusHandler,
  type HarnessAdapter,
  type KeyEvent,
  type SessionBannerEvent,
  type UIEvent,
  applyKey,
  createBus,
  createFocusStack,
  createHarnessAdapter,
  createKeyParser,
  createModalManager,
  createRenderer,
  detectCapabilities,
  lookupToolVocab,
} from '../tui/index.ts';
import type { ParsedArgs } from './args.ts';
import { type BootstrapInput, type BootstrapResult, bootstrap } from './bootstrap.ts';
import {
  type SlashContext,
  createBuiltinRegistry,
  dispatch as dispatchSlash,
  parseSlashInput,
} from './slash/index.ts';
import { APP_NAME, VERSION } from './version.ts';

export interface RunReplOptions {
  args: ParsedArgs;
  // Test seam: skip the real bootstrap. When set, the REPL uses this
  // result instead of calling `bootstrap()` itself. Same shape the
  // real bootstrap returns.
  bootstrapOverride?: BootstrapResult;
  // Test seam: replace the harness entry. Defaults to `runAgent`.
  // Tests inject a fake that drives a scripted set of HarnessEvents
  // through `cfg.onEvent` and resolves a HarnessResult.
  runAgentOverride?: (cfg: HarnessConfig) => Promise<HarnessResult>;
  // Stdin source. Production wires to `process.stdin`; tests inject
  // an EventEmitter-backed fake that doesn't need a TTY.
  stdin?: NodeJS.ReadStream;
  // Diagnostic sink (subagent shadows, lock-conflict warnings,
  // bootstrap errors). Defaults to `process.stderr.write`.
  errSink?: (s: string) => void;
  // Force-disable TTY check. Tests set true so they can run without
  // a real terminal. Production leaves it false so REPL refuses on
  // pipes (UI.md §2: REPL requires a TTY).
  skipTtyCheck?: boolean;
  // Wall-clock source threaded through every UIEvent the REPL emits.
  // Defaults to Date.now; tests inject a counter for deterministic ts
  // ordering (and to keep timestamp assertions stable).
  now?: () => number;
  // Renderer stdout sink. When set, threaded into createRenderer in
  // place of process.stdout.write. Tests pass a string collector to
  // capture the banner / live frames without touching real stdio.
  rendererWrite?: (s: string) => void;
  // Test seam: skip the first-run trust prompt (AGENTIC_CLI §9.1).
  // Production never sets this — operator always sees the prompt
  // on first cwd visit. Tests don't drive the trust modal (the
  // existing fixtures predate it), so leaving the gate active
  // would block every REPL test on an unanswered modal.
  skipTrustPrompt?: boolean;
  // Test seam: override the trust list file path. Without this,
  // the trust-prompt tests would persist across runs in the dev
  // machine's real `~/.config/agent/trusted_dirs.json` and
  // interfere with each other (run 1 trusts /tmp/forja-repl-test,
  // run 2 finds it already trusted, modal never fires). Tests
  // point this at a temp file unique to the test. Production
  // leaves it undefined — REPL falls through to the platform
  // default via `trustListPath()`.
  trustListPathOverride?: string | null;
}

// All UIEvents flow through to the bus. Earlier this filter dropped
// `session:end` so the renderer wouldn't flip into `ended` state
// between REPL turns and hide the input box. With `state.ended` no
// longer gating draws (renderer.ts), the filter became unnecessary —
// session:end now produces the turn-end marker (`Cogitated for X`,
// UI.md §3.2) on every turn, the input stays visible during the
// gap between session:end and the next user:submit, and one-shot
// callers still get their final marker.
const filterUiEvent = (_event: UIEvent): boolean => true;

export const runRepl = async (options: RunReplOptions): Promise<number> => {
  const { args } = options;
  const errSink = options.errSink ?? ((s: string) => process.stderr.write(s));
  const stdin = options.stdin ?? process.stdin;
  const now = options.now ?? ((): number => Date.now());

  const caps = detectCapabilities();
  // Both ends must be TTYs. caps.isTTY is derived from stdout only
  // (UI.md §1: "rendering target"); stdin is a separate concern
  // because raw-mode keystroke parsing requires an actual terminal
  // — a piped/redirected stdin (e.g. `echo prompt | agent`) has no
  // keyboard at all, so entering REPL mode would land in an
  // unusable interactive loop with no way to type. Fail fast with
  // the advertised error rather than wedging the process.
  //
  // Production stdin is `process.stdin` which exposes `isTTY?: boolean`
  // (undefined when not a TTY, true when it is). Test fixtures bypass
  // both checks via skipTtyCheck.
  const stdinIsTTY = (stdin as { isTTY?: boolean }).isTTY === true;
  if (options.skipTtyCheck !== true && (!caps.isTTY || !stdinIsTTY)) {
    errSink('forja: interactive mode requires a TTY (stdin/stdout must be a terminal)\n');
    return 1;
  }

  // Bootstrap once. The empty initial prompt is a placeholder — the
  // harness loop tolerates an empty `userPrompt` (skips appending the
  // user message), and we override `userPrompt` per turn before
  // calling `runAgent`. Bootstrap allocates the DB, opens the
  // provider, resolves policies, loads subagents — all stable across
  // turns within a session.
  let bootstrapped: BootstrapResult;
  try {
    bootstrapped =
      options.bootstrapOverride ??
      bootstrap({
        prompt: '',
        ...(args.model !== undefined ? { modelId: args.model } : {}),
        ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
        ...(args.plan === true ? { plan: true } : {}),
      } satisfies BootstrapInput);
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    errSink(`forja: ${msg}\n`);
    return 1;
  }
  const { config: baseConfig, db, modelId, lockConflicts, subagents, policyLayers } = bootstrapped;

  // Surface the same warnings the one-shot path does. Operators get
  // them once at REPL boot rather than per turn.
  for (const shadow of subagents.shadows) {
    errSink(
      `forja: subagent '${shadow.name}' from ${shadow.shadowed.sourcePath} (user) is shadowed by ${shadow.winning.sourcePath} (project)\n`,
    );
  }
  for (const c of lockConflicts) {
    errSink(
      `forja: permission policy: ${c.section} locked by ${c.lockedBy}; ${c.attemptedBy}'s override dropped\n`,
    );
  }

  const project = basename(baseConfig.cwd) || baseConfig.cwd;

  // Snapshot the adapter context fresh for every turn. Mutation slash
  // commands (/model, /budget, /plan) edit baseConfig at runtime —
  // capturing model/budget/planMode at boot would freeze the
  // adapter's view, so subsequent session:start and step:budget
  // events would surface the OLD values while the harness executes
  // with the NEW ones. The footer / status indicators would then
  // diverge from actual run behavior. Reading baseConfig + provider
  // at startTurn time keeps the displayed cap and model honest.
  //
  // `model` reads from baseConfig.provider.id rather than the
  // boot-time `modelId` local because /model swaps the provider
  // object; the local goes stale immediately after the first
  // /model invocation.
  const buildAdapterCtx = () => ({
    profile: 'autonomous' as const,
    project,
    model: baseConfig.provider.id,
    maxSteps: baseConfig.budget?.maxSteps ?? DEFAULT_BUDGET.maxSteps,
    ...(baseConfig.budget?.maxCostUsd !== undefined
      ? { maxCostUsd: baseConfig.budget.maxCostUsd }
      : {}),
    ...(baseConfig.planMode === true ? { planMode: true } : {}),
  });

  const bus = createBus();
  const focusStack = createFocusStack();
  const renderer = createRenderer({
    bus,
    caps,
    stdin,
    ...(options.rendererWrite !== undefined ? { write: options.rendererWrite } : {}),
  });
  // Modal manager owns the permission/trust/etc modal lifecycle.
  // The harness ↔ modal bridge runs through `confirmPermission` (defined
  // below): the harness's permission engine returns `{kind: 'confirm'}`,
  // invokeTool calls `cfg.confirmPermission(...)`, that bridge calls
  // `modalManager.askPermission(...)`, modal-manager emits `permission:ask`
  // → reducer paints → operator answers via focus stack → modal-manager
  // resolves the askPermission promise → confirmPermission returns
  // boolean to the harness. End-to-end wiring is exercised by the
  // confirmPermission-bridge test in tests/cli/repl.test.ts.
  //
  // onInterrupt is a forward reference: triggerInterrupt is defined
  // further down (it depends on abortController + softStopController
  // which are declared per-turn). The let-binding indirection lets
  // modal-manager call into the real interrupt path lazily — by the
  // time a modal opens and the operator hits Ctrl+C, the per-turn
  // controllers exist and triggerInterrupt does the right thing.
  // No-op default for the (rare) call-before-startTurn race.
  let onModalInterrupt: () => void = () => undefined;
  const modalManager = createModalManager({
    bus,
    focusStack,
    onInterrupt: () => onModalInterrupt(),
  });

  let running = false;
  let lastSessionId: string | null = null;
  // Two controllers per turn (spec UI.md §3 soft/hard distinction):
  //   abortController     → hard, preempts in-flight work (mid-tool kill,
  //                         provider-stream cancel). Fires on second
  //                         Esc/Ctrl+C, or first when the operator
  //                         explicitly wants immediate cancellation.
  //   softStopController  → cooperative, asks the loop to exit at the
  //                         next step boundary. Fires on first Esc/Ctrl+C.
  //                         Tool in flight finishes, results land,
  //                         no next provider call.
  // Both reset per-turn in startTurn so a soft-stop from a prior turn
  // can't leak forward.
  let abortController: AbortController | null = null;
  let softStopController: AbortController | null = null;
  // The promise returned by the in-flight runAgent (already wrapped
  // in `.catch().finally()`, so awaiting never throws). `shutdown`
  // awaits this before closing the DB so the harness's async cleanup
  // (final persistence, audit) doesn't race a closed handle.
  let runningPromise: Promise<void> | null = null;
  // Per-turn token. Each `startTurn` mints a fresh Symbol and stores
  // it as both the closure-local id of that turn AND `activeTurnToken`
  // (the slot for "which turn currently owns the shared state below").
  // Finalizers compare their captured id against this slot and bail
  // if a newer turn has taken over. Without the gate, the optimization
  // that flips `running=false` on session_finished (so the operator
  // can submit/interrupt without waiting for the harness's outer-
  // finally cleanup) creates a window where Turn N+1 can start
  // before Turn N's runAgent Promise settles — when N's finalizer
  // eventually runs, it would otherwise clobber N+1's `running`,
  // `abortController`, etc., breaking interrupts and allowing
  // concurrent submits.
  let activeTurnToken: symbol | null = null;
  let exiting = false;
  let exitCode = 0;
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r;
  });

  const onHarnessEvent = (
    adapter: HarnessAdapter,
    event: Parameters<NonNullable<HarnessConfig['onEvent']>>[0],
  ): void => {
    try {
      for (const u of adapter.translate(event)) {
        if (filterUiEvent(u)) bus.emit(u);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit({ type: 'warn', ts: now(), message: `adapter error: ${msg}` });
    }
    // Flip user-facing turn state on session_finished, NOT on the
    // runAgent Promise resolve. The harness's outer finally awaits
    // checkpoint purge + bg cleanup (CHECKPOINTS §2.5: "could spend
    // seconds in ref deletion") AFTER session_finished is emitted —
    // those are bookkeeping, not turn-visible work. Pre-fix the
    // Promise chain held `running=true` through that window, so the
    // operator who saw `Cogitated for Xs` rendered and started typing
    // immediately found that Enter was silently gated and Ctrl+C
    // routed to triggerInterrupt-on-resolved-abort (no-op). Visibly
    // identical to "input frozen" for several seconds.
    //
    // Cumulative totals + lastSessionId are also rolled up here so a
    // back-to-back submit (operator hits Enter the moment Cogitated
    // appears) sees the correct prior session id for resume — the
    // runAgent Promise's `.then` would not have fired yet under the
    // old timing.
    if (event.type === 'session_finished') {
      running = false;
      lastSessionId = event.result.sessionId;
      cumulative.costUsd += event.result.costUsd;
      cumulative.steps += event.result.steps;
      cumulative.turns += 1;
    }
  };

  // Bridge for the harness's confirm decisions: extracts a one-line
  // subject from args via the per-tool vocab so the modal carries
  // something readable as the command, then awaits the user's choice
  // through modalManager. Lives at the REPL layer because it crosses
  // the harness/TUI seam — the harness has no business importing
  // tool-vocab.ts.
  const confirmPermission = async (req: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
    prompt: string;
  }): Promise<boolean> => {
    const vocab = lookupToolVocab(req.toolName);
    let command = '';
    try {
      command = vocab.subject?.(req.args) ?? '';
    } catch {
      command = '';
    }
    if (command === '') {
      // Fallback: cap a JSON dump so the modal at least has something
      // to display when the vocab has no extractor for this tool.
      try {
        command = JSON.stringify(req.args);
      } catch {
        command = '<unserializable args>';
      }
      if (command.length > 80) command = `${command.slice(0, 80)}…`;
    }
    const answer = await modalManager.askPermission({
      toolName: req.toolName,
      command,
      cwd: req.cwd,
      reason: req.prompt,
    });
    // Map the spec-shape answer to the harness's boolean contract.
    // 'session-allow' currently behaves like 'yes' — the policy
    // mutation that would persist a session-layer rule is deferred
    // (TODO 1.d.7). When that lands, this branch writes the rule
    // before returning true.
    return answer === 'yes' || answer === 'session-allow';
  };

  const startTurn = (text: string): void => {
    if (running || exiting) return;
    running = true;
    // Mint a fresh token for this turn and claim ownership of the
    // shared state slots (running / abortController / runningPromise).
    // The finalizer below compares against `activeTurnToken` to refuse
    // mutations once a newer turn has taken over.
    const myToken = Symbol('turn');
    activeTurnToken = myToken;
    abortController = new AbortController();
    softStopController = new AbortController();
    const adapter = createHarnessAdapter(buildAdapterCtx());
    const cfg: HarnessConfig = {
      ...baseConfig,
      userPrompt: text,
      signal: abortController.signal,
      softStopSignal: softStopController.signal,
      onEvent: (e) => onHarnessEvent(adapter, e),
      confirmPermission,
      ...(lastSessionId !== null ? { resumeFromSessionId: lastSessionId } : {}),
    };
    const runAgentImpl = options.runAgentOverride ?? runAgent;
    // Cumulative totals + lastSessionId are rolled up in
    // `onHarnessEvent` on `session_finished` (synchronous with
    // Cogitated rendering) — see the comment there. The .then()
    // here intentionally does no bookkeeping; it exists only so
    // .catch can intercept rejections from runAgent itself
    // (provider crash before any harness event, etc.).
    runningPromise = runAgentImpl(cfg)
      .then(() => undefined)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        bus.emit({ type: 'error', ts: now(), message: msg });
      })
      .finally(() => {
        // Token gate: only mutate shared state if THIS turn is still
        // the active one. If `session_finished` already flipped
        // `running=false` and the operator submitted a follow-up
        // turn, `activeTurnToken` now belongs to that newer turn —
        // resetting `running`/abortController here would mid-flight
        // clobber its state, breaking interrupts and allowing
        // concurrent submits. Bail in that case; the newer turn's
        // own finalizer will clean up when its own time comes.
        //
        // The defensive `running=false` (for the rare path where
        // runAgent rejects before any session event) is still
        // covered: in that case session_finished never fired, so
        // this turn IS still active, and the cleanup runs.
        if (activeTurnToken !== myToken) return;
        running = false;
        abortController = null;
        softStopController = null;
        runningPromise = null;
        activeTurnToken = null;
      });
  };

  // Async cleanup. Only called via `requestShutdown` below — the
  // sync gate is the source of truth for "we're exiting"; this
  // function does the work without needing its own guard.
  const shutdown = async (): Promise<void> => {
    if (abortController !== null) abortController.abort();
    // Cancel any pending idle-exit-gate timer so a 2s setTimeout
    // doesn't outlive the REPL and leak a node handle (visible in
    // tests as Bun's "open handles" warning, and in production as
    // a delayed `interrupt:exit-cancel` emit on a closed bus).
    if (exitArmTimer !== null) {
      clearTimeout(exitArmTimer);
      exitArmTimer = null;
    }
    // Let the harness's async cleanup settle on the aborted signal
    // before tearing down the DB. Without this await, db.close() can
    // land before the harness flushes its final message/audit rows
    // and SQLite throws on the closed handle. The promise is already
    // .catch()ed so awaiting never throws.
    if (runningPromise !== null) await runningPromise;
    modalManager.close();
    renderer.close();
    stdin.removeListener('data', onData);
    // Drop the lone-ESC drain timer if it's pending — leaks otherwise
    // (Bun would surface as an "open handle" warning in tests; in
    // production it'd just delay process exit by up to ESC_DRAIN_MS).
    cancelDrain();
    if (typeof stdin.pause === 'function') stdin.pause();
    db.close();
    resolveExit();
  };

  // Synchronous shutdown gate. Sets `exiting=true` BEFORE any await
  // so a follow-up keystroke (Enter after /quit, second Ctrl+C)
  // can't slip past the running/exiting check in the editor handler
  // / startTurn. Idempotent — second call no-ops.
  const requestShutdown = (): void => {
    if (exiting) return;
    exiting = true;
    void shutdown();
  };

  // Soft/hard interrupt ladder shared by Esc (editor's interruptSoft
  // signal), Ctrl+C in raw mode (editor's cancelInput signal), and
  // SIGINT (process signal — fires when stdin is NOT in raw mode, or
  // from a kill -INT). All three converge here so the spec's
  // single-keybinding-pair semantics (UI.md §5.4) hold uniformly:
  // first tap is cooperative (softStopController.abort), second tap
  // is preemptive (abortController.abort). Caller decides when to
  // invoke (gated on `running`); this helper assumes a turn is in
  // flight and the controllers are non-null. The reducer's
  // softInterrupted flag is the single source of truth for
  // distinguishing first tap from second.
  const triggerInterrupt = (): void => {
    const level: 'soft' | 'hard' = renderer.state().softInterrupted ? 'hard' : 'soft';
    bus.emit({ type: 'interrupt', ts: now(), level });
    if (level === 'hard' && abortController !== null) {
      abortController.abort();
    } else if (level === 'soft' && softStopController !== null) {
      softStopController.abort();
    }
  };

  // Idle Ctrl+C double-tap exit gate (UI.md §5.4). First press at
  // idle/empty-buffer arms the gate; the footer flips to
  // `Press Ctrl-C again to exit` (warn) for the EXIT_ARM_WINDOW_MS window.
  // A second press inside the window exits 130; any other keystroke
  // disarms (handled by the editor handler), and a timeout cancels.
  // Closure-local `exitArmedAt` is the source of truth for the
  // window check; the reducer's `state.exitArmed` is just for the
  // footer cue. They drift only briefly — the boundary resets in
  // session:start/end keep the reducer side honest, and the local
  // staleness self-resolves via the timestamp comparison.
  const EXIT_ARM_WINDOW_MS = 2000;
  let exitArmedAt: number | null = null;
  let exitArmTimer: ReturnType<typeof setTimeout> | null = null;
  const armExit = (): void => {
    exitArmedAt = Date.now();
    bus.emit({ type: 'interrupt:exit-arm', ts: now() });
    if (exitArmTimer !== null) clearTimeout(exitArmTimer);
    exitArmTimer = setTimeout(() => {
      exitArmTimer = null;
      if (exitArmedAt !== null) {
        exitArmedAt = null;
        bus.emit({ type: 'interrupt:exit-cancel', ts: now() });
      }
    }, EXIT_ARM_WINDOW_MS);
  };
  const cancelExitArm = (): void => {
    if (exitArmedAt === null) return;
    exitArmedAt = null;
    if (exitArmTimer !== null) {
      clearTimeout(exitArmTimer);
      exitArmTimer = null;
    }
    bus.emit({ type: 'interrupt:exit-cancel', ts: now() });
  };
  // Idle Ctrl+C handler shared by editor (raw mode) and SIGINT
  // (non-raw / external kill). Returns true when the call resulted
  // in an exit decision (caller should consume / not fall through).
  const handleIdleInterrupt = (): boolean => {
    if (exitArmedAt !== null && Date.now() - exitArmedAt <= EXIT_ARM_WINDOW_MS) {
      exitCode = 130;
      requestShutdown();
      return true;
    }
    armExit();
    return false;
  };
  // Resolve the modal-manager's forward reference now that the real
  // interrupt path is defined. From here on, Ctrl+C with a modal up
  // resolves the modal AND fires the interrupt ladder atomically —
  // no draft loss, no second-tap requirement.
  //
  // Gate on `running`: triggerInterrupt's contract assumes a turn
  // is in flight (it emits an `interrupt` UIEvent that flips
  // `softInterrupted` in the renderer). When a modal opens BEFORE
  // any turn started — the boot-time trust prompt does this — and
  // the operator hits Ctrl+C, calling triggerInterrupt unconditionally
  // would paint the "esc again to force" footer cue with no run
  // behind it. Modal still resolves 'cancel' via the manager's own
  // path; we just skip the spurious interrupt emit.
  onModalInterrupt = () => {
    if (running) triggerInterrupt();
  };

  // Slash command registry + cumulative tracker for /cost. Built once
  // per REPL session — the registry is stable; cumulative is mutated
  // by startTurn's success branch and read by /cost.
  const slashRegistry = createBuiltinRegistry();
  const cumulative = { costUsd: 0, steps: 0, turns: 0 };
  // Single registry instance for the REPL's lifetime. /model uses it
  // for the lookup + factory; bootstrap built its own at boot for
  // initial provider resolution. Both call sites are independent —
  // there's no shared state, so two instances are functionally
  // equivalent (the registry is just a Map of model entries).
  const modelRegistry = createDefaultRegistry();

  const slashCtx: SlashContext = {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative,
    now,
    requestShutdown,
    // Closure over the REPL's `running` flag — fresh read per call so
    // a slash command queued before a turn starts but executed after
    // observes the post-startTurn state.
    isRunning: () => running,
    modelRegistry,
  };

  // Tracks whether the popover is currently open. Local to the REPL
  // so the editor handler doesn't need to read renderer.state().slash
  // out of band — that's an implicit coupling on the bus's
  // synchronous-emit semantics. Mirrors the reducer's view of slash
  // state but updated synchronously alongside our emits.
  let slashOpen = false;

  // Recompute slash autocomplete after every input change. Emits the
  // suggestion list (or empty + -1 to clear) so the reducer mirrors
  // it onto state.slash for the renderer.
  const updateSlashSuggestions = (value: string): void => {
    const parsed = parseSlashInput(value);
    if (parsed === null) {
      // Not slash mode. Only emit a clear when slash was previously
      // open — avoids spamming the bus on every plain keystroke.
      if (slashOpen) {
        bus.emit({ type: 'slash:update', ts: now(), suggestions: [], selectedIdx: -1 });
        slashOpen = false;
      }
      return;
    }
    const matches = slashRegistry.complete(parsed.name);
    bus.emit({
      type: 'slash:update',
      ts: now(),
      suggestions: matches.map((c) => ({ name: c.name, description: c.description })),
      selectedIdx: matches.length > 0 ? 0 : -1,
    });
    slashOpen = true;
  };

  // Lookup a command by name with fallback to the registry's
  // case-sensitive lookup AND a case-insensitive fallback through
  // complete(). Operator typing `/Help` should hit the `help`
  // command (autocomplete already showed `help`); without this
  // fallback the dispatcher gets `Help` and returns "unknown".
  const resolveCommandName = (typedName: string): string => {
    if (slashRegistry.lookup(typedName) !== undefined) return typedName;
    const matches = slashRegistry.complete(typedName);
    // Exact (case-insensitive) match takes precedence over prefix —
    // `/Help` should resolve to `help`, not to whichever `helpfoo`
    // command might exist later.
    const exact = matches.find((c) => c.name.toLowerCase() === typedName.toLowerCase());
    if (exact !== undefined) return exact.name;
    return typedName; // dispatcher will surface "unknown command"
  };

  // Input editor focus handler. Sits at the bottom of the focus
  // stack — modal-manager pushes its own handler on top when a modal
  // opens, intercepting keys before the editor sees them.
  const editorHandler: FocusHandler = (key: KeyEvent): boolean => {
    // Shutdown gate: while exiting, swallow all keys so a follow-up
    // keystroke after /quit / Ctrl+C doesn't slip through and start
    // a new turn.
    if (exiting) return true;

    // Slash mode intercepts navigation / Tab / Enter / Esc BEFORE
    // the editor sees them. Other keys (printables, backspace, etc.)
    // fall through so the user can keep typing the command name.
    //
    // Two signals matter independently:
    //
    //   - `slashState` (renderer state) is non-null while the
    //     popover has at least one match. Drives Up/Down/Tab —
    //     those keys only make sense when there's something to
    //     navigate.
    //
    //   - `bufferIsSlash` is true while the input buffer starts
    //     with `/`. Drives Enter and Escape — pressing Enter on
    //     a slash command must NEVER fall through to user:submit
    //     (would dispatch `/doesnotexist` to the provider, burning
    //     tokens), even when the popover collapsed because the
    //     typed name has zero matches.
    const slashState = renderer.state().slash;
    const currentBuffer = renderer.state().input.value;
    const bufferIsSlash = parseSlashInput(currentBuffer) !== null;
    if ((slashState !== null || bufferIsSlash) && key.kind === 'key') {
      const k = key.name;
      // Navigation keys require a live popover (matches present).
      if (slashState !== null && k === 'tab' && slashState.selectedIdx >= 0) {
        const pick = slashState.suggestions[slashState.selectedIdx];
        if (pick !== undefined) {
          const newValue = `/${pick.name} `;
          bus.emit({ type: 'input:update', ts: now(), value: newValue, cursor: newValue.length });
          updateSlashSuggestions(newValue);
        }
        return true;
      }
      if (slashState !== null && k === 'up') {
        const idx = Math.max(0, slashState.selectedIdx - 1);
        if (idx !== slashState.selectedIdx) {
          bus.emit({
            type: 'slash:update',
            ts: now(),
            suggestions: slashState.suggestions,
            selectedIdx: idx,
          });
        }
        return true;
      }
      if (slashState !== null && k === 'down') {
        const idx = Math.min(slashState.suggestions.length - 1, slashState.selectedIdx + 1);
        if (idx !== slashState.selectedIdx) {
          bus.emit({
            type: 'slash:update',
            ts: now(),
            suggestions: slashState.suggestions,
            selectedIdx: idx,
          });
        }
        return true;
      }
      // Escape clears slash mode regardless of popover state — also
      // covers the unknown-command case where the buffer starts with
      // `/` but slashState is null.
      if (k === 'escape') {
        bus.emit({ type: 'slash:update', ts: now(), suggestions: [], selectedIdx: -1 });
        slashOpen = false;
        bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
        return true;
      }
      // Enter dispatches the slash command. Critical: this branch
      // fires even when slashState is null (zero matches) — the
      // dispatcher surfaces "unknown command" as scrollback instead
      // of letting the buffer fall through to user:submit and burn
      // a provider call.
      if (k === 'enter') {
        const val = renderer.state().input.value;
        const parsed = parseSlashInput(val);
        if (parsed === null || parsed.name === '') {
          // Bare `/` + Enter: nothing to execute. Falling through
          // would let applyKey emit submit:'/' and dispatch a turn
          // sending '/' to the model. Clear input + slash mode and
          // consume the keystroke.
          bus.emit({ type: 'slash:update', ts: now(), suggestions: [], selectedIdx: -1 });
          slashOpen = false;
          bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
          return true;
        }
        // Echo the slash command as a user-submit (visual divider
        // in scrollback so the operator sees what they ran), then
        // dispatch. The reducer's user:submit branch clears the
        // input — including the unknown-command case, so a typo
        // like `/doesnotexist` doesn't linger in the buffer for
        // the next Enter to retry. Resolve the typed name through
        // the registry's case-insensitive matcher so `/Help` lands
        // on `help` (autocomplete already shows `help`; bug if the
        // dispatcher disagrees).
        const resolvedName = resolveCommandName(parsed.name);
        bus.emit({ type: 'user:submit', ts: now(), text: val });
        bus.emit({ type: 'slash:update', ts: now(), suggestions: [], selectedIdx: -1 });
        slashOpen = false;
        void dispatchSlash(
          { name: resolvedName, args: parsed.args },
          { registry: slashRegistry, ctx: slashCtx },
        );
        return true;
      }
    }

    const current = renderer.state().input;

    // Footer's `? for help` cue (UI.md §4.10.6) needs to actually
    // do something. Pressing `?` with an empty buffer dispatches the
    // /help slash command — same effect as typing `/help` + Enter,
    // but with a single keystroke. Once there's any content in the
    // buffer (operator started typing a question that begins with
    // `?`), `?` falls through as a literal character.
    if (current.value === '' && key.kind === 'char' && key.char === '?' && !key.ctrl && !key.alt) {
      // Disarm the exit gate before returning. UI.md §5.4 says any
      // non-Ctrl+C key disarms; the `?` shortcut is one of those keys
      // and the early return below skips the cancelExitArm() call
      // that lives further down in this handler. Without this,
      // pressing Ctrl+C → `?` → Ctrl+C inside the 2s window would
      // still exit 130 — the operator hit a non-interrupt key
      // expecting to cancel the gate, but the gate stayed armed.
      cancelExitArm();
      void dispatchSlash({ name: 'help', args: [] }, { registry: slashRegistry, ctx: slashCtx });
      return true;
    }

    const result = applyKey(current, key);

    // Disarm the exit gate on any keystroke that ISN'T a fresh Ctrl+C.
    // The interrupt branch below handles arm/exit itself; everything
    // else (typing, Enter, Esc, Ctrl+D, etc.) is "operator did
    // something other than re-press Ctrl+C", which the spec says
    // disarms (§5.4 "qualquer tecla, incluindo digitação").
    if (result.cancelInput !== 'interrupt') {
      cancelExitArm();
    }

    // Skip input:update when the buffer didn't change (Enter, Esc,
    // Ctrl+C with empty input, etc). The reducer's user:submit branch
    // clears state.input on its own — no need to first set it then
    // immediately clear.
    if (result.next.value !== current.value || result.next.cursor !== current.cursor) {
      bus.emit({
        type: 'input:update',
        ts: now(),
        value: result.next.value,
        cursor: result.next.cursor,
      });
      updateSlashSuggestions(result.next.value);
    }

    // Enter while a turn is running is ignored — no double-submit. The
    // typed text stays in the buffer (applyKey doesn't clear; only the
    // user:submit reducer would, which we're not emitting). The user
    // can hit Enter again once the turn ends.
    if (result.submit !== undefined && !running) {
      bus.emit({ type: 'user:submit', ts: now(), text: result.submit.text });
      startTurn(result.submit.text);
    }

    // Ctrl+C with empty buffer:
    //   - running → soft/hard interrupt ladder (same as Esc and SIGINT).
    //   - idle → double-tap gate (UI.md §5.4): first press arms,
    //     second within 2s exits 130. Synchronous shutdown gate
    //     (`exiting` set in requestShutdown) keeps a stray follow-up
    //     keystroke from racing past the check.
    if (result.cancelInput === 'interrupt') {
      if (running) {
        triggerInterrupt();
      } else {
        handleIdleInterrupt();
      }
    }

    // Ctrl+D with empty buffer: shell EOF convention — direct exit, no
    // double-tap gate. Operators expect `^D` as an explicit "I'm done"
    // signal; making them press it twice would surprise. While running,
    // route to the interrupt ladder for consistency with `^C` + Esc.
    if (result.cancelInput === 'eof') {
      if (running) {
        triggerInterrupt();
      } else {
        exitCode = 130;
        requestShutdown();
      }
    }

    // First Esc → cooperative soft stop: emit interrupt UIEvent
    // (footer flips to "esc again to force") and abort the
    // softStopController. Harness checks softStopSignal at the next
    // step boundary — current tool finishes, results land, no next
    // provider call (spec UI.md §3 soft semantics).
    //
    // Second Esc while softInterrupted is already true → hard
    // interrupt: aborts the underlying signal, preempting in-flight
    // work (mid-tool kill, provider stream cancel). Honors the
    // "esc again to FORCE" cue's promise.
    //
    // Esc with no run in progress is a no-op (the editor's own
    // slash-mode Esc handler intercepted before reaching here).
    if (result.interruptSoft === true && running) {
      triggerInterrupt();
    }

    return true;
  };
  focusStack.push(editorHandler);

  // Stdin pump: feed bytes into the parser, dispatch each parsed key
  // through the focus stack. Bracketed paste handled inside the
  // parser (one `paste` event per chunk).
  //
  // Lone-ESC drain. The parser holds a single `\x1b` waiting to
  // disambiguate between an Escape keypress and the start of a CSI
  // / SS3 / Alt+char sequence — both begin with `\x1b`. Without a
  // delayed drain, an Esc keystroke alone never resolves: the
  // buffer holds it indefinitely, the soft-interrupt cue never
  // fires, AND the next keystroke combines with the held ESC to
  // emit Alt+<char> instead of `<char>` — input visibly stops
  // accepting input. Convention (xterm KeyboardWait): if no follow-
  // up byte arrives within ~25-100ms, treat the held ESC as a
  // standalone Escape keypress. We pick 30ms — short enough that
  // the operator doesn't notice the delay on a deliberate Esc,
  // long enough to absorb the latency between the leader and the
  // params of a multi-byte sequence delivered across two `data`
  // events (e.g., over SSH).
  const parser = createKeyParser();
  const ESC_DRAIN_MS = 30;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelDrain = (): void => {
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  };
  const onData = (chunk: Buffer): void => {
    // Panic key (Ctrl+\\, byte 0x1c). Bypasses every gate (running,
    // modal, focus stack, exit-arm timer, shutdown awaits) and exits
    // immediately. Convention from POSIX SIGQUIT — "I really want
    // out". In raw mode the terminal driver delivers 0x1c as a
    // literal byte (signal generation disabled by setRawMode), so
    // Node never sees a SIGQUIT — we have to recognize the byte
    // ourselves. Trade-off accepted: any in-flight turn's audit/DB
    // state may stay 'running' since we skip shutdown's cleanup
    // chain. That's the explicit cost of having a guaranteed
    // escape hatch when the normal interrupt ladder doesn't work.
    //
    // Checked BEFORE the exiting guard / parser / focusStack so it
    // works even when the rest of the pipeline is wedged.
    if (chunk.includes(0x1c)) {
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
        // Disable bracketed paste so the operator's shell isn't
        // left in paste mode after our exit. `\x1b[?2004l` is the
        // standard sequence; written directly to bypass any
        // higher-level wrapper that might be in a broken state.
        process.stdout.write('\x1b[?2004l');
        process.stderr.write('\nforja: panic exit (Ctrl+\\)\n');
      } catch {
        // Ignore — we're exiting regardless.
      }
      process.exit(130);
    }
    if (exiting) return;
    cancelDrain();
    const events = parser.feed(chunk);
    for (const ev of events) focusStack.dispatch(ev);
    if (parser.bufferLength() > 0) {
      drainTimer = setTimeout(() => {
        drainTimer = null;
        if (exiting) return;
        // Narrow drain: ONLY resolve the lone-ESC ambiguity. The
        // full `parser.drain()` (used at shutdown) clears paste
        // state too — calling it here would truncate a paste
        // delivered in chunks separated by more than ESC_DRAIN_MS
        // (slow SSH links, large clipboard payloads), silently
        // corrupting submitted input. `tryResolveLoneEsc` is the
        // surgical version: emits Escape iff the buffer is exactly
        // `\x1b` outside of paste mode, no-op otherwise.
        const drained = parser.tryResolveLoneEsc();
        for (const ev of drained) focusStack.dispatch(ev);
      }, ESC_DRAIN_MS);
    }
  };
  stdin.on('data', onData);
  if (typeof stdin.resume === 'function') stdin.resume();

  // SIGINT path. Fires when stdin is NOT in raw mode (e.g., during
  // certain modal lifecycles where the renderer pauses raw input)
  // or from an external `kill -INT` / supervisor / `trap` handler.
  //
  // Running: route to the interrupt ladder (same as editor's
  // cancelInput=interrupt path). Soft → hard escalation works
  // identically whether the signal arrived via raw stdin or via
  // the kernel.
  //
  // Idle: terminate immediately with exit 130 (POSIX SIGINT). The
  // double-tap exit gate (UI.md §5.4) is interactive UX — it
  // protects the operator from a stray Ctrl+C keystroke. External
  // SIGINT senders (supervisors, automation, IDE stop buttons,
  // `kill -INT $pid`) expect one signal to stop the process; if
  // we routed those through the gate, a single `kill -INT` would
  // arm the gate and silently disarm 2s later, leaving the process
  // alive — a regression for any caller that wraps the agent. Raw
  // Ctrl+C keystrokes still land as `cancelInput=interrupt` via
  // the editor handler, which DOES use the gate.
  const sigintHandler = (): void => {
    if (running) {
      triggerInterrupt();
    } else {
      exitCode = 130;
      requestShutdown();
    }
  };
  process.on('SIGINT', sigintHandler);

  // Welcome banner (UI.md §4.10.9). Goes to scrollback before any
  // live frame so it sits at the top of the conversation transcript.
  // Env summary entries land conditionally — D68 says omit when
  // there's nothing useful to communicate. Memory entry count
  // omitted until the registry exposes a sync count method.
  const providerCaps = baseConfig.provider.capabilities;
  // UI.md §4.10.9 discriminates env entries: `flag` for binary
  // capability indicators (rendered as `✓ name` in success palette),
  // `meta` for non-binary key:value (rendered dim).
  const env: SessionBannerEvent['env'] = [];
  if (subagents.byName.size > 0) {
    env.push({ kind: 'meta', key: 'subagents', value: String(subagents.byName.size) });
  }
  // `checkpoints` flag was removed from the banner — operator
  // marked it as not useful. The capability still works (harness
  // creates checkpoints when conditions are met); it just doesn't
  // announce itself at boot. If a future smoke audit wants the
  // signal back, push another flag entry here.
  bus.emit({
    type: 'session:banner',
    ts: now(),
    app: APP_NAME,
    version: VERSION,
    model: modelId,
    contextWindow: providerCaps.context_window,
    maxOutputTokens: baseConfig.budget?.maxOutputTokensPerCall ?? providerCaps.output_max_tokens,
    cwd: baseConfig.cwd,
    env,
  });

  // Trust prompt (AGENTIC_CLI.md §9.1). First time the operator
  // opens forja in a directory, ask before running anything that
  // could touch the filesystem. The list of trusted dirs persists
  // in `~/.config/agent/trusted_dirs.json` (or the platform
  // equivalent); subsequent boots from the same cwd skip the
  // prompt.
  //
  // Headless / pipe modes: skip the prompt entirely. The REPL is
  // gated to TTY-only earlier (line ~150), so by the time we land
  // here we know an interactive terminal is available. If trust
  // storage path can't be derived (no HOME, no XDG_CONFIG_HOME,
  // no APPDATA — pathological env), fall through to per-session
  // trust: the prompt fires on every boot and approval doesn't
  // persist. Caller still gets the safety prompt; only the
  // memoization is lost.
  const trustPath =
    options.trustListPathOverride !== undefined ? options.trustListPathOverride : trustListPath();
  const cwdAlreadyTrusted = trustPath !== null && isTrusted(trustPath, baseConfig.cwd);
  if (options.skipTrustPrompt !== true && !cwdAlreadyTrusted) {
    const answer = await modalManager.askTrust({ path: baseConfig.cwd });
    if (answer !== 'yes') {
      // Operator declined or pressed Esc. Exit cleanly without
      // entering the REPL: db.close, renderer.close, raw mode off.
      // Use the shutdown path so every cleanup hook runs (mirror of
      // /quit). exitCode=0 for "user opted out", not an error.
      exitCode = 0;
      requestShutdown();
      await exitPromise;
      return exitCode;
    }
    if (trustPath !== null) {
      try {
        addTrustedDir(trustPath, baseConfig.cwd);
      } catch (e) {
        // Persistence failure shouldn't block the session — operator
        // already approved, just lose the memoization. Surface as
        // a warn so a chronic config issue (read-only HOME, full
        // disk) is visible without being fatal.
        const msg = e instanceof Error ? e.message : String(e);
        bus.emit({
          type: 'warn',
          ts: now(),
          message: `failed to persist trust for ${baseConfig.cwd}: ${msg} (will re-prompt next boot)`,
        });
      }
    }
  }

  // Permission posture hint. When no project policy file
  // contributed, the operator runs under strict + empty rules
  // (default-deny everything). Without this cue, the first
  // tool call returns `Denied` and looks like a bug — surface
  // the configuration gap up front. Only fires when no project
  // layer was found AND no enterprise/user layer either; if any
  // layer exists, the operator already opted in to a custom
  // posture and doesn't need the hint. Routed as `error` (not
  // `info` or `warn`) because under default-deny the very next
  // tool call fails — severity matches the red palette and the
  // operator scans the boot scrollback for red first.
  if (policyLayers.length === 0) {
    bus.emit({
      type: 'error',
      ts: now(),
      message:
        "no permission policy found — strict default-deny is active. Create '.agent/permissions.yaml' or run /perms to inspect.",
    });
  }

  // Initial frame: emit one input:update with the empty buffer so the
  // renderer draws the `> ` prompt before the user types. Without
  // this the screen sits blank until the first keystroke.
  bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });

  await exitPromise;
  process.removeListener('SIGINT', sigintHandler);
  return exitCode;
};
