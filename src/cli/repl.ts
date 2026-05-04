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
import { type HarnessConfig, type HarnessResult, runAgent } from '../harness/index.ts';
import { DEFAULT_BUDGET } from '../harness/types.ts';
import { createDefaultRegistry } from '../providers/registry.ts';
import {
  HISTORY_CAP,
  appendHistory,
  historyOptOutReason,
  loadHistory,
  searchHistory,
} from '../storage/history.ts';
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
  bootstrapFn?: (input: BootstrapInput) => BootstrapResult;
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
    bootstrapped =
      options.bootstrapOverride ??
      bootstrapFn({
        prompt: '',
        // Pin bootstrap's cwd to the same string we trust-checked
        // above. Without this they'd both default to process.cwd()
        // independently and stay coherent in practice, but pinning
        // makes the invariant load-bearing rather than coincidental.
        cwd,
        ...(args.model !== undefined ? { modelId: args.model } : {}),
        ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
        ...(args.plan === true ? { plan: true } : {}),
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
      } satisfies BootstrapInput);
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
  });

  // bus / focusStack / renderer / modalManager / parser / `running`
  // / `exiting` / `exitCode` / `resolveExit` / `exitPromise` /
  // `onData` / `cancelDrain` / `onModalInterrupt` are all hoisted
  // above the trust prompt — see "Pre-bootstrap stack" earlier in
  // this function.
  let lastSessionId: string | null = null;

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
      confirmMemoryWrite,
      confirmMemoryUserScope,
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
          if (running) {
            // Mid-turn protection: same gate the normal Enter path
            // honors (`!running`). Operator gets the recalled buffer
            // staged but no submit until the turn ends.
            bus.emit({ type: 'input:update', ts: now(), value: match, cursor: match.length });
            closeReverseSearch();
            return true;
          }
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
          // the editor handler uses for raw-mode Ctrl+C: running →
          // soft/hard interrupt; idle → arm/exit double-tap gate
          // (UI.md §5.4). cancelExitArm is implicit in
          // handleIdleInterrupt's arm path.
          closeReverseSearch();
          if (running) {
            triggerInterrupt();
          } else {
            handleIdleInterrupt();
          }
          return true;
        }
        if (key.ctrl && key.char === 'd') {
          // EOF convention. running → interrupt (consistent with the
          // editor handler's `result.cancelInput === 'eof'` branch);
          // idle → direct exit 130, no double-tap (shell EOF is one
          // explicit decision per spec UI.md §5.4).
          closeReverseSearch();
          if (running) {
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
    if (
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
        recordHistorySubmit(val);
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
      recordHistorySubmit(result.submit.text);
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

  // Trust prompt was already handled in the pre-bootstrap stack —
  // see "Trust prompt (AGENTIC_CLI §9.1)" earlier in this function.
  // Reaching this line means the operator either accepted or the
  // cwd was already trusted.

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

  // Initial frame: emit one input:update with the empty buffer so the
  // renderer draws the `> ` prompt before the user types. Without
  // this the screen sits blank until the first keystroke.
  bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });

  await exitPromise;
  process.removeListener('SIGINT', sigintHandler);
  return exitCode;
};
