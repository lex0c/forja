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
import { isGitRepo } from '../checkpoints/git.ts';
import { type HarnessConfig, type HarnessResult, runAgent } from '../harness/index.ts';
import { DEFAULT_BUDGET } from '../harness/types.ts';
import {
  type FocusHandler,
  type HarnessAdapter,
  type KeyEvent,
  type UIEvent,
  applyKey,
  createBus,
  createFocusStack,
  createHarnessAdapter,
  createKeyParser,
  createModalManager,
  createRenderer,
  detectCapabilities,
} from '../tui/index.ts';
import type { ParsedArgs } from './args.ts';
import { type BootstrapInput, type BootstrapResult, bootstrap } from './bootstrap.ts';
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
}

// One-shot subscriber: drops `session:end` so the renderer doesn't
// flip into the "ended" state between turns. The reducer's
// `user:submit` branch already resets `ended` (so a stray late event
// wouldn't strand us), but skipping `session:end` entirely keeps the
// scrollback cleaner — the next user prompt is the natural divider
// between turns. If callers want a footer line on every turn, we can
// add a `warn` divider here later; deliberately dropping for now.
const filterUiEvent = (event: UIEvent): boolean => event.type !== 'session:end';

export const runRepl = async (options: RunReplOptions): Promise<number> => {
  const { args } = options;
  const errSink = options.errSink ?? ((s: string) => process.stderr.write(s));
  const stdin = options.stdin ?? process.stdin;
  const now = options.now ?? ((): number => Date.now());

  const caps = detectCapabilities();
  if (!caps.isTTY && options.skipTtyCheck !== true) {
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
  const { config: baseConfig, db, modelId, lockConflicts, subagents } = bootstrapped;

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
  const maxSteps = baseConfig.budget?.maxSteps ?? DEFAULT_BUDGET.maxSteps;
  const adapterCtxBase = {
    profile: 'autonomous' as const,
    project,
    model: modelId,
    maxSteps,
    ...(baseConfig.budget?.maxCostUsd !== undefined
      ? { maxCostUsd: baseConfig.budget.maxCostUsd }
      : {}),
  };

  const bus = createBus();
  const focusStack = createFocusStack();
  const renderer = createRenderer({
    bus,
    caps,
    stdin,
    ...(options.rendererWrite !== undefined ? { write: options.rendererWrite } : {}),
  });
  // Modal manager wired but no producer calls it yet — the harness's
  // permission engine doesn't bridge to the bus in this slice. Lands
  // when the permission/trust producers connect.
  const modalManager = createModalManager({ bus, focusStack });

  let running = false;
  let lastSessionId: string | null = null;
  let abortController: AbortController | null = null;
  // The promise returned by the in-flight runAgent (already wrapped
  // in `.catch().finally()`, so awaiting never throws). `shutdown`
  // awaits this before closing the DB so the harness's async cleanup
  // (final persistence, audit) doesn't race a closed handle.
  let runningPromise: Promise<void> | null = null;
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
  };

  const startTurn = (text: string): void => {
    if (running || exiting) return;
    running = true;
    abortController = new AbortController();
    const adapter = createHarnessAdapter(adapterCtxBase);
    const cfg: HarnessConfig = {
      ...baseConfig,
      userPrompt: text,
      signal: abortController.signal,
      onEvent: (e) => onHarnessEvent(adapter, e),
      ...(lastSessionId !== null ? { resumeFromSessionId: lastSessionId } : {}),
    };
    const runAgentImpl = options.runAgentOverride ?? runAgent;
    runningPromise = runAgentImpl(cfg)
      .then((result) => {
        lastSessionId = result.sessionId;
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        bus.emit({ type: 'error', ts: now(), message: msg });
      })
      .finally(() => {
        running = false;
        abortController = null;
        runningPromise = null;
      });
  };

  const shutdown = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (abortController !== null) abortController.abort();
    // Let the harness's async cleanup settle on the aborted signal
    // before tearing down the DB. Without this await, db.close() can
    // land before the harness flushes its final message/audit rows
    // and SQLite throws on the closed handle. The promise is already
    // .catch()ed so awaiting never throws.
    if (runningPromise !== null) await runningPromise;
    modalManager.close();
    renderer.close();
    stdin.removeListener('data', onData);
    if (typeof stdin.pause === 'function') stdin.pause();
    db.close();
    resolveExit();
  };

  // Input editor focus handler. Sits at the bottom of the focus
  // stack — modal-manager pushes its own handler on top when a modal
  // opens, intercepting keys before the editor sees them.
  const editorHandler: FocusHandler = (key: KeyEvent): boolean => {
    const current = renderer.state().input;
    const result = applyKey(current, key);

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
    }

    // Enter while a turn is running is ignored — no double-submit. The
    // typed text stays in the buffer (applyKey doesn't clear; only the
    // user:submit reducer would, which we're not emitting). The user
    // can hit Enter again once the turn ends.
    if (result.submit !== undefined && !running) {
      bus.emit({ type: 'user:submit', ts: now(), text: result.submit.text });
      startTurn(result.submit.text);
    }

    // Ctrl+C with empty buffer → exit (only when idle; while a run is
    // in progress, the SIGINT handler aborts instead).
    if (result.cancelInput === true && !running) {
      void shutdown();
    }

    // Soft interrupt (single Esc) → abort the running turn. Esc with
    // no run in progress is a no-op.
    if (result.interruptSoft === true && running && abortController !== null) {
      abortController.abort();
    }

    return true;
  };
  focusStack.push(editorHandler);

  // Stdin pump: feed bytes into the parser, dispatch each parsed key
  // through the focus stack. Bracketed paste handled inside the
  // parser (one `paste` event per chunk).
  const parser = createKeyParser();
  const onData = (chunk: Buffer): void => {
    if (exiting) return;
    const events = parser.feed(chunk);
    for (const ev of events) focusStack.dispatch(ev);
  };
  stdin.on('data', onData);
  if (typeof stdin.resume === 'function') stdin.resume();

  // SIGINT: while a run is in flight, abort it; otherwise exit. The
  // editor's Ctrl+C handling overlaps but isn't redundant: keyboard
  // Ctrl+C in raw mode lands as a `cancelInput` editor signal,
  // SIGINT lands here. Both routes converge on the same outcome.
  const sigintHandler = (): void => {
    if (running && abortController !== null) {
      abortController.abort();
    } else {
      exitCode = 130;
      void shutdown();
    }
  };
  process.on('SIGINT', sigintHandler);

  // Welcome banner (UI.md §4.10.9). Goes to scrollback before any
  // live frame so it sits at the top of the conversation transcript.
  // Env summary entries land conditionally — D68 says omit when
  // there's nothing useful to communicate. Memory entry count
  // omitted until the registry exposes a sync count method.
  const providerCaps = baseConfig.provider.capabilities;
  const env: { key: string; value: string }[] = [];
  if (subagents.byName.size > 0) {
    env.push({ key: 'subagents', value: String(subagents.byName.size) });
  }
  // Checkpoints only show when they'll actually fire. Both halves
  // matter: enableCheckpoints=false (plan mode, opt-out) and
  // enableCheckpoints=true with non-git cwd both result in no
  // rollback at runtime — banner stays silent rather than promising
  // a feature that won't deliver.
  if (baseConfig.enableCheckpoints === true && (await isGitRepo(baseConfig.cwd))) {
    env.push({ key: 'checkpoints', value: 'enabled' });
  }
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

  // Initial frame: emit one input:update with the empty buffer so the
  // renderer draws the `> ` prompt before the user types. Without
  // this the screen sits blank until the first keystroke.
  bus.emit({ type: 'input:update', ts: now(), value: '', cursor: 0 });

  await exitPromise;
  process.removeListener('SIGINT', sigintHandler);
  return exitCode;
};
