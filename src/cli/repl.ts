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

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveProviderEffort } from '../harness/effort.ts';
import { type HarnessConfig, type HarnessResult, runAgent } from '../harness/index.ts';
import { effectiveBudget, resolveMaxOutputTokens } from '../harness/types.ts';
import { dispatchChain } from '../hooks/dispatcher.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/types.ts';
import type { PolicySource } from '../permissions/index.ts';
import { createDefaultRegistry } from '../providers/registry.ts';
import { buildAutoTerse } from '../recap/auto-display.ts';
import { stripAnsi } from '../sanitize/index.ts';
import {
  HISTORY_CAP,
  appendHistory,
  historyOptOutReason,
  loadHistory,
  searchHistory,
} from '../storage/history.ts';
import { closeDb } from '../storage/index.ts';
import { createContextPinsStore } from '../storage/repos/context-pins.ts';
import { completeSession, createSession } from '../storage/repos/sessions.ts';
import { settleRunningSubagentHandles } from '../storage/repos/subagent-handles.ts';
import { runSubagent } from '../subagents/index.ts';
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
import { maybeEmitHistoryBanner } from './history-banner.ts';
import { concatQueuedBodies } from './inbox-drain.ts';
import { replaySessionMessages } from './resume-replay.ts';
import { resolveResumeIdOnDb } from './run.ts';
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
  // Test seam: replace the `bootstrap` function call. Defaults to
  // the real `bootstrap` import. Used by the regression test for
  // pre-bootstrap-stack cleanup on bootstrap throw — passes a fn
  // that throws so the catch path runs without standing up real
  // provider/DB/registries. `bootstrapOverride` (a precomputed
  // result) takes precedence when set; this seam only fires when
  // the override is absent.
  bootstrapFn?: (input: BootstrapInput) => Promise<BootstrapResult> | BootstrapResult;
  // Test seam: replace the harness entry. Defaults to `runAgent`.
  // Tests inject a fake that drives a scripted set of HarnessEvents
  // through `cfg.onEvent` and resolves a HarnessResult.
  runAgentOverride?: (cfg: HarnessConfig) => Promise<HarnessResult>;
  // Test seam: replace the subagent runtime entry used by the
  // playbook dispatcher. Defaults to `runSubagent`. Tests inject a
  // fake to capture the input (especially `onPermissionAsk`) without
  // spinning up a child Bun subprocess.
  runSubagentOverride?: typeof runSubagent;
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
  // Minimum on-screen time (ms) for a live tool card before its
  // `tool:end` removes it (see RendererOptions.toolMinDisplayMs).
  // Defaults to 0 (off) so REPL tests drive tool flows synchronously;
  // the production entrypoint (cli/index.ts) passes the real value.
  toolMinDisplayMs?: number;
  // Test seam: run an operator `!cmd` shell command. Defaults to a real
  // `Bun.spawn` of `bash -c <command>` in the REPL cwd with the
  // operator's full env (the shell-style `!` escape — operator's own
  // shell, NOT the agent's permission engine / sandbox). Tests inject a
  // fake to avoid spawning a real shell.
  execBash?: (
    command: string,
    cwd: string,
    // Called once with a kill switch for the spawned command's process
    // group, so the interrupt path (Ctrl+C / Esc) can terminate it. The
    // default impl wires it to a group kill; a test seam may ignore it
    // or use it to resolve on demand.
    onKillable?: (kill: (signal: NodeJS.Signals) => void) => void,
  ) => Promise<{ output: string; exitCode: number }>;
  // Test seam: override the operator `!cmd` timeout (default 120s) so a
  // test can prove the kill path terminates a hung command without
  // waiting two minutes.
  operatorBashTimeoutMs?: number;
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
  // Test seam: shrink the trust modal's auto-reject window.
  // Production uses 5 minutes (spec UI.md §5.5 rule 6); tests need
  // a tiny value (~50ms) so a regression test for the timeout path
  // doesn't have to wait that long. Undefined leaves the spec
  // default in place.
  trustPromptTimeoutMs?: number;
  // Test seam: shrink the history cap so a regression test for
  // mirror-trim doesn't need to drive 10k+ submits. Threaded into
  // every appendHistory / loadHistory call AND the in-memory mirror
  // trim so the two stay in lockstep. Production omits this and
  // inherits HISTORY_CAP from `src/storage/history.ts` (env-overridable
  // via FORJA_HISTORY_SIZE at module load).
  historyCapOverride?: number;
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

