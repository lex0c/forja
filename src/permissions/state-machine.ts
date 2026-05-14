// Engine state machine. The engine walks through explicit phases
// at bootstrap and can dynamically transition between `ready` and
// `degraded` while running. `refusing` is the fatal sink — once
// entered, only an operator-driven reset (new session,
// --accept-broken-chain bypass, --rotate-chain) gets out.
//
//   init → loading-policy → validating-chain → ready ↔ degraded
//                                       ↓
//                                    refusing (fatal)
//
// State affects `check()`:
//
//   init, loading-policy, validating-chain  → every call denies
//                                              ("engine not ready")
//   refusing                                 → every call denies (fatal)
//   ready                                    → pipeline runs normally
//   degraded                                 → pipeline runs, but every
//                                              `allow` is upgraded to
//                                              `confirm`
//
// The controller is a stand-alone object so bootstrap code can drive
// transitions externally (the engine holds a reference and reads the
// current state on each check). Tests can build a controller, feed
// it a sequence of transitions, and assert the observed events.

export type EngineState =
  | 'init'
  | 'loading-policy'
  | 'validating-chain'
  | 'ready'
  | 'degraded'
  | 'refusing';

// Reasons the operator surfaces in audit + UI when a transition
// fires. Free-form string so future slices can add specific causes
// (sandbox_unavailable, sealing_target_down, classifier_offline,
// policy_reload_failed_strict, chain_break_accepted, ...) without a
// schema bump.
export interface StateTransition {
  from: EngineState;
  to: EngineState;
  reason: string;
  ts: number;
}

// Valid edges. Anything not listed throws on attempt — silent
// "stay where you are" semantics would mask programming bugs
// (e.g. trying `refusing → ready` without a reset path).
const VALID_TRANSITIONS: ReadonlyMap<EngineState, ReadonlySet<EngineState>> = new Map([
  ['init', new Set<EngineState>(['loading-policy', 'refusing'])],
  ['loading-policy', new Set<EngineState>(['validating-chain', 'refusing'])],
  ['validating-chain', new Set<EngineState>(['ready', 'degraded', 'refusing'])],
  ['ready', new Set<EngineState>(['degraded', 'refusing'])],
  // `degraded → degraded` is a valid self-edge. Several callers
  // invoke `engine.degrade()` without guarding on the current
  // state (telemetry hooks, audit emit paths from the seal
  // scheduler, etc.); a throw on re-degrade would bubble as
  // uncaughtException. The self-edge accepts the re-entry, records
  // the reason in `history()` for forensics, and stays in
  // `degraded`. The trail grows by one entry per re-degrade —
  // operators see WHY the engine kept hitting the same failure.
  ['degraded', new Set<EngineState>(['ready', 'refusing', 'degraded'])],
  // `refusing` is terminal. The state controller refuses every
  // attempt to leave it; recovery requires building a fresh
  // controller (which the bootstrap does, gated on the
  // appropriate operator override).
  ['refusing', new Set<EngineState>()],
]);

export const canTransition = (from: EngineState, to: EngineState): boolean => {
  const allowed = VALID_TRANSITIONS.get(from);
  if (allowed === undefined) return false;
  return allowed.has(to);
};

export type TransitionListener = (event: StateTransition) => void;

export interface StateControllerOptions {
  initial?: EngineState;
  // Test seam to pin timestamps on transition events.
  now?: () => number;
  // Production callers wire this to forward transitions into the
  // event bus / audit log. Throws inside the listener are swallowed
  // — observability shouldn't break state.
  onTransition?: TransitionListener;
}

export interface StateController {
  get(): EngineState;
  transition(to: EngineState, reason: string): StateTransition;
  // Tests + bootstrap use this to inspect the trail without
  // wiring an onTransition listener.
  history(): readonly StateTransition[];
}

export const createStateController = (options: StateControllerOptions = {}): StateController => {
  let current: EngineState = options.initial ?? 'init';
  const trail: StateTransition[] = [];
  const now = options.now ?? Date.now;
  const listener = options.onTransition;

  return {
    get: () => current,
    transition(to, reason) {
      if (!canTransition(current, to)) {
        throw new Error(`state-machine: invalid transition ${current} → ${to} (reason: ${reason})`);
      }
      const event: StateTransition = { from: current, to, reason, ts: now() };
      current = to;
      trail.push(event);
      if (listener !== undefined) {
        try {
          listener(event);
        } catch {
          // Observability failures don't break the state. Bootstrap
          // and tests have direct access to the trail via `history()`
          // for forensic debugging if a listener swallows an event.
        }
      }
      return event;
    },
    history: () => trail,
  };
};

// Convenience: states where `check()` should bypass the rule pipeline
// and return deny outright. Three phases of cold start plus the fatal
// sink. Kept in one list so engine.ts and tests stay aligned.
export const STATES_THAT_REJECT_CHECKS: ReadonlySet<EngineState> = new Set([
  'init',
  'loading-policy',
  'validating-chain',
  'refusing',
]);

export const isRejectingState = (s: EngineState): boolean => STATES_THAT_REJECT_CHECKS.has(s);
