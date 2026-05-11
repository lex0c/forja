// §13.6 degraded banner re-display — PERMISSION_ENGINE.md slice 92.
//
// The engine's state machine emits ONE state-transition event when
// the engine drops from `ready` to `degraded` (sandbox lost mid-
// session, classifier offline, etc.). That single emission is
// sufficient for audit, but it's NOT sufficient for the operator:
// after 5 minutes of `confirm-on-every-call` UX, they need a
// recurring nudge to investigate. Spec line 905-908:
//
//   Banner é:
//   - Não-suprimível durante a sessão atual
//   - Re-exibido a cada N tool calls (default 10)
//   - Logado em audit como sandbox_degraded_active
//
// This module is the recurring trigger. The harness calls
// `notifyToolCall(sessionId)` after each tool dispatch. The emitter
// queries the engine state; when state is `degraded`, it fires:
//   - on FIRST tool call after transitioning into degraded
//     (regardless of N) — operators see the banner immediately;
//   - on EVERY Nth call thereafter (default 10).
//
// When the engine transitions back to `ready` (operator ran
// `agent doctor` + fixed the issue + the engine called
// `restore()`), the counter resets so the next degraded transition
// fires its own immediate banner.
//
// Out of scope:
//   - Banner suppression (intentionally not exposed — spec says
//     "não-suprimível durante a sessão atual");
//   - Visual rendering (the renderer subscribes to the HarnessEvent
//     and decides the format);
//   - Telemetry emission (caller's choice; the emitter just signals
//     "fire now", caller routes to renderer + telemetry).

import type { EngineState } from './state-machine.ts';

export interface DegradedBannerEvent {
  // Tool-call-relative timestamp the banner should claim. The
  // emitter computes via `now()` at fire time; tests pin via the
  // `now` test seam.
  ts: number;
  // Session this banner is tagged to. Renderers correlate with
  // their own session display.
  sessionId: string;
  // Operator-readable reason the engine is degraded. Pulled from
  // `getReason()` if supplied; empty string when no reason was
  // wired in (degraded for reasons the harness can't articulate).
  reason: string;
  // True only on the FIRST emission after entering degraded.
  // Renderers may format the initial banner differently from
  // recurring nudges ("⚠ Sandbox no longer available" first, then
  // "⚠ Sandbox still unavailable" subsequently).
  firstEmission: boolean;
}

export interface DegradedBannerEmitter {
  // Hook the harness invokes after each tool call completes.
  // Cheap (single state read + counter check) — safe to call
  // on every tool dispatch.
  notifyToolCall(sessionId: string): void;
}

export interface CreateDegradedBannerEmitterOptions {
  // Read the current engine state. Production: closure around
  // `engine.state()`. Tests: scripted state machine.
  getState: () => EngineState;
  // Called when the emitter decides a banner SHOULD fire. Caller
  // routes to harness onEvent (renderer banner) + telemetry sink
  // (metric stream). Cheap fire-and-forget contract.
  onFire: (event: DegradedBannerEvent) => void;
  // Optional reason getter. Defaults to empty string. The engine
  // doesn't surface "why degraded" through `state()`; if the
  // harness has the reason in scope (e.g., from the most recent
  // transition event), it can feed via this closure.
  getReason?: () => string;
  // Interval between recurring banners. Spec default 10; tests
  // override for deterministic assertions. Must be ≥ 1.
  intervalCalls?: number;
  // Wallclock seam.
  now?: () => number;
}

export const createDegradedBannerEmitter = (
  options: CreateDegradedBannerEmitterOptions,
): DegradedBannerEmitter => {
  const intervalCalls = options.intervalCalls ?? 10;
  if (!Number.isInteger(intervalCalls) || intervalCalls < 1) {
    throw new Error(
      `createDegradedBannerEmitter: intervalCalls must be integer >= 1, got ${intervalCalls}`,
    );
  }
  const now = options.now ?? (() => Date.now());
  const getReason = options.getReason ?? (() => '');

  let countSinceLastBanner = 0;
  let inDegraded = false;

  const fire = (sessionId: string, firstEmission: boolean): void => {
    options.onFire({
      ts: now(),
      sessionId,
      reason: getReason(),
      firstEmission,
    });
    countSinceLastBanner = 0;
  };

  return {
    notifyToolCall: (sessionId) => {
      const state = options.getState();
      if (state !== 'degraded') {
        // Transition away — reset state. Next entry into degraded
        // fires a fresh first-emission banner.
        inDegraded = false;
        countSinceLastBanner = 0;
        return;
      }
      if (!inDegraded) {
        // Just entered degraded (or first tool call after entering).
        // Fire immediately — operators shouldn't wait N calls to
        // see why every call is asking for confirm.
        inDegraded = true;
        fire(sessionId, true);
        return;
      }
      // Already in degraded; count + fire every Nth call.
      countSinceLastBanner += 1;
      if (countSinceLastBanner >= intervalCalls) {
        fire(sessionId, false);
      }
    },
  };
};