// Anti-spoof transform applied to every string field a child
// subagent contributes to a permission modal an operator will
// see (spec docs/spec/IPC.md §7). Three layers:
//   1. stripAnsi removes ESC-prefixed control sequences so the
//      child can't paint fake colors / cursor moves.
//   2. Replace newline / tab / CR with a single space so a
//      multi-line payload can't split across modal rows and
//      mimic separator lines or fake warnings. stripAnsi does
//      NOT cover \x0a (LF) — its character class excludes
//      \x09-\x0a-\x0d to keep ordinary text intact — so the
//      explicit collapse is necessary.
//   3. Length cap prevents a child from emitting kilobyte-long
//      strings that would push subsequent modal content off
//      screen or overflow the rule width. 200 chars covers
//      every legitimate display surface (longest is the
//      command preview; the JSON-fallback path already caps
//      at 80) with headroom.
// Used ONLY for the subagent-proxy code path; parent's own
// confirms come from operator-authored prompts and stay raw.
// Exported for unit testing — kept in this module rather than
// `src/sanitize/` because it encodes a UI-specific contract
// (modal display surface widths + multi-row mimicry defense)
// that has no other consumer.
export const SUBAGENT_DISPLAY_MAX = 200;
export const sanitizeForSubagentDisplay = (raw: string): string => {
  let cleaned = stripAnsi(raw).replace(/[\r\n\t]+/g, ' ');
  if (cleaned.length > SUBAGENT_DISPLAY_MAX) {
    cleaned = `${cleaned.slice(0, SUBAGENT_DISPLAY_MAX - 1)}…`;
  }
  return cleaned;
};

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

  // ─── Pre-bootstrap stack ─────────────────────────────────────────
  // Renderer + bus + modal-manager are constructed BEFORE bootstrap
  // so the first-run trust prompt can render without bootstrap
  // having read any cwd-rooted files. Spec §9.1 makes the trust
  // gate an upstream check: an untrusted workspace must not
  // influence startup parsing (project policy.yaml, subagent
  // markdown, memory tree) before the operator approves the
  // directory. Reproduced bug shape: `bootstrap()` calls
  // `resolvePolicy({ cwd })` and `loadSubagents({ cwd })` which
  // both read files from the (possibly malicious) cwd; with the
  // prompt landing AFTER bootstrap, the operator's "no" answer
  // happened only after those parses had already executed.
  //
  // None of these constructors depend on bootstrap output —
  // verified by inspection. The stdin pump's onData closure
  // references `running`, `exiting`, etc. which we declare upfront
  // with safe defaults; bootstrap-dependent state (running turn,
  // abort controllers, slash registry) is registered later.
  const bus = createBus();
  const focusStack = createFocusStack();
  const renderer = createRenderer({
    bus,
    caps,
    stdin,
    // Defer raw mode + bracketed paste until we have a focus
    // handler ready (see `subscribeStdin` below). Activating raw
    // mode at construction would suppress Ctrl+C → SIGINT for the
    // entire bootstrap window — operator couldn't break out of a
    // hung policy parse, slow `git rev-parse`, etc. Manual mode
    // keeps the cooked-mode SIGINT path live until we're ready
    // to take stdin.
    inputMode: 'manual',
    // Keep fast tool cards (read / write / quick bash) on screen long
    // enough to perceive — without this they complete inside one frame
    // budget and never paint. See RendererOptions.toolMinDisplayMs.
    // Default 0 (off) here so the REPL test-suite drives tool flows
    // synchronously; the production entrypoint (cli/index.ts) wires the
    // real value.
    toolMinDisplayMs: options.toolMinDisplayMs ?? 0,
    ...(options.rendererWrite !== undefined ? { write: options.rendererWrite } : {}),
  });
  // Forward reference: triggerInterrupt is defined post-bootstrap
  // (it depends on per-turn abortController). Default no-op covers
  // calls that arrive during the trust modal — there's no run to
  // interrupt yet.
  let onModalInterrupt: () => void = () => undefined;
  const modalManager = createModalManager({
    bus,
    focusStack,
    onInterrupt: () => onModalInterrupt(),
  });

  // Stdin pump + parser. The same `onData` covers both the trust
  // prompt phase and the full REPL — only the focus-stack
  // contents differ between phases (trust modal pushes a handler
  // during askTrust; the editor handler is registered later).
  // Lifecycle state (`exiting`, `running`) is hoisted here too so
  // both phases share one source of truth.
  let exiting = false;
  let exitCode = 0;
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r;
  });
  let running = false;
  // Mirrors `running` for slash playbook dispatches. Foreground
  // turns and slash playbooks share the provider, the DB, and the
  // permission engine — running them concurrently would interleave
  // tool calls and audit rows under the same parent session, which
  // the playbook layer's "one-at-a-time" contract was meant to
  // prevent. The slash `exec` body checks `ctx.isRunning()`
  // synchronously before awaiting `runPlaybook`; flipping this flag
  // SYNCHRONOUSLY at the top of `runPlaybook` (before its first
  // await) ensures a second slash dispatch fired in the same Enter
  // burst sees `isRunning() === true` and refuses cleanly.
  let playbookRunning = false;
  // True while an operator `!cmd` shell command is in flight. Part of
  // `isBusy` so it serializes against agent turns and playbooks (and
  // against a second `!` command) — one operator action at a time.
  let operatorBashRunning = false;
  // Kill switch for the in-flight `!cmd`, handed up by the executor so
  // the interrupt path (Ctrl+C / Esc) can terminate the command's
  // process group instead of waiting out the timeout. Null when no
  // command runs (or the test seam didn't expose one).
  let operatorBashKill: ((signal: NodeJS.Signals) => void) | null = null;
  // First-tap latch for the `!cmd` interrupt ladder: SIGINT on the
  // first Ctrl+C/Esc, SIGKILL on a repeat if the command ignored it.
  let operatorBashInterrupted = false;
  // Single busy predicate threaded through every submit gate
  // (foreground startTurn, Enter in the editor, Enter in
  // reverse-search) AND the slash dispatcher's `isRunning()`
  // closure. Without it, the foreground submit paths would gate
  // on `running` alone and let a normal turn start mid-playbook
  // — the exact serialization the playbookRunning flag was
  // supposed to enforce, defeated at every other entry point.
  const isBusy = (): boolean => running || playbookRunning || operatorBashRunning;
  // Mirror `isBusy()` into renderer state so the bash-mode visuals gate
  // on the same condition the submit path uses (render/mode.ts). Call
  // after EVERY mutation of `running` / `playbookRunning` /
  // `operatorBashRunning` — the dedup makes spurious calls cheap, but a
  // MISSED call leaves `state.busy` stale (a `!` would show shell UI for
  // a command Enter refuses). Deduped so only real transitions emit.
  let lastBusyEmitted = false;
  const syncBusy = (): void => {
    const b = isBusy();
    if (b === lastBusyEmitted) return;
    lastBusyEmitted = b;
    bus.emit({ type: 'busy:change', ts: now(), busy: b });
  };

  const ESC_DRAIN_MS = 30;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelDrain = (): void => {
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  };
  const parser = createKeyParser();
  const onData = (chunk: Buffer): void => {
    if (chunk.includes(0x1c)) {
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
        process.stdout.write('\x1b[?2004l');
        process.stderr.write('\nforja: panic exit (Ctrl+\\)\n');
      } catch {}
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
        const drained = parser.tryResolveLoneEsc();
        for (const ev of drained) focusStack.dispatch(ev);
      }, ESC_DRAIN_MS);
    }
  };

  // Lazy stdin subscription. The pump is fully wired (parser, drain,
  // panic key) but we DON'T attach to stdin yet — `focusStack` is
  // empty during pre-bootstrap, and dispatching to an empty stack
  // silently drops the event. Subscribing now would race against
  // any I/O tick that fires between `stdin.resume()` and the
  // editor handler joining the stack: a key typed during bootstrap
  // would be parsed and lost instead of buffered for the editor.
  //
  // Two real subscription sites: (1) inside the trust prompt block
  // AFTER `modalManager.askTrust` queues its handler (askTrust
  // pushes onto the focus stack synchronously before returning the
  // promise), and (2) post-bootstrap right after
  // `focusStack.push(editorHandler)`. The flag prevents a double-
  // subscribe when both paths run in the same boot.
  let stdinSubscribed = false;
  const subscribeStdin = (): void => {
    if (stdinSubscribed) return;
    stdinSubscribed = true;
    // Activate raw mode + bracketed paste at the SAME boundary as
    // the data listener. Before this point a Ctrl+C keystroke
    // still generates SIGINT (cooked-mode terminal driver), so an
    // operator can break out of a slow bootstrap. After this point
    // raw mode is on and Ctrl+C arrives as a literal `\x03` byte
    // — handled by the editor / focus stack we just installed.
    renderer.enableInput();
    stdin.on('data', onData);
    if (typeof stdin.resume === 'function') stdin.resume();
  };

  // Tear-down for early-exit paths that DON'T have a db / harness
  // to close (trust decline, bootstrap throw before reaching the
  // full shutdown(): both leave the pre-bootstrap stack live —
  // renderer holding raw mode + bracketed paste, stdin data
  // listener attached if subscribed, drain timer possibly armed).
  // Centralized because both paths leak the same set of handles if
  // any one step is forgotten.
  //
  // Idempotent against repeat calls — renderer.close and
  // modalManager.close already guard via internal `closed` flags;
  // removeListener / clearTimeout are no-ops on missing
  // listeners / null timers.
  let preBootstrapTornDown = false;
  const tearDownPreBootstrap = (): void => {
    if (preBootstrapTornDown) return;
    preBootstrapTornDown = true;
    cancelDrain();
    modalManager.close();
    renderer.close();
    if (stdinSubscribed) {
      stdin.removeListener('data', onData);
      if (typeof stdin.pause === 'function') stdin.pause();
    }
  };

  // ─── Trust prompt (AGENTIC_CLI §9.1) ─────────────────────────────
  // First-run gate. The cwd checked here MUST match the cwd
  // bootstrap will subsequently read project files from — same
  // string trusts the same directory. When bootstrapOverride is
  // injected (test fixtures), pull cwd from its already-resolved
  // config; otherwise derive it the same way bootstrap will
  // (process.cwd() default). Threaded into bootstrap below so the
  // values stay coherent.
  const cwd = options.bootstrapOverride?.config.cwd ?? process.cwd();
  const trustPath =
    options.trustListPathOverride !== undefined ? options.trustListPathOverride : trustListPath();
  const cwdAlreadyTrusted = trustPath !== null && isTrusted(trustPath, cwd);
  if (options.skipTrustPrompt !== true && !cwdAlreadyTrusted) {
    // Fail-closed timeout. Spec UI.md §5.5 rule 6 calls for trust:ask
    // to auto-reject after 5 minutes — modal-manager exposes the
    // window via `timeoutMs` but the producer (this caller) has to
    // arm it. Without the explicit pass, an unattended terminal at
    // the trust modal would block runRepl forever, holding raw
    // mode + bracketed paste open. The timeout resolves to 'cancel',
    // which falls through to the same decline path below — exit 0
    // without ever entering the REPL.
    const trustTimeoutMs = options.trustPromptTimeoutMs ?? 5 * 60 * 1000;
    // Probe for AGENTS.md at the cwd root (spec AGENTIC_CLI.md
    // line 75: "AGENTS.md é input não-confiável até prova em
    // contrário"). The reducer surfaces an explicit notice in the
    // modal preview when the flag is set so the operator knows
    // the file's instructions will be loaded on first use — a
    // safety cue worth seeing before they grant trust. existsSync
    // is fine here: cheap stat call on a single fixed path,
    // synchronous fits the boot flow, and missing-permissions /
    // ENOENT cleanly resolve to false.
    const agentsMdPresent = existsSync(join(cwd, 'AGENTS.md'));
    // Two-step ordering matters: askTrust SYNCHRONOUSLY pushes its
    // handler onto the focus stack (see modalManager's
    // `enqueueConfirm` → `drain`) before returning the promise.
    // Subscribing stdin AFTER that call guarantees any keystroke
    // landing post-resume() finds a handler waiting; subscribing
    // first would race against the OS delivering buffered bytes
    // ahead of the focus push.
    const answerPromise = modalManager.askTrust(
      { path: cwd, agentsMd: agentsMdPresent },
      { timeoutMs: trustTimeoutMs },
    );
    subscribeStdin();
    const answer = await answerPromise;
    if (answer !== 'yes') {
      tearDownPreBootstrap();
      return 0;
    }
    if (trustPath !== null) {
      try {
        addTrustedDir(trustPath, cwd);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        bus.emit({
          type: 'warn',
          ts: now(),
          message: `failed to persist trust for ${cwd}: ${msg} (will re-prompt next boot)`,
        });
      }
    }
  }

  // ─── Bootstrap ───────────────────────────────────────────────────
  // Bootstrap once. The empty initial prompt is a placeholder — the
  // harness loop tolerates an empty `userPrompt` (skips appending the
  // user message), and we override `userPrompt` per turn before
  // calling `runAgent`. Bootstrap allocates the DB, opens the
  // provider, resolves policies, loads subagents — all stable across
  // turns within a session.
  let bootstrapped: BootstrapResult;
  try {
    const bootstrapFn = options.bootstrapFn ?? bootstrap;
    // The shared-corpus trust probe fires INSIDE bootstrap (S5/T5.2).
    // For its modal to receive input, stdin must already be
    // subscribed — the modal-manager pushes its focus handler on
    // the focus stack synchronously, but without an active stdin
    // 'data' listener, no keystrokes flow in. The cwd-trust flow
    // subscribes lazily AFTER pushing its handler, but that path
    // only runs when cwd wasn't already trusted; the
    // already-trusted operator would hit bootstrap without stdin
    // subscribed and the modal would block until timeout. Pre-
    // subscribe here so the modal handler can stack on top of an
    // active listener.
    //
    // S5 P1/F6 hardening — preserve Ctrl+C as a bootstrap escape
    // hatch. Raw mode (turned on by subscribeStdin via
    // renderer.enableInput) converts Ctrl+C into a `\x03` byte that
    // flows to the focus stack instead of generating SIGINT. Before
    // this fix, that byte hit no handler during bootstrap (focus
    // stack was empty; editor handler doesn't push until ~line
    // 2431) and was silently consumed — operator could not abort a
    // slow/hung boot. The handler below sits at the BOTTOM of the
    // stack; it returns false on every key except Ctrl+C, letting
    // modal handlers and (later) the editor handler take priority
    // on top. When no modal is open, Ctrl+C falls through to this
    // bottom handler and re-raises SIGINT to the process — the
    // standard Unix abort semantic survives despite raw mode.
    const preBootstrapCtrlCHandler: FocusHandler = (key) => {
      if (key.kind === 'char' && key.ctrl && key.char === 'c') {
        // Re-raise SIGINT so the standard shell handler (or Node's
        // default) gets a chance to terminate the process. Wrapped
        // because process.kill can throw on a detached / orphaned
        // session and we'd rather let the operator try again than
        // crash on the abort path.
        try {
          process.kill(process.pid, 'SIGINT');
        } catch {
          // Last-ditch — if kill failed, exit code 130 (the
          // conventional "terminated by Ctrl+C" exit status).
          process.exit(130);
        }
        return true;
      }
      return false;
    };
    focusStack.push(preBootstrapCtrlCHandler);
    subscribeStdin();
    bootstrapped =
      options.bootstrapOverride ??
      (await bootstrapFn({
        prompt: '',
        // Pin bootstrap's cwd to the same string we trust-checked
        // above. Without this they'd both default to process.cwd()
        // independently and stay coherent in practice, but pinning
        // makes the invariant load-bearing rather than coincidental.
        cwd,
        ...(args.model !== undefined ? { modelId: args.model } : {}),
        ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
        // Forward the trust-list override so REPL and bootstrap
        // agree on which file is authoritative. Without this,
        // a test that pins `trustListPathOverride` for the boot
        // modal would still see bootstrap fall through to the
        // dev's real `~/.config/agent/trusted_dirs.json` —
        // bootstrap's `isCwdTrusted` would be wrong, and the
        // memory_write trust gate would surprise the test author.
        // `undefined` (production default) lets bootstrap use its
        // own default; `null` and string both forward verbatim.
        ...(options.trustListPathOverride !== undefined
          ? { trustListPathOverride: options.trustListPathOverride }
          : {}),
        // Shared-corpus trust modal (S5/T5.2). Thin adapter around
        // `modalManager.askSharedTrust` so bootstrap stays
        // independent of the TUI layer types. Timeout matches the
        // cwd-trust modal's 5-minute fail-closed window — both are
        // operator-attention prompts that an unattended terminal
        // shouldn't block forever.
        askSharedTrust: (a) =>
          modalManager.askSharedTrust(
            { path: a.path, mode: a.mode, corpusFiles: a.corpusFiles },
            { timeoutMs: 5 * 60 * 1000 },
          ),
      } satisfies BootstrapInput));
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    errSink(`forja: ${msg}\n`);
    // Pre-bootstrap stack (renderer, stdin listener, drain timer)
    // is live by this point — see comment near `tearDownPreBootstrap`.
    // Without this call an embedded caller (tests, agent SDK) that
    // keeps running after runRepl returns would leak the listener
    // and observe a terminal stuck in raw mode + bracketed paste
    // until process exit.
    tearDownPreBootstrap();
    return 1;
  }
  const {
    config: baseConfig,
    db,
    modelId,
    lockConflicts,
    subagents,
    policyLayers,
    hookWarnings,
    memoryConfigWarnings,
    providersConfigWarnings,
    budgetConfigWarnings,
    effortConfigWarnings,
    auditConfigWarnings,
    sandboxEnforcement,
  } = bootstrapped;

  // Surface the same warnings the one-shot path does. Operators get
  // them once at REPL boot rather than per turn.
  // Use the ACTUAL scopes from the ShadowedDefinition records
  // (`shadowed.scope` / `winning.scope`) rather than hardcoded
  // labels. With PROTECTED_BUILTIN_NAMES, shadows can carry
  // `shadowed.scope = 'builtin'` for embedded verify-* definitions
  // replaced by user/project files — hardcoded `(user) ...
  // (project)` would mislabel a builtin-replacement security
  // warning as a normal cross-scope shadow. Mirror of run.ts.
  for (const shadow of subagents.shadows) {
    errSink(
      `forja: subagent '${shadow.name}' from ${shadow.shadowed.sourcePath} (${shadow.shadowed.scope}) is shadowed by ${shadow.winning.sourcePath} (${shadow.winning.scope})\n`,
    );
  }
  for (const c of lockConflicts) {
    errSink(
      `forja: permission policy: ${c.section} locked by ${c.lockedBy}; ${c.attemptedBy}'s override dropped\n`,
    );
  }
  // Hook config warnings (spec AGENTIC_CLI.md §10.4) — see same
  // surfacing in src/cli/run.ts. Operator gets one warning per
  // dropped entry / unreadable file at REPL boot.
  for (const w of hookWarnings) {
    const layerFrag = w.layer !== null ? `${w.layer} ` : '';
    errSink(`forja: ${layerFrag}hook ${w.sourcePath}: ${w.message}\n`);
  }
  // Memory governance config warnings (`.agent/config.toml [memory]`).
  // Same surfacing as run.ts: loader degrades to defaults on bad
  // values, so the operator needs stderr visibility to spot a
  // silent opt-out failure (e.g., typed `verify_semantic_llm =
  // "false"` and got default-on detectors billing LLM-judge work).
  for (const w of memoryConfigWarnings) {
    errSink(`forja: memory config: ${w}\n`);
  }
  // [providers] config warnings (`.agent/config.toml [providers]`) —
  // same surfacing as run.ts: a bad model alias / route silently falls
  // back to the default, so stderr visibility lets the operator catch
  // it instead of running on a model they didn't intend.
  for (const w of providersConfigWarnings) {
    errSink(`forja: providers config: ${w}\n`);
  }
  // [budget] config warnings — a numeric typo or out-of-range value
  // shouldn't disappear silently.
  for (const w of budgetConfigWarnings) {
    errSink(`forja: budget config: ${w}\n`);
  }
  // [effort].level config warnings — an unknown level silently
  // defaulting to high would hide an operator typo (matches run.ts).
  for (const w of effortConfigWarnings) {
    errSink(`forja: effort config: ${w}\n`);
  }
  // [audit] / [audit.retention] config warnings — deletion policy
  // is operationally riskier than the other config surfaces.
  // An operator who typed a string for a day field, an invalid TTL
  // for recap_cache, or a typo for `run_gc_on_stop` would otherwise
  // silently run with default retention windows or the wrong Stop-
  // hook behavior. REPL-boot stderr is the diagnostic surface so
  // long-running interactive sessions aren't blind to misconfig.
  for (const w of auditConfigWarnings) {
    errSink(`forja: audit config: ${w}\n`);
  }
  // Shared-corpus trust probe outcome (S5/T5.2 + T5.3). Render a
  // single summary line so operators see what the modal decision
  // resulted in WITHOUT having to scroll through the modal preview
  // again. `seeded` and `unchanged` are silent (the happy path
  // shouldn't spam stderr at every boot); `reconfirmed` and
  // `revoked` echo the trust action the operator just took;
  // `verify_failed` surfaces the I/O error so the operator knows
  // the shared corpus' state is unknown and may need cleanup.
  if (bootstrapped.sharedTrustProbe !== undefined) {
    const p = bootstrapped.sharedTrustProbe;
    if (p.kind === 'reconfirmed') {
      errSink('forja: shared memory corpus re-confirmed — new hash trusted.\n');
    } else if (p.kind === 'revoked') {
      const invCount = p.invalidated.length;
      const failCount = p.failed.length;
      const invFrag = `${invCount} shared memor${invCount === 1 ? 'y' : 'ies'} invalidated`;
      const failFrag = failCount > 0 ? `; ${failCount} failed` : '';
      errSink(`forja: shared memory trust revoked — ${invFrag}${failFrag}.\n`);
      for (const f of p.failed) {
        errSink(`forja:   could not invalidate ${f.name}: ${f.reason}\n`);
      }
      // CRIT/F3 recovery hint. Operators who hit "No, revoke" by
      // mistake have no slash to undo per-memory: the state
      // machine forbids invalidated → active. Surface the manual
      // path here AND echo the 7-day auto-eviction window so the
      // operator knows their bodies aren't permanently gone yet
      // (they're still in .agent/memory/shared/ on disk until
      // gcStaleInvalidatedMemories progresses them to .tombstones/).
      if (invCount > 0) {
        errSink('forja:   recovery: edit the `.md` frontmatter to drop `state: invalidated`,\n');
        errSink('            then re-add the entry to .agent/memory/shared/MEMORY.md.\n');
        errSink('            Or accept the revoke — invalidated memories auto-evict to\n');
        errSink('            .tombstones/ after 7 days (EVICTION.md §7.1).\n');
      }
    } else if (p.kind === 'deferred') {
      // D1: surface WHY the prompt was deferred. Operator who hit
      // Esc / let the modal timeout AND operator surprised by a
      // TOCTOU swap during deliberation both arrive here, but the
      // cause changes what they should do next: 'modal_cancel'
      // means "answer the modal next boot", 'tocttou_during_prompt'
      // means "something is writing to .agent/memory/shared/ on
      // your behalf, investigate before re-confirming".
      const reason =
        p.cause === 'modal_cancel'
          ? 'modal cancelled — re-prompt next boot.'
          : 'corpus changed during prompt (TOCTOU) — re-prompt next boot; investigate concurrent writers.';
      errSink(`forja: shared memory trust prompt deferred — ${reason}\n`);
    } else if (p.kind === 'verify_failed') {
      errSink(
        `forja: shared memory corpus could not be verified at ${p.sharedRoot} — trust state unknown.\n`,
      );
    }
  }

  // Resume resolution. `--resume <id|last>` with empty prompt routes
  // here from `cli/index.ts` (the headless run.ts path stays guarded
  // by `--resume requires a follow-up prompt`). resolveResumeIdOnDb
  // shares the literal-id / 'last' / subagent-rejection rules with
  // the headless code path so the operator sees the same diagnostics
  // either way. A bad id aborts the REPL boot before the TUI takes
  // over so the operator's terminal stays clean — entering the live
  // region only to immediately tear it down would flash an empty
  // frame and a cursor that briefly disappeared.
  //
  // On success, the resolved id seeds `lastSessionId` (declared
  // below) so the first turn's runAgent gets `resumeFromSessionId`
  // and the LLM sees the prior conversation. The visual replay of
  // the prior turns (rebuilding scrollback from persisted messages)
  // lands in a subsequent slice; this slice closes the gate +
  // context-threading half of the feature.
  let resumedSessionId: string | null = null;
  if (args.resume !== undefined) {
    // `enforceCwd: true` — the REPL replays the resumed session's
    // scrollback immediately below, before runAgent's cwd guard
    // would ever run. A cross-cwd literal id must be rejected HERE
    // or another project's conversation would render on screen.
    const resolved = resolveResumeIdOnDb(db, args.resume, baseConfig.cwd, true);
    if (!resolved.ok) {
      errSink(`forja: ${resolved.message}\n`);
      // Mirror the full shutdown teardown order (§13.7): drain the
      // broker BEFORE closing storage. This early-return path
      // bypasses `shutdown()` entirely, so without the explicit
      // drain a non-default broker mode would leak its owned
      // resources (handles, timers) just because the operator
      // mistyped a resume id. tearDownPreBootstrap covers the
      // renderer/stdin side; broker + db close the bootstrap side.
      tearDownPreBootstrap();
      if (baseConfig.broker !== undefined) {
        await baseConfig.broker.close();
      }
      closeDb(db);
      return 1;
    }
    resumedSessionId = resolved.id;

    // Slice 129 (R5 P0 crash) parity with the headless resume path
    // (run.ts): settle any subagent handles left `running` from a
    // crashed prior run of this session. Without this, a parent
    // that died mid-`task_async` leaves `subagent_handles.status =
    // 'running'` forever; post-resume `task_await(handle_id)`
    // returns `unknown_handle` and the cached child output in
    // `subagent_outputs` is unreachable. The headless path settled
    // these; the REPL resume path (this slice's new surface) must
    // too, or interactively resuming a crashed session silently
    // strands its async subagents.
    //
    // The REPL already holds the bootstrap-opened `db` — no second
    // connection (run.ts opens its own because it settles BEFORE
    // bootstrap). Non-fatal: a settle failure shouldn't abort the
    // resume; surface the diagnostic so the operator knows some
    // handles MIGHT still be stranded.
    try {
      const settled = settleRunningSubagentHandles(db, resolved.id, {
        status: 'interrupted',
        reason: 'parent_session_resumed_after_crash',
        interrupted_at_ms: now(),
      });
      if (settled > 0) {
        errSink(
          `forja: --resume settled ${settled} subagent handle(s) left running from the previous (crashed) run.\n`,
        );
      }
    } catch (e) {
      errSink(
        `forja: --resume could not settle stale subagent handles: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  const project = basename(baseConfig.cwd) || baseConfig.cwd;

  // Snapshot the adapter context fresh for every turn. Mutation slash
  // commands (/model, /budget) edit baseConfig at runtime —
  // capturing model/budget at boot would freeze the
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
  //
  // Budget fields go through `effectiveBudget` so the TUI shows
  // the same caps the harness will actually enforce. Reading
  // `baseConfig.budget?.maxCostUsd` directly diverges from the
  // loop, which uses `effectiveBudget(config.budget)` and
  // therefore picks up `DEFAULT_BUDGET.maxCostUsd = 5` when the
  // operator hasn't set one. The pre-fix shape silently omitted
  // `maxCostUsd` from the ctx in that case — TUI rendered "no
  // cap" while the harness still aborted at 5 USD with reason
  // `maxCostUsd`. Routing through `effectiveBudget` keeps the
  // displayed and enforced limits aligned and preserves the
  // explicit-undefined opt-out (operator `/budget cost off`
  // writes `maxCostUsd: undefined`, the merge propagates that
  // undefined, and the ctx omits the field — TUI then correctly
  // shows uncapped, matching the harness's skipped gate).
  const buildAdapterCtx = () => {
    const budget = effectiveBudget(baseConfig.budget, baseConfig.effort);
    return {
      project,
      model: baseConfig.provider.id,
      maxSteps: budget.maxSteps,
      ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
      // Distinct-name memory count for the footer's `mem N` segment.
      // Snapshot at adapter-construction time (per-turn) — if a
      // memory_write succeeds mid-turn, the next turn's adapter
      // picks up the new count. Within a turn the footer doesn't
      // animate per-write; the `mem N` token reflects "what was
      // available when this turn began". Trade-off: per-write live
      // updates would couple the reducer to the memory_events bus
      // (every write would have to fire a status:update event the
      // reducer maps onto status.memoryCount). Per-turn fidelity is
      // acceptable today because writes are interactive (operator
      // confirms each one) and the next turn picks up the bump
      // within seconds. Revisit if operator data shows confusion
      // ("I just confirmed a write but the counter didn't move").
      ...(baseConfig.memoryRegistry !== undefined
        ? { memoryCount: baseConfig.memoryRegistry.count({ deduplicateByName: true }) }
        : {}),
    };
  };

  // bus / focusStack / renderer / modalManager / parser / `running`
  // / `exiting` / `exitCode` / `resolveExit` / `exitPromise` /
  // `onData` / `cancelDrain` / `onModalInterrupt` are all hoisted
  // above the trust prompt — see "Pre-bootstrap stack" earlier in
  // this function.
  // Seeded by `--resume` resolution above (null when the operator
  // started a fresh REPL). On resume, this id flows through the
  // first turn's `resumeFromSessionId` so the LLM sees the prior
  // conversation, and the shutdown hint prints the same id so the
  // chain can continue across boots.
  let lastSessionId: string | null = resumedSessionId;
  // Append-only list of session ids tracked across this REPL
  // boot. Pushed on `session_finished` and on playbook subagent
  // completion. Slash commands that aggregate across the whole
  // REPL read this list so an operator running multiple turns
  // sees data from all of them, not just the most recent.
  // Synthetic-parent ids (audit anchors created by
  // ensureParentSessionId before any real turn) are NOT pushed —
  // those are subagent-flagged anchors with no runs of their own.
  const replSessionIdSet = new Set<string>();
  const replSessionIdOrder: string[] = [];
  const trackReplSessionId = (id: string): void => {
    if (replSessionIdSet.has(id)) return;
    replSessionIdSet.add(id);
    replSessionIdOrder.push(id);
  };
  // Seed the tracking list with the resumed id so REPL-wide
  // aggregation spans both the resumed chain AND new turns added in
  // this boot. Without this seed, only runs started in the current
  // boot would be visible, hiding any prior data tied to the
  // resumed session.
  if (resumedSessionId !== null) trackReplSessionId(resumedSessionId);

  // Synthetic parent session id for slash playbook dispatches that
  // happen BEFORE any normal turn has run. `runSubagent` requires a
  // `parentSessionId` for audit attribution + budget cascading; the
  // bridge used to refuse with "no session yet" until the operator
  // typed a regular prompt first. The synthetic is created lazily on
  // the first slash dispatch (see `ensureParentSessionId` below),
  // immediately closed to status='done' so it doesn't sit running
  // forever, and reused across subsequent dispatches until a real
  // turn assigns `lastSessionId` — at which point the real id wins
  // and the synthetic is left as a no-cost / no-message orphan in
  // the sessions table.
  //
  // Marked `is_subagent: true` so it stays hidden from top-level
  // surfaces. Without that flag the synthetic lands as the most
  // recent top-level row for this cwd, and `--resume last`
  // (listSessions(..., { cwd, limit: 1 }) filtered to
  // is_subagent = 0) resurrects an empty shell instead of the
  // operator's real conversation. The flag also keeps
  // `--list-sessions` clean of these audit-only rows.
  let syntheticParentSessionId: string | null = null;
  const ensureParentSessionId = (): string => {
    if (lastSessionId !== null) return lastSessionId;
    if (syntheticParentSessionId !== null) return syntheticParentSessionId;
    const synthetic = createSession(db, {
      model: baseConfig.provider.id,
      cwd: baseConfig.cwd,
      isSubagent: true,
    });
    // Immediately close. The session row exists only as an audit
    // anchor for the slash dispatch's child; it has no turns, no
    // messages, no cost. Leaving it 'running' would pile up over
    // a long REPL session that does many slash dispatches before
    // any normal turn (rare but possible in eval / scripted runs).
    completeSession(db, synthetic.id, 'done', 0, true);
    syntheticParentSessionId = synthetic.id;
    return synthetic.id;
  };

  // ─── Input history (HISTORY.md §2.1) ───────────────────────────────
  // In-memory mirror of repl_history for the current project, oldest-
  // first. Loaded once at boot — concurrent REPLs in the same project
  // won't see each other's appends until the next reopen (spec §1.4
  // visibility lag is explicit).
  //
  //   historyIdx === null    → operator is editing the live buffer
  //   historyIdx >= 0        → operator is recalling; index points
  //                            into historyEntries (entries[idx] is on
  //                            screen). ↑ decrements, ↓ increments;
  //                            stepping past entries.length-1 restores
  //                            scratch and goes back to null.
  //
  // historyEnabled mirrors `/history off` / `/history on` — session-
  // volatile (HISTORY.md §3.3 level 3); permanent disable lives in
  // env / file marker, both honored inside storage/history.ts.
  // Cap shared by storage and mirror — keeps both trims aligned so
  // the in-memory recall pool never surfaces entries that have
  // already been evicted from the table.
  const historyCap = options.historyCapOverride ?? HISTORY_CAP;
  let historyEntries: string[] = loadHistory(db, baseConfig.cwd, historyCap);
  let historyIdx: number | null = null;
  let historyScratch: string | null = null;
  // Seed `historyEnabled` from the storage-level opt-out so the
  // REPL flag agrees with what storage will actually accept. With
  // `FORJA_NO_HISTORY=1` or `.agent/no-history` set, `appendHistory`
  // already no-ops; without this seed the flag would say "on" while
  // every submit silently dropped, leaving the in-memory mirror
  // and the table out of sync. `/history on` re-checks this on
  // attempted re-enable so the operator can't override env.
  let historyEnabled = historyOptOutReason(baseConfig.cwd) === null;

  const recordHistorySubmit = (text: string): void => {
    // Reset nav state regardless of persistence — next ↑ should walk
    // from the newest entry even if the operator just toggled
    // /history off, otherwise the scratch from a prior recall would
    // resurface unexpectedly on the next press.
    historyIdx = null;
    historyScratch = null;
    if (!historyEnabled) return;

    // Persist FIRST, then mirror in memory. Two robustness reasons:
    //
    //   1. SQLite can throw mid-session — disk full, db locked by an
    //      external process, FS gone read-only. The pre-fix code let
    //      that throw bubble out to the editor handler and crash the
    //      REPL on a single Enter. Wrapping with try/catch keeps the
    //      session alive: operator sees a warn, the submit still
    //      reaches the harness (startTurn fires after this helper
    //      returns), but the prompt isn't recallable on next boot.
    //
    //   2. Mirror-after-success means a failed db append leaves the
    //      mirror untouched. Without that, the array would carry a
    //      ghost entry the operator could recall via ↑ — entries that
    //      vanish silently on REPL restart, which is exactly the kind
    //      of "did I really type that?" surprise we want to avoid.
    //
    // Empty text never reaches this path — applyKey gates submit on
    // `value === ''` and the slash dispatcher gates on parsed.name === ''.
    try {
      appendHistory(db, baseConfig.cwd, text, { cap: historyCap });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bus.emit({
        type: 'warn',
        ts: now(),
        message: `history not persisted: ${msg} (this submit will not be recallable next boot)`,
      });
      return;
    }
    if (historyEntries[historyEntries.length - 1] !== text) {
      historyEntries.push(text);
      // Cap the mirror to match storage's trim. Without this, a
      // long-running session accumulates an unbounded array, and
      // ↑/Ctrl+R surface entries that storage has already evicted
      // — recall succeeds in-session, then the same prompt vanishes
      // on next REPL boot. splice(0, overflow) is in-place; cheap
      // even at the 10k cap because it only fires on the boundary
      // crossing (post-fix, length is always ≤ historyCap).
      const overflow = historyEntries.length - historyCap;
      if (overflow > 0) historyEntries.splice(0, overflow);
    }
  };

  // ─── Reverse-search overlay (HISTORY.md §2.2) ──────────────────────
  // Local state mirrors the renderer's view so the editor handler
  // doesn't have to read it back via renderer.state(). Producer-side
  // truth: the operator types into this query, every keystroke
  // re-runs searchHistory against the project's table; Ctrl+R while
  // open cycles to older matches with the same query.
  //
  // Cap match list at 200 — operator scrolls via Ctrl+R, which means
  // visiting more than ~10 entries is rare; 200 is generous enough
  // to cover heavy typists without keeping a 10k-row mirror in JS
  // for every keystroke.
  const REVERSE_SEARCH_LIMIT = 200;
  let reverseSearchQuery: string | null = null;
  let reverseSearchResults: string[] = [];
  let reverseSearchIdx = -1;

  const isReverseSearchOpen = (): boolean => reverseSearchQuery !== null;

  // Sanitize a query before it lands in state. The overlay renders as
  // a single visual row (HISTORY.md §2.2); embedded newlines from a
  // multi-line paste would otherwise spill into multiple rows and
  // break the live region's row accounting. Collapse `\r?\n` → space,
  // matching the same treatment we apply to recalled multi-line
  // matches in render/reverse-search.ts.
  const sanitizeReverseSearchQuery = (raw: string): string => raw.replace(/\r?\n/g, ' ');

  const refreshReverseSearch = (query: string): void => {
    const clean = sanitizeReverseSearchQuery(query);
    reverseSearchQuery = clean;
    reverseSearchResults =
      clean === '' ? [] : searchHistory(db, baseConfig.cwd, clean, REVERSE_SEARCH_LIMIT);
    reverseSearchIdx = reverseSearchResults.length > 0 ? 0 : -1;
    bus.emit({
      type: 'reverse-search:update',
      ts: now(),
      query: clean,
      results: reverseSearchResults,
      selectedIdx: reverseSearchIdx,
    });
  };

  const openReverseSearch = (): void => {
    if (isReverseSearchOpen()) return;
    refreshReverseSearch('');
  };

  const closeReverseSearch = (): void => {
    if (!isReverseSearchOpen()) return;
    reverseSearchQuery = null;
    reverseSearchResults = [];
    reverseSearchIdx = -1;
    bus.emit({ type: 'reverse-search:close', ts: now() });
  };

  const cycleReverseSearchOlder = (): void => {
    if (!isReverseSearchOpen() || reverseSearchResults.length === 0) return;
    // Clamp at the oldest match (last index). Ctrl+R past the bottom
    // is a no-op rather than a wrap — bash beeps in this case; we
    // just stop. Cycling past oldest would surprise an operator who
    // expects "more presses → older".
    if (reverseSearchIdx < reverseSearchResults.length - 1) {
      reverseSearchIdx += 1;
    }
    bus.emit({
      type: 'reverse-search:update',
      ts: now(),
      query: reverseSearchQuery ?? '',
      results: reverseSearchResults,
      selectedIdx: reverseSearchIdx,
    });
  };

  // The match the operator is currently looking at, or null when the
  // overlay has zero matches. Used by accept (Enter / Tab) to know
  // what to drop into the input buffer.
  const currentReverseSearchMatch = (): string | null => {
    if (reverseSearchIdx < 0) return null;
    return reverseSearchResults[reverseSearchIdx] ?? null;
  };
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
  // Mirror controllers for the slash playbook dispatcher's
  // runSubagent call. Set inside runPlaybook before the await
  // and cleared in its finally block; triggerInterrupt below
  // aborts whichever pair (foreground OR playbook) is live so
  // Esc / Ctrl+C / SIGINT preempt a long-running /<playbook>
  // dispatch the same way they preempt a foreground turn.
  let playbookAbortController: AbortController | null = null;
  let playbookSoftStopController: AbortController | null = null;
  // Promise handle for the in-flight slash playbook dispatch.
  // shutdown() aborts the playbook controller AND awaits this so
  // the child's setSubagentPayload completes before db.close() —
  // without it, /quit during a long /<playbook> tears down the
  // SQLite handle while the runtime is still flushing the
  // envelope, surfacing as a "database is closed" throw and
  // leaking the child subprocess past REPL exit. Mirrors the
  // foreground `runningPromise` contract.
  let playbookPromise: Promise<unknown> | null = null;
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
  // Whether the active turn emitted `session_finished` (the normal
  // boundary that schedules the inbox drain). Reset per turn in startTurn;
  // if a turn's runAgent rejects WITHOUT emitting it, the finalizer drains
  // instead, so a message queued during a failed turn isn't left stranded
  // until some later unrelated boundary.
  let sawSessionFinished = false;

  // INBOX (docs/spec/INBOX.md — in-memory by design). Input committed
  // while a turn or playbook is in flight accumulates here instead of
  // being dropped; `drainInbox` flushes it as the next user turn at the
  // boundary (session_finished / playbook end). In-memory is the final
  // design — never persisted (deliberate, permanent divergence from
  // §0.5/§13; operator's call). `drainInbox` is forward-declared so
  // onHarnessEvent (above startTurn) can trigger it; its body, assigned
  // after startTurn, calls startTurn.
  const inbox: { id: string; text: string }[] = [];
  let inboxSeq = 0;
  let drainInbox: () => void = () => {};
  // Id of the queued message currently lifted into the input via ↑ for
  // editing, or null. The message STAYS in `inbox` the whole time (never
  // removed), so an edit can never lose it; this only marks which one is
  // being edited — commit updates it in place, the renderer hides its bar.
  let editingQueued: { id: string } | null = null;

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
      syncBusy();
      sawSessionFinished = true;
      lastSessionId = event.result.sessionId;
      trackReplSessionId(event.result.sessionId);
      cumulative.costUsd += event.result.costUsd;
      cumulative.steps += event.result.steps;
      cumulative.turns += 1;
      // INBOX boundary (§2.1/§2.3): the turn ended — drain anything
      // queued during it as the next user turn. Even degraded ends
      // (error/timeout/abort) route through session_finished and drain
      // here, per §2.3. Deferred to a microtask so it runs after this
      // event finishes dispatching, mirroring the supported back-to-back
      // submit timing; the token gate in startTurn handles re-entrancy.
      queueMicrotask(() => drainInbox());
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
    source?: PolicySource;
    subagent?: { sessionId: string; name: string };
    signal?: AbortSignal;
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
    // Anti-spoof for subagent-proxied requests (spec
    // docs/spec/IPC.md §7). EVERY string field that originates
    // from the child's wire payload and reaches the modal must
    // pass through `sanitizeForSubagentDisplay`:
    //   - `toolName` is rendered into option labels and the
    //     question line ("Yes, allow all <tool> during this
    //     session", "Do you want to run this <tool> command?").
    //     The IPC parser only validates non-empty string; a
    //     hostile child can pack ANSI / newlines that bypass
    //     stripAnsi-only sanitization (newlines are NOT in
    //     stripAnsi's range, so a `bash\n[red] FAKE WARN` would
    //     split the modal display).
    //   - `command`, `cwd`, `prompt` show up in the preview block.
    // The parent's own confirms (req.subagent === undefined) keep
    // raw strings — those originate from prompts the operator
    // authored, so fidelity matters and trust is implicit.
    let displayToolName = req.toolName;
    let displayCwd = req.cwd;
    let displayPrompt = req.prompt;
    // The engine's matching rule. When subagent-proxied we
    // sanitize it like every other display string (the IPC
    // protocol won't grow source until the bridge gains
    // marshaling — for now subagent confirms simply have
    // req.source undefined). For parent-side confirms the rule
    // came from operator-authored YAML, so trust is implicit.
    let displayRule = req.source?.rule;
    if (req.subagent !== undefined) {
      command = sanitizeForSubagentDisplay(command);
      displayToolName = sanitizeForSubagentDisplay(req.toolName);
      displayCwd = sanitizeForSubagentDisplay(req.cwd);
      displayPrompt = sanitizeForSubagentDisplay(req.prompt);
      if (displayRule !== undefined) {
        displayRule = sanitizeForSubagentDisplay(displayRule);
      }
    }
    const answer = await modalManager.askPermission(
      {
        toolName: displayToolName,
        command,
        cwd: displayCwd,
        reason: displayPrompt,
        // Forward source.layer + the rule into the modal so the
        // operator sees "matched rule: rm * (project policy)"
        // instead of a generic deny. Spread keeps fields absent
        // when source is undefined (synthesized Decisions, or
        // subagent-proxied confirms where IPC doesn't marshal
        // source yet). The reducer renders one line per
        // available field; missing fields just don't render.
        ...(displayRule !== undefined ? { rule: displayRule } : {}),
        ...(req.source?.layer !== undefined ? { layer: req.source.layer } : {}),
        // Forward subagent attribution so the modal can label the
        // request as coming from a child run (spec
        // docs/spec/IPC.md §7). Spread keeps the field absent for
        // the parent's own confirms — the reducer only branches
        // on its presence.
        ...(req.subagent !== undefined ? { subagent: req.subagent } : {}),
      },
      // Forward producer cancellation signal. Subagent proxy
      // wires it to the child's IPC lifetime so a child dying
      // mid-modal closes the prompt instead of stranding the
      // operator on a stale request.
      req.signal !== undefined ? { signal: req.signal } : undefined,
    );
    // Modal returns 'yes' / 'no' / 'cancel'. The previous
    // 'session-allow' value was removed alongside option 2 — the
    // engine's addSessionAllow API stays available for non-modal
    // surfaces (future `/perms` slash commands).
    return answer === 'yes';
  };

  // Bridge for the `memory_write` tool's confirm modal (MEMORY.md
  // §5.1). Forwards scope/name/body straight into the modal and
  // returns the operator's choice. The tool layer maps 'yes' onto
  // a writer call, 'no'/'cancel' onto the audit row's
  // refused-reason. We don't translate the answer here because
  // the tool layer needs the raw discriminator for telemetry
  // (no vs cancel distinction).
  const confirmMemoryWrite = async (req: {
    scope: 'user' | 'project_shared' | 'project_local';
    name: string;
    body: string;
  }): Promise<'yes' | 'no' | 'cancel'> => modalManager.askMemoryWrite(req);

  // Second-confirm bridge for user-scope writes (MEMORY.md §7.2.5).
  // Same one-liner shape as confirmMemoryWrite — the modal
  // manager handles wording differences. The tool layer fires this
  // only when the proposed scope is `user`; we don't gate scope
  // here, just forward.
  const confirmMemoryUserScope = async (req: {
    name: string;
    body: string;
  }): Promise<'yes' | 'no' | 'cancel'> => modalManager.askMemoryUserScope(req);

  // Operator `!cmd` execution. Runs as the operator's own shell — NOT
  // through the agent permission engine or sandbox (the engine gates the
  // agent, not the human at the keyboard; this is the shell-style `!`
  // escape). `bash -c` in the REPL cwd with the operator's full env. A
  // generous timeout is the guard, so a hung command can't wedge the
  // REPL forever. The result lands in scrollback via `operator-bash:done`.
  const OPERATOR_BASH_TIMEOUT_MS = options.operatorBashTimeoutMs ?? 120_000;
  const execBash =
    options.execBash ??
    (async (
      command: string,
      runCwd: string,
      onKillable?: (kill: (signal: NodeJS.Signals) => void) => void,
    ): Promise<{ output: string; exitCode: number }> => {
      // `detached: true` puts the command in its own process group so a
      // kill targets the WHOLE group, not just the `bash -c` leader. A
      // bare `proc.kill()` (single signal to bash) leaves pipeline
      // children / signal-ignoring procs holding the stdout pipe open,
      // so `Response().text()` below would await EOF forever and
      // `operatorBashRunning` would stick true — wedging the REPL.
      // Killing the group (POSIX `process.kill(-pid, …)`, the bg-manager
      // convention) closes the pipes and unblocks.
      //
      // `exec 2>&1` (first line of the script) redirects the shell's
      // fd 2 onto fd 1 for the whole command, so stderr and stdout
      // interleave on ONE pipe in the order the command emitted them —
      // a separate-pipe read + concat would move every diagnostic after
      // all normal output, misrepresenting a compiler/test transcript.
      const proc = Bun.spawn({
        cmd: ['bash', '-c', `exec 2>&1\n${command}`],
        cwd: runCwd,
        env: process.env,
        stdout: 'pipe',
        stderr: 'ignore',
        detached: true,
      });
      const killGroup = (signal: NodeJS.Signals): void => {
        const pid = proc.pid;
        try {
          if (pid !== undefined && pid > 0) process.kill(-pid, signal);
          else proc.kill(signal);
        } catch {
          // group already gone, or no PID — fall back to the leader.
          try {
            proc.kill(signal);
          } catch {
            // also gone — nothing to kill.
          }
        }
      };
      // Hand the kill switch to the interrupt path (Ctrl+C / Esc).
      onKillable?.(killGroup);
      // Hard backstop: SIGKILL the group if the command overstays. The
      // interrupt path uses SIGINT/SIGKILL before this ever fires.
      const killer = setTimeout(() => killGroup('SIGKILL'), OPERATOR_BASH_TIMEOUT_MS);
      try {
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { output, exitCode };
      } finally {
        clearTimeout(killer);
      }
    });

  // Fire-and-forget: flip the busy flag, run the command, emit the
  // result, clear the flag. Refusal-while-busy is handled by the
  // caller (the Enter dispatch); by the time we get here the REPL is
  // idle and owns the operator slot. The command runs inside a
  // `Promise.resolve().then(...)` so a synchronously-throwing `execBash`
  // (a malformed test seam) becomes a rejection the `.catch` handles,
  // instead of escaping past the `.finally` and leaving the flag stuck.
  const runOperatorBash = (command: string): void => {
    operatorBashRunning = true;
    operatorBashInterrupted = false;
    syncBusy();
    const startedAt = now();
    void Promise.resolve()
      .then(() =>
        execBash(command, cwd, (kill) => {
          // Executor exposes its process-group kill switch; the
          // interrupt path (triggerInterrupt) uses it.
          operatorBashKill = kill;
        }),
      )
      .then(({ output, exitCode }) => {
        bus.emit({
          type: 'operator-bash:done',
          ts: now(),
          command,
          output,
          exitCode,
          durationMs: now() - startedAt,
        });
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        bus.emit({
          type: 'operator-bash:done',
          ts: now(),
          command,
          output: msg,
          exitCode: -1,
          durationMs: now() - startedAt,
        });
      })
      .finally(() => {
        operatorBashRunning = false;
        operatorBashKill = null;
        syncBusy();
        // The REPL was idle while the command ran; if messages queued
        // meanwhile (operator typed ahead), drain them now.
        if (!isBusy()) queueMicrotask(() => drainInbox());
      });
  };

  const startTurn = (text: string): void => {
    if (isBusy() || exiting) return;
    running = true;
    syncBusy();
    // Mint a fresh token for this turn and claim ownership of the
    // shared state slots (running / abortController / runningPromise).
    // The finalizer below compares against `activeTurnToken` to refuse
    // mutations once a newer turn has taken over.
    const myToken = Symbol('turn');
    activeTurnToken = myToken;
    sawSessionFinished = false;
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
      confirmMemoryWrite,
      confirmMemoryUserScope,
      contextPinsStore,
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
        syncBusy();
        abortController = null;
        softStopController = null;
        runningPromise = null;
        activeTurnToken = null;
        // Rejection boundary: if runAgent threw before emitting
        // session_finished, that branch never scheduled the inbox drain —
        // do it here so a message queued during the failed turn becomes
        // the next turn instead of sitting pending. When session_finished
        // DID fire it already scheduled the drain; skip to avoid a
        // redundant pass.
        if (!sawSessionFinished) queueMicrotask(() => drainInbox());
      });
  };

  // Enqueue a message into the in-memory inbox (INBOX §4.1): mint an id,
  // append it, and emit `inbox:queued` (which adds the pending bar and
  // clears the input). Shared by the normal busy submit path and the busy
  // reverse-search submit so both drain at the next boundary identically.
  // History is NOT recorded here — only the finalized text is recorded at
  // drain time (drainInbox), so an edited-then-committed message doesn't
  // leave its stale pre-edit draft in the ↑/Ctrl-R recall pool.
  const enqueueInbox = (text: string): void => {
    const id = String(inboxSeq++);
    inbox.push({ id, text });
    bus.emit({ type: 'inbox:queued', ts: now(), id, text });
  };

  // End an in-progress ↑ edit, leaving the queued message unchanged (it
  // never left the queue). Used by ↓, Esc, and when the operator pivots
  // into a slash command / the ? shortcut. No-op when not editing.
  const cancelQueuedEdit = (): void => {
    if (editingQueued === null) return;
    editingQueued = null;
    bus.emit({ type: 'inbox:edit-cancel', ts: now() });
    // If the turn already ended while this message was being edited, the
    // boundary held it back (drainInbox excludes the edited item) and the
    // REPL is now idle — no further boundary will fire. Drain now so the
    // message isn't stranded in the queue forever.
    if (!isBusy()) queueMicrotask(() => drainInbox());
  };

  // INBOX drain (docs/spec/INBOX.md §4.4 / §5.1). FIFO over everything
  // queued since the last boundary, concatenated into ONE user turn (the
  // provider rejects consecutive same-role messages, so N queued items
  // can't be N wire messages — see inbox-drain.ts). No-op when exiting,
  // still busy, or with nothing drainable. The message being edited (if
  // any) is NOT drained — it waits for the next boundary so the operator
  // isn't cut off mid-edit. Emits `inbox:drained` (freezes each drained
  // message into a scrollback bar, WITHOUT clearing the input — a draft
  // survives), then runs the turn. History is recorded per drained message
  // HERE (final, post-edit text) — not at enqueue — so an edited message
  // never leaves its stale original in the ↑/Ctrl-R recall pool. The
  // concatenated body is not recorded; each message is recorded separately.
  drainInbox = (): void => {
    if (exiting || isBusy()) return;
    const editId = editingQueued?.id ?? null;
    const drained = inbox.filter((m) => m.id !== editId);
    if (drained.length === 0) return;
    const kept = inbox.filter((m) => m.id === editId);
    inbox.length = 0;
    for (const m of kept) inbox.push(m);
    const texts = drained.map((m) => m.text);
    for (const t of texts) recordHistorySubmit(t);
    bus.emit({ type: 'inbox:drained', ts: now(), texts });
    startTurn(concatQueuedBodies(texts));
  };

  // Async cleanup. Only called via `requestShutdown` below — the
  // sync gate is the source of truth for "we're exiting"; this
  // function does the work without needing its own guard.
  const shutdown = async (): Promise<void> => {
    if (abortController !== null) abortController.abort();
    // Same hard-abort signal for an in-flight slash playbook so
    // its runSubagent settles instead of running to natural
    // completion past the operator's /quit. The promise await
    // below blocks db.close() until the child's payload write
    // lands.
    if (playbookAbortController !== null) playbookAbortController.abort();
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
    // Same wait for the playbook dispatch — the runtime's final
    // `setSubagentPayload` AND `reclassifySessionStatus` calls land
    // BEFORE db.close(), keeping the audit trail consistent with
    // the published envelope even on a /quit-mid-playbook race.
    if (playbookPromise !== null) {
      try {
        await playbookPromise;
      } catch {
        // Swallow — runPlaybook's caller (slash exec) already
        // surfaces failures via the slash bus error channel; the
        // shutdown path only needs the wait, not the verdict.
      }
    }
    modalManager.close();
    renderer.close();
    stdin.removeListener('data', onData);
    // Drop the lone-ESC drain timer if it's pending — leaks otherwise
    // (Bun would surface as an "open handle" warning in tests; in
    // production it'd just delay process exit by up to ESC_DRAIN_MS).
    cancelDrain();
    if (typeof stdin.pause === 'function') stdin.pause();
    // §13.7 broker drain BEFORE storage close — same rationale as
    // src/cli/run.ts. Awaits in-flight exec; closes idempotently.
    if (baseConfig.broker !== undefined) {
      await baseConfig.broker.close();
    }
    closeDb(db);
    // Resume hint. Printed AFTER renderer.close() (no live region to
    // fight) and AFTER db.close() (any teardown diagnostics that
    // would also use errSink land first). Gated on a real session
    // having run — when lastSessionId is null the operator never
    // started a turn and there is nothing to resume to, so silence
    // is correct. Goes through errSink (not stdout) because the
    // line is operator diagnostics, not program output; tests inject
    // a sink to capture it, and the convention matches the panic
    // exit message above.
    if (lastSessionId !== null) {
      errSink(`\nResume this session with:\nforja --resume ${lastSessionId}\n`);
    }
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
    // An operator `!cmd` owns the interrupt while it runs: Ctrl+C / Esc
    // kill its process group (like a terminal) rather than touching a
    // turn. SIGINT on the first tap, SIGKILL on a repeat if it ignored
    // SIGINT. We do NOT emit the turn-level `interrupt` event here —
    // there's no turn, and it would leak `softInterrupted` into the next
    // one. The kill closes the pipes → execBash resolves → the
    // operator-bash card lands with the killed exit code.
    if (operatorBashRunning) {
      operatorBashKill?.(operatorBashInterrupted ? 'SIGKILL' : 'SIGINT');
      operatorBashInterrupted = true;
      return;
    }
    const level: 'soft' | 'hard' = renderer.state().softInterrupted ? 'hard' : 'soft';
    bus.emit({ type: 'interrupt', ts: now(), level });
    if (level === 'hard') {
      if (abortController !== null) abortController.abort();
      // Abort the playbook controller TOO if a slash dispatch
      // is in flight. Foreground and playbook controllers are
      // never both populated simultaneously (the busy gate
      // serializes them), so this is "abort whichever is live"
      // rather than two separate state machines.
      if (playbookAbortController !== null) playbookAbortController.abort();
    } else {
      if (softStopController !== null) softStopController.abort();
      if (playbookSoftStopController !== null) playbookSoftStopController.abort();
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
    if (isBusy()) triggerInterrupt();
  };

  // Slash command registry + cumulative tracker for /cost. Built once
  // per REPL session — the registry is stable; cumulative is mutated
  // by startTurn's success branch and read by /cost.
  //
  // Pass the discovered subagents in so every definition with a
  // `slash:` field auto-registers as a slash command (`PLAYBOOKS.md`
  // §1.4). The registry's duplicate-name guard surfaces conflicts
  // between a builtin and a playbook author's chosen slash at boot
  // — no chance of a typed `/<conflict>` ambiguously routing
  // mid-session.
  const slashRegistry = createBuiltinRegistry(subagents);
  const cumulative = { costUsd: 0, steps: 0, turns: 0 };
  // Single registry instance for the REPL's lifetime. /model uses it
  // for the lookup + factory; bootstrap built its own at boot for
  // initial provider resolution. Both call sites are independent —
  // there's no shared state, so two instances are functionally
  // equivalent (the registry is just a Map of model entries).
  const modelRegistry = createDefaultRegistry();

  // Pinned context store (CONTEXT_TUNING.md §12.4). One instance for
  // the REPL's lifetime; threaded into both the SlashContext (so
  // /pin reads/writes) and each turn's HarnessConfig (so the
  // pin_context tool reads/writes through ToolContext). Both
  // surfaces share the same store — the underlying table is the
  // single source of truth.
  const contextPinsStore = createContextPinsStore(db);

  // Hook dispatcher for slash commands (EVICTION.md §10.3). Mirrors
  // the harness loop's wrapper at loop.ts:dispatchHooks but uses the
  // operator's current REPL state (session id, hooks loaded at
  // bootstrap). When no hooks are configured or the kill-switch is
  // on, returns null so the slash caller skips the hook gate
  // (same path as the empty-chain short-circuit). Errors inside
  // the chain are caught + stderred so a buggy hook can't crash
  // the slash command surface — defense in depth mirrors the
  // harness's pattern.
  const slashDispatchHooks = async (payload: HookEventPayload): Promise<HookChainResult | null> => {
    if (baseConfig.disableAllHooks === true) return null;
    if (baseConfig.hooks === undefined || baseConfig.hooks.length === 0) return null;
    try {
      return await dispatchChain(baseConfig.hooks, payload, baseConfig.cwd, {
        db,
        sessionId: lastSessionId !== null && lastSessionId.length > 0 ? lastSessionId : null,
        ...(baseConfig.disableAllHooks !== undefined
          ? { disableAllHooks: baseConfig.disableAllHooks }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`hooks: slash chain dispatch failed for ${payload.event}: ${msg}\n`);
      return null;
    }
  };

  const slashCtx: SlashContext = {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative,
    now,
    requestShutdown,
    contextPinsStore,
    dispatchHooks: slashDispatchHooks,
    // Closure over the REPL's busy state — fresh read per call so
    // a slash command queued before a turn starts but executed
    // after observes the post-startTurn state. The same predicate
    // (`isBusy`) gates foreground submit paths; pinning all
    // surfaces to one source of truth means there is no Enter /
    // reverse-search path that can sneak a normal turn past a
    // playbook in flight, and no slash dispatch that can race a
    // foreground turn.
    isRunning: () => isBusy(),
    // Most recent session id (closure so it's read fresh per slash
    // call). Set after the first turn's session_finished event;
    // null between boot and first turn. /memory show forwards this
    // as auditSessionId so its read rows group with the operator's
    // current session.
    currentSessionId: () => lastSessionId,
    replSessionIds: () => replSessionIdOrder,
    modelRegistry,
    // History controls (HISTORY.md §2.3). `/history clear` calls
    // `clearLocal` AFTER `clearHistory` against the db so the in-
    // memory mirror used by ↑/↓ recall stays consistent — without
    // this, a wipe followed by ↑ would surface entries from the
    // pre-wipe mirror that no longer exist on disk.
    history: {
      isEnabled: () => historyEnabled,
      setEnabled: (enabled) => {
        // Transition disabled → enabled has to re-sync the in-memory
        // mirror with storage, otherwise ↑/↓ and Ctrl+R stay empty
        // until process restart. Two scenarios this fixes:
        //
        //   1. Boot with `.agent/no-history` marker present →
        //      `loadHistory` no-opped, mirror seeded as []. Operator
        //      removes the marker (or it was created by some other
        //      REPL post-boot), runs /history on. Without the
        //      reload, recall would show nothing even though the
        //      table holds the project's full history.
        //
        //   2. /history off → another REPL appends a few entries →
        //      /history on. The reload also captures concurrent
        //      writes that landed during the off window.
        //
        // Cap-bounded query, so the reload cost is the same as the
        // boot's initial load. Nav state is reset so a recall begun
        // before /history off doesn't carry into the new mirror.
        const becomingEnabled = !historyEnabled && enabled;
        historyEnabled = enabled;
        if (becomingEnabled) {
          historyEntries = loadHistory(db, baseConfig.cwd, historyCap);
          historyIdx = null;
          historyScratch = null;
        }
      },
      clearLocal: () => {
        historyEntries = [];
        historyIdx = null;
        historyScratch = null;
      },
      // Re-probe each call: a `yes-disable` from /history clear
      // writes the file marker mid-session, which should immediately
      // be visible to `/history on` even though the env never
      // changes. Cheap (single existsSync against `.agent/no-history`).
      optOutReason: () => historyOptOutReason(baseConfig.cwd),
    },
    // Playbook dispatcher (`PLAYBOOKS.md` §1.4). Slash commands
    // built from subagent definitions invoke this to run a child
    // inline against the operator's session. Same `runSubagent`
    // path the harness uses for `task_*` tool calls — provider,
    // tool registry, permission engine, trust verdict all
    // inherited from `baseConfig`.
    //
    // Two preconditions surface early as user-visible errors so
    // the operator gets a clear cause rather than a deferred
    // failure mid-run:
    //
    //   1. Definition unknown — slash registration filtered defs
    //      without `slash:`, but a typo or dynamic shadow change
    //      could still produce a name the registry doesn't have.
    //
    // No "session yet" precondition: `ensureParentSessionId` lazily
    // creates a synthetic parent on the first dispatch when a real
    // turn hasn't run — the operator can `/review` immediately on
    // boot. The slash command itself further gates on `isRunning()`
    // so a slash dispatch never races a foreground turn.
    runPlaybook: async ({ name, prompt }) => {
      // Defensive serialization. The slash command's `exec` body
      // checks `ctx.isRunning()` before calling us, but a programmatic
      // caller (or a future slash path that forgets the gate) could
      // re-enter while a prior dispatch is still mid-flight. Refusing
      // here preserves the one-at-a-time contract regardless of how
      // we're invoked. Set the flag SYNCHRONOUSLY before any await so
      // a second dispatch queued in the same Enter burst sees
      // `isRunning() === true` and refuses cleanly via the slash
      // surface (which renders an operator-friendly error) rather
      // than landing on this throw.
      if (playbookRunning) {
        throw new Error(`playbook '${name}' rejected — another playbook dispatch is in flight`);
      }
      const definition = subagents.byName.get(name);
      if (definition === undefined) {
        throw new Error(`playbook '${name}' is not registered`);
      }
      playbookRunning = true;
      syncBusy();
      // Fresh per-dispatch controllers. `triggerInterrupt`
      // (Esc / Ctrl+C / SIGINT / modal-cancel) reads these as a
      // mirror of the foreground per-turn controllers and
      // aborts whichever pair is live. The finally block clears
      // them so a subsequent triggerInterrupt fired in idle
      // does not abort a stale signal.
      const ac = new AbortController();
      const softAc = new AbortController();
      playbookAbortController = ac;
      playbookSoftStopController = softAc;
      try {
        const parentSessionId = ensureParentSessionId();
        const runSubagentImpl = options.runSubagentOverride ?? runSubagent;
        // Capture the dispatch promise BEFORE awaiting so the
        // module-scope `playbookPromise` ref points at the same
        // settle the shutdown path can wait on. Without the
        // pre-await capture, shutdown would either close the DB
        // before the runtime's `setSubagentPayload` /
        // `reclassifySessionStatus` writes land or have nothing
        // to wait on at all.
        // Resolve once (the spread needs a narrowed const): explicit
        // providerEffort wins — none on the main session — else derive
        // from baseConfig.effort (the operator's /effort or default).
        const childProviderEffort = resolveProviderEffort(baseConfig);
        const dispatchPromise = runSubagentImpl({
          definition,
          prompt,
          parentSessionId,
          provider: baseConfig.provider,
          parentToolRegistry: baseConfig.toolRegistry,
          permissionEngine: baseConfig.permissionEngine,
          db,
          cwd: baseConfig.cwd,
          signal: ac.signal,
          softStopSignal: softAc.signal,
          subagentRegistry: subagents,
          ...(baseConfig.isCwdTrusted !== undefined ? { cwdTrusted: baseConfig.isCwdTrusted } : {}),
          // Forward the session-level temperature pin to the
          // child. Without this, /<playbook> dispatch diverges
          // from the foreground task_* spawn path
          // (harness/loop.ts ~1010), which DOES forward
          // config.temperature: an eval rig that started the
          // REPL with temperature: 0 would see deterministic
          // task_sync runs but nondeterministic /<playbook>
          // runs depending on the route the model picks.
          // Reading per-dispatch from baseConfig.provider so a
          // mid-session /model swap (which mints a new provider
          // object) is observed; reading temperature too keeps
          // the precedence ladder honest.
          ...(baseConfig.temperature !== undefined ? { temperature: baseConfig.temperature } : {}),
          // Forward the resolved provider-effort so /<playbook>
          // dispatch honors the operator's /effort (or configured
          // default) — same as the foreground task_* spawn path
          // (harness/loop.ts forwards resolveProviderEffort(config)).
          // Without this the child runs at the provider default while
          // the footer + /effort confirmation say a level is active.
          // Carries ONLY the provider axis; operational caps stay
          // per-playbook (child gets providerEffort, never effort).
          ...(childProviderEffort !== undefined ? { providerEffort: childProviderEffort } : {}),
          // Hook chain snapshot. The foreground task_* spawn path
          // in harness/loop.ts forwards config.hooks as
          // hooksSnapshot so the child uses the parent's validated
          // chain instead of re-resolving hooks.toml from disk —
          // closes the drift window where a human edit between
          // parent boot and child startup would land the child on
          // a different chain than the operator validated. Without
          // this forward the slash dispatch path opens that exact
          // drift hole; mirror the loop's wiring.
          ...(baseConfig.hooks !== undefined ? { hooksSnapshot: baseConfig.hooks } : {}),
          // Permission proxy (spec docs/spec/IPC.md §7). Without this
          // the runtime auto-denies every child `permission:ask`, so a
          // playbook that touches a confirm-gated tool (bash / write
          // under `confirm` policy) would silently fail with denials
          // instead of prompting the operator. Mirrors the harness's
          // spawnSubagentImpl wiring (loop.ts) — the `boolean ↔
          // PermissionDecision` shape adapter is the same one.
          onPermissionAsk: async (req) => {
            const allowed = await confirmPermission({
              toolName: req.toolName,
              args: req.args,
              cwd: req.cwd,
              prompt: req.prompt,
              subagent: req.subagent,
              signal: req.signal,
            });
            return allowed ? 'allow' : 'deny';
          },
        });
        playbookPromise = dispatchPromise;
        const result = await dispatchPromise;
        // Roll the playbook spend into the REPL cumulative tracker.
        // Without this, /cost reports zero for slash-dispatched
        // playbooks because the foreground `session_finished` path
        // (the only place cumulative is mutated) never fires for
        // them — the harness never ran for the parent. NaN-guarded
        // because a misbehaving runtime could synthesize a
        // non-finite cost on a kill path; including it would poison
        // the running total for every subsequent dispatch.
        if (Number.isFinite(result.costUsd)) {
          cumulative.costUsd += result.costUsd;
        }
        cumulative.steps += result.steps;
        cumulative.turns += 1;
        // Track the playbook child session so REPL-wide aggregation
        // (anything reading `replSessionIds`) sees the child's
        // session alongside the parent's. The child wrote its rows
        // into the same DB at execution time; we just need its
        // session id to find them again.
        trackReplSessionId(result.sessionId);
        return result;
      } finally {
        // Drop the gate even on throw — a stuck `playbookRunning`
        // would lock the operator out of every subsequent dispatch
        // until process restart. Same logic for the controllers
        // and the promise ref: clear them so a subsequent
        // triggerInterrupt / shutdown fired in idle does not
        // call abort() on a settled signal or await a stale
        // promise.
        playbookRunning = false;
        syncBusy();
        playbookAbortController = null;
        playbookSoftStopController = null;
        playbookPromise = null;
        // INBOX §9: the parent inbox drains after the subagent/playbook
        // ends — same boundary semantics as a foreground turn. Deferred
        // so it runs after this finally unwinds and `playbookRunning` is
        // observably false to the drain's isBusy() guard.
        queueMicrotask(() => drainInbox());
      }
    },
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

    // Operation-mode toggle (Shift+Tab): flip the approval posture
    // (Supervised ↔ Autonomous). Guarded so it only fires in the
    // normal edit state — a modal (modal-manager handler, pushed above
    // this one) intercepts Shift+Tab for option navigation, while the
    // reverse-search and slash sub-interactions own the keyboard while
    // open. Ctrl+Tab is unreliable across terminals (often unreported);
    // Shift+Tab is the de-facto mode-cycle key and is already parsed
    // (keys.ts). The engine is the source of truth — it applies on the
    // next check(); the bus event repaints the footer cue.
    if (
      key.kind === 'key' &&
      key.name === 'tab' &&
      key.shift === true &&
      !isReverseSearchOpen() &&
      !slashOpen
    ) {
      const engine = baseConfig.permissionEngine;
      const target = engine.approvalPosture() === 'supervised' ? 'autonomous' : 'supervised';
      try {
        engine.setApprovalPosture(target, 'operator toggle (shift+tab)');
      } catch (err) {
        bus.emit({
          type: 'warn',
          ts: now(),
          message: `could not change operation mode: ${(err as Error).message}`,
        });
      }
      // Mirror whatever the engine actually settled on — a refused
      // toggle (non-ready engine) or a failed audit leaves the posture
      // unchanged, so reading it back keeps the footer honest.
      bus.emit({ type: 'mode:change', ts: now(), posture: engine.approvalPosture() });
      cancelExitArm();
      return true;
    }

    // Reverse-search overlay (HISTORY.md §2.2). When the overlay is
    // open it owns the keyboard absolutely — the operator's draft
    // buffer is preserved in `state.input` (rendered dim below the
    // overlay) and only the search query mutates here. Mutually
    // exclusive with slash mode at the producer level: openReverseSearch
    // refuses while slashOpen is true, so we never hit both branches
    // on the same keystroke.
    if (isReverseSearchOpen()) {
      // Ctrl+R while open: cycle to older matches with the same query.
      if (key.kind === 'char' && key.ctrl && key.char === 'r') {
        cycleReverseSearchOlder();
        cancelExitArm();
        return true;
      }
      if (key.kind === 'key') {
        // Esc cancels: close overlay, leave buffer untouched (operator
        // returns to whatever draft they had before opening Ctrl+R).
        if (key.name === 'escape') {
          closeReverseSearch();
          cancelExitArm();
          return true;
        }
        // Enter accepts: substitute buffer with the current match
        // and submit. With no match, Enter is a no-op (won't submit
        // an empty match; let the operator backspace and try again).
        if (key.name === 'enter') {
          const match = currentReverseSearchMatch();
          if (match === null) return true;
          // A slash command recalled from history (slash commands are
          // recorded in history too) is STAGED into the buffer rather than
          // submitted or enqueued — either would send the command to the
          // model as plain text. Staging lets the operator's next Enter
          // route it through the slash dispatcher, preserving command
          // semantics. Checked above the busy/idle split so it holds in
          // both states.
          if (parseSlashInput(match) !== null) {
            bus.emit({ type: 'input:update', ts: now(), value: match, cursor: match.length });
            closeReverseSearch();
            cancelExitArm();
            return true;
          }
          if (isBusy()) {
            // Busy: enqueue the plain match into the inbox so it drains at
            // the next boundary (same path as a normal busy submit).
            enqueueInbox(match);
            closeReverseSearch();
            cancelExitArm();
            return true;
          }
          // Idle: substitute the buffer with the match and submit it now.
          bus.emit({ type: 'input:update', ts: now(), value: match, cursor: match.length });
          bus.emit({ type: 'user:submit', ts: now(), text: match });
          recordHistorySubmit(match);
          closeReverseSearch();
          startTurn(match);
          cancelExitArm();
          return true;
        }
        // Tab accepts to edit: substitute buffer, close overlay,
        // cursor at end of recalled prompt. No submit — operator
        // edits and presses Enter when ready.
        if (key.name === 'tab') {
          const match = currentReverseSearchMatch();
          if (match !== null) {
            bus.emit({ type: 'input:update', ts: now(), value: match, cursor: match.length });
          }
          closeReverseSearch();
          cancelExitArm();
          return true;
        }
        // Backspace shortens the query and re-runs the search.
        if (key.name === 'backspace') {
          const q = reverseSearchQuery ?? '';
          refreshReverseSearch(q.slice(0, -1));
          cancelExitArm();
          return true;
        }
        // ↑ / ↓ inside the overlay: ignored. Spec §2.2 lists Ctrl+R
        // as the only cycle key — arrows would conflict with the
        // top-line / bottom-line semantics of the editor's history
        // nav, and operators who want to walk the history outside a
        // search query should Esc first.
        if (key.name === 'up' || key.name === 'down') {
          return true;
        }
        // Other named keys (left, right, home, end, delete, etc.)
        // are swallowed too — none of them have meaningful semantics
        // inside the overlay, and forwarding to the editor would
        // mutate the (preserved) buffer, defeating the point of
        // "draft preserved below".
        return true;
      }
      // Printable chars (incl. Alt+letter, ignored modifiers): append
      // to the query and re-search. Most Ctrl+letter combos are
      // swallowed — forwarding Ctrl+W / Ctrl+U / Ctrl+K to the editor
      // would mutate the (preserved) input buffer, defeating the
      // "draft preserved below" contract of the overlay. But the
      // emergency-stop keys MUST keep working: Ctrl+C aborts the
      // current run (or arms the idle exit gate) and Ctrl+D exits
      // shell-style. The overlay can be opened mid-turn (Ctrl+R is
      // valid during running), so an operator who's regretting a
      // long-running tool must still be able to interrupt without
      // first remembering to press Esc — that's exactly the kind of
      // friction Ctrl+C is supposed to bypass.
      if (key.kind === 'char') {
        if (key.ctrl && key.char === 'c') {
          // Close the overlay, then route through the same ladder
          // the editor handler uses for raw-mode Ctrl+C: busy →
          // soft/hard interrupt; idle → arm/exit double-tap gate
          // (UI.md §5.4). cancelExitArm is implicit in
          // handleIdleInterrupt's arm path. `isBusy()` covers
          // both a foreground turn and an in-flight playbook so
          // either can be preempted from reverse-search mode.
          closeReverseSearch();
          if (isBusy()) {
            triggerInterrupt();
          } else {
            handleIdleInterrupt();
          }
          return true;
        }
        if (key.ctrl && key.char === 'd') {
          // EOF convention. busy → interrupt (consistent with the
          // editor handler's `result.cancelInput === 'eof'` branch);
          // idle → direct exit 130, no double-tap (shell EOF is one
          // explicit decision per spec UI.md §5.4).
          closeReverseSearch();
          if (isBusy()) {
            triggerInterrupt();
          } else {
            exitCode = 130;
            requestShutdown();
          }
          return true;
        }
        // Other Ctrl+letter combos stay swallowed — operator presses
        // Esc to leave the overlay and then has the full editor
        // shortcut palette available again.
        if (key.ctrl) return true;
        const q = reverseSearchQuery ?? '';
        refreshReverseSearch(q + key.char);
        cancelExitArm();
        return true;
      }
      // Paste: append the pasted text wholesale and re-search.
      if (key.kind === 'paste') {
        const q = reverseSearchQuery ?? '';
        refreshReverseSearch(q + key.text);
        cancelExitArm();
        return true;
      }
      return true;
    }

    // Ctrl+R outside the overlay opens it. Slash mode wins (operator
    // typing a command shouldn't have Ctrl+R yanked away as an
    // accidental side effect of a fresh history feature). Empty
    // history short-circuits — opening an overlay against zero
    // entries surfaces nothing to search.
    //
    // Two slash signals must both be clear, mirroring the
    // slash-precedence block above: `state.slash` (live popover) AND
    // `parseSlashInput(buffer)` (raw buffer starts with `/`). The
    // popover goes null when the typed command has zero autocomplete
    // matches (e.g. `/doesnotexist` mid-edit) — checking only the
    // popover would let Ctrl+R hijack a slash buffer that's still
    // mid-composition, which the §2.1 "slash mode wins" rule is
    // meant to forbid.
    //
    // Edit mode also wins (INBOX): while a queued message is lifted for
    // editing (editingQueued set), Ctrl+R is blocked. Otherwise the
    // operator could open search and accept a match — enqueueInbox(match)
    // clears the input but leaves editingId set, so the message being
    // edited stays hidden and held back at the next boundary with no edit
    // buffer (stranded). They finish/cancel the edit (Enter / ↓ / Esc)
    // first. Falls through to applyKey, where Ctrl+R is a NOOP, so the
    // edit buffer is untouched.
    if (
      editingQueued === null &&
      key.kind === 'char' &&
      key.ctrl &&
      key.char === 'r' &&
      historyEnabled &&
      historyEntries.length > 0 &&
      renderer.state().slash === null &&
      parseSlashInput(renderer.state().input.value) === null
    ) {
      openReverseSearch();
      cancelExitArm();
      return true;
    }

    // Alt+R — auto-display terse line for the current session
    // (RECAP.md §3.3, UI.md §5.4). Idle-only: mid-turn the
    // operator's attention is on the live output, and the projection
    // would race the writes the loop is making. Slash-mode wins
    // (operator typing `/recap` should not get Alt+R intercepted as
    // a side effect of the autocomplete state). No-op when no
    // session has finished yet (`lastSessionId === null`) — the
    // line would have nothing to project.
    if (
      key.kind === 'char' &&
      key.alt &&
      !key.ctrl &&
      (key.char === 'r' || key.char === 'R') &&
      !isBusy() &&
      renderer.state().slash === null &&
      parseSlashInput(renderer.state().input.value) === null
    ) {
      cancelExitArm();
      const sessionId = lastSessionId;
      if (sessionId === null) {
        bus.emit({
          type: 'warn',
          ts: now(),
          message: 'recap terse: no session yet (start a turn first)',
        });
        return true;
      }
      const auto = buildAutoTerse({ db, sessionId, now: now() });
      if (auto.ok) {
        // Same shape the harness adapter uses for session-end
        // recap_terse_ready: split markdown into per-line
        // `recap:terse` events. The renderer styles the prefix
        // bold + the line in secondary color (RECAP §3.3 +
        // UI.md §6.1).
        const lines = auto.markdown.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          bus.emit({ type: 'recap:terse', ts: now(), message: line });
        }
      } else {
        bus.emit({
          type: 'warn',
          ts: now(),
          message: `recap terse failed: ${auto.reason}`,
        });
      }
      return true;
    }

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
    // Pivoting an ↑ edit into a slash command ends the edit (the message
    // stays queued, unchanged) — its bar reappears. Queued messages never
    // start with `/` (slash input is dispatched, not queued), so this
    // can't fire spuriously right after a lift.
    if (bufferIsSlash) cancelQueuedEdit();
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
        // Two paths converge here. (1) Buffer has a typed name
        // (`/quit`, `/q foo`) — parsed.name is non-empty. (2) Buffer
        // is bare `/` and the popover is open with a live selection
        // — operator's intent is "run the highlighted item". The
        // popover takes precedence in both cases when a selection
        // exists, because it's the most specific signal of intent
        // (it tells us which command, regardless of how much the
        // operator typed). Args, if any, come from the buffer
        // (selection alone can't carry args).
        let effectiveName: string | null = null;
        if (slashState !== null && slashState.selectedIdx >= 0) {
          const pick = slashState.suggestions[slashState.selectedIdx];
          if (pick !== undefined) effectiveName = pick.name;
        }
        if (effectiveName === null && parsed !== null && parsed.name !== '') {
          effectiveName = parsed.name;
        }
        if (effectiveName === null) {
          // Bare `/` + Enter with NO selection (zero matches, or
          // popover already closed): nothing to execute. Falling
          // through would let applyKey emit submit:'/' and dispatch
          // a turn sending '/' to the model. Clear input + slash
          // mode and consume the keystroke.
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
        // the next Enter to retry. The echoed text reflects the
        // RESOLVED command (not the raw prefix) so scrollback +
        // history match what actually ran. resolveCommandName's
        // case-insensitive fallback covers exact-name typos
        // (`/Help` → `help`); the popover selection already
        // handled the prefix case above.
        const resolvedName = resolveCommandName(effectiveName);
        const args = parsed?.args ?? [];
        const echoText =
          args.length > 0 ? `/${resolvedName} ${args.join(' ')}` : `/${resolvedName}`;
        bus.emit({ type: 'user:submit', ts: now(), text: echoText });
        recordHistorySubmit(echoText);
        bus.emit({ type: 'slash:update', ts: now(), suggestions: [], selectedIdx: -1 });
        slashOpen = false;
        void dispatchSlash(
          { name: resolvedName, args },
          { registry: slashRegistry, ctx: slashCtx },
        );
        return true;
      }
    }

    const current = renderer.state().input;

    // INBOX edit (docs/spec/INBOX.md §4.2 / §6.1 "↑ edit"). When the
    // queue is non-empty and the prompt is empty, ↑ lifts the most
    // recent queued message into the input for editing — taking
    // precedence over history recall (which only runs with an empty
    // queue / no active edit, below). The message STAYS in the queue
    // (its bar hidden); Enter writes the edit back in place, ↓ restores
    // it unchanged. Gated on an empty buffer so ↑ inside a draft still
    // recalls history / moves the cursor.
    if (
      editingQueued === null &&
      inbox.length > 0 &&
      current.value === '' &&
      key.kind === 'key' &&
      key.name === 'up'
    ) {
      const item = inbox[inbox.length - 1];
      if (item !== undefined) {
        // Mark it as being edited (it STAYS in the queue — never popped)
        // and load its text into the input. The renderer hides its bar
        // via editingId; commit writes the edit back in place.
        editingQueued = { id: item.id };
        bus.emit({ type: 'inbox:edit-start', ts: now(), id: item.id });
        bus.emit({ type: 'input:update', ts: now(), value: item.text, cursor: item.text.length });
        cancelExitArm();
        return true;
      }
    }
    // ↓ or Esc while editing cancels the edit: the message stays queued
    // unchanged and the input clears (↓ mirrors history's ↓-restores; Esc
    // is the documented cancel key, INBOX §6.1). Intercepted HERE, before
    // applyKey turns Esc into an `interruptSoft` with an unchanged buffer:
    // otherwise Esc would skip the empty-buffer cancel above (buffer not
    // emptied) and fall to the soft-interrupt branch — interrupting the
    // turn when busy, a no-op when idle — leaving the edit stranded.
    if (
      editingQueued !== null &&
      key.kind === 'key' &&
      (key.name === 'down' || key.name === 'escape')
    ) {
      cancelQueuedEdit();
      bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
      cancelExitArm();
      return true;
    }

    // History navigation (HISTORY.md §2.1). Slash precedence is
    // governed by `state.slash !== null` (live popover) per spec §2.1
    // — handled in the slashState branch above. With slash mode off
    // (or popover collapsed), ↑/↓ either walk history or move the
    // cursor, depending on whether the cursor sits on the topmost
    // (↑) / bottommost (↓) line of a multi-line buffer. Once we're
    // already navigating history (`historyIdx !== null`), every ↑/↓
    // stays in history mode until ↓ steps past the newest entry and
    // restores the scratch buffer — operators who walked back several
    // entries can keep walking without their column position in a
    // recalled multi-line buffer accidentally redirecting the keys
    // back into vertical cursor motion.
    if (
      editingQueued === null &&
      historyEnabled &&
      historyEntries.length > 0 &&
      key.kind === 'key' &&
      (key.name === 'up' || key.name === 'down')
    ) {
      const buf = current;
      const navigatingHistory = historyIdx !== null;
      const cursorAtTopLine = buf.value.slice(0, buf.cursor).indexOf('\n') === -1;

      if (key.name === 'up' && (navigatingHistory || cursorAtTopLine)) {
        if (historyIdx === null) {
          historyScratch = buf.value;
          historyIdx = historyEntries.length - 1;
        } else if (historyIdx > 0) {
          historyIdx -= 1;
        }
        // else: clamp at oldest (HISTORY.md §2.1 "Clamp no oldest").
        const pick = historyEntries[historyIdx] ?? '';
        bus.emit({ type: 'input:update', ts: now(), value: pick, cursor: pick.length });
        cancelExitArm();
        return true;
      }

      if (key.name === 'down' && navigatingHistory) {
        const nextIdx = (historyIdx ?? 0) + 1;
        if (nextIdx >= historyEntries.length) {
          // Past newest → restore the live buffer the operator was
          // typing before they started navigating.
          historyIdx = null;
          const restore = historyScratch ?? '';
          historyScratch = null;
          bus.emit({ type: 'input:update', ts: now(), value: restore, cursor: restore.length });
        } else {
          historyIdx = nextIdx;
          const pick = historyEntries[nextIdx] ?? '';
          bus.emit({ type: 'input:update', ts: now(), value: pick, cursor: pick.length });
        }
        cancelExitArm();
        return true;
      }
      // ↓ on bottom line of the live buffer (not navigating) is a
      // no-op for history but still useful for the editor (matches
      // readline behavior — moves cursor to end of buffer). Fall
      // through.
    }

    // Footer's `? for help` cue (UI.md §4.10.6) needs to actually
    // do something. Pressing `?` with an empty buffer dispatches the
    // /help slash command — same effect as typing `/help` + Enter,
    // but with a single keystroke. Once there's any content in the
    // buffer (operator started typing a question that begins with
    // `?`), `?` falls through as a literal character.
    if (current.value === '' && key.kind === 'char' && key.char === '?' && !key.ctrl && !key.alt) {
      // The ? shortcut ends any in-progress ↑ edit (message stays queued).
      cancelQueuedEdit();
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

    // If an edit action empties a lifted queued-message buffer — Backspace
    // to empty, Ctrl+U / Ctrl+W, or Ctrl+C's local clear — cancel the
    // edit. Otherwise editingId stays set with an empty prompt and no
    // visible bar: the message is hidden AND held out of drainInbox (a
    // silent strand) until the operator stumbles onto ↓/Esc, and Enter is
    // a no-op. Keying off the non-empty→empty transition covers every
    // emptying operation, not just Ctrl+C — and subsumes the per-key edit
    // cancel that the interrupt (Ctrl+C-empty) and EOF (Ctrl+D) branches
    // would otherwise need, since the buffer must empty (and cancel here)
    // before either of those can fire while editing.
    if (editingQueued !== null && current.value !== '' && result.next.value === '') {
      cancelQueuedEdit();
    }

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

    // Enter routing (INBOX docs/spec/INBOX.md §4.1 / §4.2):
    //   - editing an ↑-lifted message → commit the edit in place.
    //   - idle   → submit now (echo + history + startTurn), as before.
    //   - busy   → queue it instead of dropping it (the old behavior left
    //     it lingering in the buffer). It renders as a pending bar and
    //     drains as the next turn at the boundary; the `inbox:queued`
    //     reducer clears the input so the operator can keep typing.
    // Slash commands never reach here — the slash branch above consumes
    // Enter when the buffer starts with `/`.
    if (result.submit !== undefined) {
      const editing = editingQueued;
      editingQueued = null;
      if (editing !== null) {
        // Commit an ↑ edit: write the new text into the queued message in
        // place (FIFO position kept), end the edit, clear the input.
        const item = inbox.find((m) => m.id === editing.id);
        if (item !== undefined) item.text = result.submit.text;
        // No recordHistorySubmit here — the finalized text is recorded
        // when it drains (drainInbox), so the stale pre-edit text never
        // enters the recall pool.
        bus.emit({
          type: 'inbox:edit-commit',
          ts: now(),
          id: editing.id,
          text: result.submit.text,
        });
        bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
        // If the turn ended while editing (the boundary held this message
        // back), the REPL is idle and no boundary will fire — drain the
        // just-committed edit now so it's actually sent as the next turn.
        if (!isBusy()) queueMicrotask(() => drainInbox());
      } else if (result.submit.text.startsWith('!')) {
        // Operator shell command (`!cmd`) — runs as the operator's own
        // shell, not the agent (the engine gates the agent, not the
        // human). No `user:submit` echo / inbox: the result lands as its
        // own `operator-bash` scrollback card.
        const command = result.submit.text.slice(1).trim();
        if (command === '') {
          // Bare `!` (or `!` + only blanks) — nothing to run; clear it.
          bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
        } else if (isBusy()) {
          // Serialize against turns / playbooks / another `!`. Leave the
          // command in the buffer so it can be re-submitted once idle.
          bus.emit({
            type: 'warn',
            ts: now(),
            message:
              'operator command refused: a turn is in flight — wait for it to finish, then re-run',
          });
        } else {
          bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });
          recordHistorySubmit(result.submit.text);
          runOperatorBash(command);
        }
      } else if (isBusy()) {
        enqueueInbox(result.submit.text);
      } else {
        bus.emit({ type: 'user:submit', ts: now(), text: result.submit.text });
        recordHistorySubmit(result.submit.text);
        startTurn(result.submit.text);
      }
    }

    // Ctrl+C with empty buffer:
    //   - busy → soft/hard interrupt ladder (same as Esc and SIGINT).
    //     `isBusy()` covers both a foreground turn and an in-flight
    //     playbook so either can be preempted from the editor.
    //   - idle → double-tap gate (UI.md §5.4): first press arms,
    //     second within 2s exits 130. Synchronous shutdown gate
    //     (`exiting` set in requestShutdown) keeps a stray follow-up
    //     keystroke from racing past the check.
    if (result.cancelInput === 'interrupt') {
      // (No edit handling needed: Ctrl+C here fires only on an already-
      // empty buffer, and the empty-buffer check above already cancelled
      // any in-progress edit the moment its buffer emptied.)
      if (isBusy()) {
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
      // (No edit handling needed: EOF fires only on an already-empty
      // buffer, and the empty-buffer check above already cancelled any
      // in-progress edit the moment its buffer emptied.)
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
    if (result.interruptSoft === true && (running || operatorBashRunning)) {
      triggerInterrupt();
    }

    return true;
  };
  focusStack.push(editorHandler);

  // Stdin pump (parser, drain, panic-key, lone-ESC) was prepared
  // pre-bootstrap but its subscription was DEFERRED so events
  // didn't drop into an empty focus stack. Now that the editor
  // handler is on top, attach. Idempotent (`subscribeStdin` no-ops
  // when the trust-prompt path already subscribed).
  subscribeStdin();

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
  // there's nothing useful to communicate.
  const providerCaps = baseConfig.provider.capabilities;
  // UI.md §4.10.9 discriminates env entries: `flag` for binary
  // capability indicators (rendered as `✓ name` in success palette),
  // `meta` for non-binary key:value (rendered dim).
  const env: SessionBannerEvent['env'] = [];
  if (resumedSessionId !== null) {
    // Short id (first 8 chars of the UUID head) — full id is 36
    // chars and would crowd the banner; the head is unique enough
    // for visual confirmation and `/list-sessions` shows the full
    // form for anyone who needs to copy it.
    env.push({ kind: 'meta', key: 'resumed', value: resumedSessionId.slice(0, 8) });
  }
  if (subagents.byName.size > 0) {
    env.push({ kind: 'meta', key: 'subagents', value: String(subagents.byName.size) });
  }
  // Memory count (D68 follow-up, closed by Slice F'). Dedupe-by-name
  // matches the "active memories" semantic — operator sees the count
  // of distinct names available, not the raw cross-scope total. Zero
  // omits the entry per the env-summary "no useful info" rule.
  if (baseConfig.memoryRegistry !== undefined) {
    const memoryCount = baseConfig.memoryRegistry.count({ deduplicateByName: true });
    if (memoryCount > 0) {
      env.push({ kind: 'meta', key: 'memory', value: String(memoryCount) });
    }
  }
  // Skills count — the resolved catalog the model sees in its
  // `# Skills` prompt block. Mirrors `memory` above: skills and
  // memory are sibling catalogs surfaced to the model, so the
  // operator gets the same at-a-glance count. Zero omits the entry
  // per the env-summary "no useful info" rule.
  if (baseConfig.skillCatalog !== undefined) {
    const skillCount = baseConfig.skillCatalog.count();
    if (skillCount > 0) {
      env.push({ kind: 'meta', key: 'skills', value: String(skillCount) });
    }
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
    maxOutputTokens: resolveMaxOutputTokens(
      effectiveBudget(baseConfig.budget, baseConfig.effort),
      providerCaps,
    ),
    cwd: baseConfig.cwd,
    env,
    // Seed the footer's operation-mode cue from the engine's posture so
    // a `--autonomous` boot shows Autonomous from the first frame.
    operationMode: baseConfig.permissionEngine.approvalPosture(),
    // Seed the footer's effort chip from the resolved session effort
    // (config/DEFAULT_EFFORT). Optional on the event; omitted only when
    // unset, which after bootstrap doesn't happen on the main session.
    ...(baseConfig.effort !== undefined ? { effort: baseConfig.effort } : {}),
    // §13.7 — when sandbox enforcement is active, append the line
    // inline inside the banner block (secondary, no leading blank).
    // The non-active states ride warn/error events below.
    ...(sandboxEnforcement.reason === 'active' && sandboxEnforcement.tool !== null
      ? { sandboxActive: sandboxEnforcement.tool }
      : {}),
  });

  // Trust prompt was already handled in the pre-bootstrap stack —
  // see "Trust prompt (AGENTIC_CLI §9.1)" earlier in this function.
  // Reaching this line means the operator either accepted or the
  // cwd was already trusted.

  // §13.7 sandbox-enforcement banner. Surfaces "is bash being
  // wrapped?" to operators who never run `agent doctor`. Four
  // states from the bootstrap snapshot (see
  // SandboxEnforcementSnapshot in bootstrap.ts):
  //
  //   - `active`               → rendered INLINE inside the
  //                              session-banner block via
  //                              `sandboxActive` field on the
  //                              event above (secondary, no leading
  //                              blank). The affirmative posture is
  //                              part of the banner frame, not a
  //                              separate alert.
  //   - `no-tool`              → warn: actionable; engine permission
  //                              floors still defend but spawn wrap
  //                              is absent.
  //   - `operator-override`    → warn: deliberate opt-out; banner
  //                              acknowledges the operator's choice.
  //   - `degraded-passthrough` → error: operator passed --broker
  //                              spawn on a host without the binary;
  //                              misleading if not surfaced loudly.
  //
  // Exhaustive switch (not if-else chain) so a future addition to
  // `SandboxEnforcementSnapshot.reason` forces a compile error here
  // via the `never` default — defense against silent fall-through
  // when the discriminator grows underneath a stale consumer.
  switch (sandboxEnforcement.reason) {
    case 'active':
      // Rendered inline inside the session-banner block above via
      // the `sandboxActive` field. No event here — the affirmative
      // path stays inside the banner frame.
      break;
    case 'no-tool':
      bus.emit({
        type: 'warn',
        ts: now(),
        message:
          '⚠ sandbox enforcement disabled — install bubblewrap (linux) or verify sandbox-exec on $PATH (macOS) to enable wrap-on-spawn',
      });
      break;
    case 'operator-override':
      bus.emit({
        type: 'warn',
        ts: now(),
        message:
          '⚠ sandbox enforcement disabled (operator chose --broker in-process); bash spawns are not wrapped',
      });
      break;
    case 'degraded-passthrough':
      bus.emit({
        type: 'error',
        ts: now(),
        message:
          '⚠ sandbox enforcement degraded — --broker spawn requested but sandbox tool missing; bash spawns run unwrapped via passthrough',
      });
      break;
    default: {
      const _exhaustive: never = sandboxEnforcement.reason;
      void _exhaustive;
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

  // History first-run privacy banner (HISTORY.md §3.2). Drops two
  // info lines into scrollback the first time the operator REPLs in
  // a project; subsequent boots stay quiet thanks to the ack marker.
  // `errSink` doubles as the warn sink for marker-write failures —
  // matches the trust prompt's posture (operator sees the diagnostic
  // without losing the boot).
  maybeEmitHistoryBanner({
    bus,
    cwd: baseConfig.cwd,
    now,
    warn: (m) => errSink(`forja: ${m}\n`),
  });

  // Replay the prior session's scrollback when --resume seeded a
  // sessionId. Runs AFTER the banner + permission/history hints so
  // the operator's eye lands first on the boot context, then on
  // the historical conversation, then on the empty input prompt.
  // Replay drops PermanentItems directly into scrollback; the
  // renderer's incremental frame pipeline handles a burst of
  // events without flashing. Text-only in this slice — tool cards
  // pick up in a follow-up.
  //
  // Fail-soft: a corrupt content blob (parseJsonSafe throws) or a
  // DB read failure shouldn't crash the boot. Surface the error
  // via errSink + an info line in scrollback so the operator
  // understands why the conversation didn't reappear, then keep
  // going with an empty scrollback. The LLM still has the prior
  // context via `resumeFromSessionId`, so the operator can keep
  // typing — they just lose the visual recap. Better than crashing
  // them out of a half-drawn REPL.
  if (resumedSessionId !== null) {
    try {
      const replay = replaySessionMessages(db, resumedSessionId, bus);
      // Anchor between historical scrollback and the empty prompt:
      // an info line attributing the rows above to the resume and
      // marking "everything below is new". Without this, an
      // operator opening a deep history can mistake the last
      // assistant text for a turn they already typed today.
      if (replay.turns > 0) {
        bus.emit({
          type: 'info',
          ts: now(),
          // `secondary` (grey) — the anchor is visual scaffolding
          // separating history from new turns, not content; it
          // should recede next to the replayed conversation.
          tone: 'secondary',
          message: `— resumed ${replay.turns} prior ${replay.turns === 1 ? 'turn' : 'turns'} (history above; new turns below) —`,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
      errSink(`forja: failed to replay resumed session scrollback — ${msg}\n`);
      bus.emit({
        type: 'info',
        ts: now(),
        message: `(resumed session ${resumedSessionId.slice(0, 8)} — scrollback could not be rendered; LLM still has the context)`,
      });
    }
  }

  // Initial frame: emit one input:update with the empty buffer so the
  // renderer draws the `> ` prompt before the user types. Without
  // this the screen sits blank until the first keystroke.
  bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });

  await exitPromise;
  process.removeListener('SIGINT', sigintHandler);
  return exitCode;
};
