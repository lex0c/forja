// In-memory working-state store, scoped per session. Spec
// `docs/spec/WORKING_STATE.md` is explicit that this is a bounded HOT-state
// operational panel — "painel, não diário" (§0). It does NOT persist between
// sessions: it lives entirely in process memory, keyed by sessionId, and the
// harness clears it at session end. There is intentionally no SQLite repo (the
// audit log — messages/tool_calls — stays the single source of truth; §0.6).
//
// The store mirrors the TodoStore shape (session-bound dependency, optional on
// ToolContext, owned by the harness; tools receive it through ctx). It stays a
// DUMB container: get/set/nextId/clear. All the discipline the spec attributes
// to "the store" (§0.4: FIFO, staleness eviction, confirmed/refuted → log,
// per-item caps) lives in the pure `applyWorkingStatePatch` below, which the
// single `working_state_update` tool orchestrates as get → apply → set. Keeping
// the bookkeeping in a pure function (not the model, not spread across the tool)
// is how we honor "the store does the bookkeeping, not the model" while keeping
// the container trivial enough for the loop's emitting-set wrapper to intercept.

import { flattenControlToLine } from '../sanitize/index.ts';

// Caps from WORKING_STATE.md §3. One eviction axis per slot; nothing grows with
// the session (cost is O(1), not O(steps)). These are tunable-by-eval starting
// points (§9), not sacred constants — kept in one object so the tool, the
// renderer, and the tests can't drift apart.
export const WS_CAPS = {
  focusMaxChars: 120,
  nextMax: 5,
  nextItemMaxChars: 120,
  logMax: 15,
  logItemMaxChars: 200,
  logRenderWindow: 10, // §5.5: render only log entries within the last W steps
  hypothesesMaxOpen: 7,
  hypothesisTextMaxChars: 200,
  evidenceMax: 5,
  evidenceItemMaxChars: 160,
  globalRenderMaxBytes: 4096, // §3: final guard on the injected block
} as const;

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted';
// Who originated the belief (§2.1). `model` is the common case (the agent formed
// it); `user` is operator-asserted (refuting it should go through clarify);
// `tool` is derived from an output. Default `model`.
export type HypothesisSource = 'user' | 'model' | 'tool';

export interface Hypothesis {
  // Stable per-session id ("H1", "H2", …), assigned by the store and never
  // recycled — a stale model reference resolves to not_found instead of
  // aliasing a different belief.
  id: string;
  text: string;
  // Entries living in WorkingState.hypotheses are ALWAYS 'open'. The moment a
  // hypothesis is confirmed/refuted it leaves this list and becomes a one-line
  // log entry (§4.2). The field is retained for the wire/update surface.
  status: HypothesisStatus;
  source: HypothesisSource;
  // Pointers, not copies (§2). FIFO-capped at evidenceMax.
  evidence: string[];
  // staleness = currentStep − updatedAtStep (§6). Refreshed on any update.
  updatedAtStep: number;
}

export interface WorkingLogEntry {
  text: string;
  atStep: number; // render of recency + deterministic FIFO order
}

export interface WorkingState {
  // 1 line: what I'm doing now. Undefined when never set / cleared.
  focus?: { text: string; atStep: number };
  next: string[]; // immediate next steps; a growing list is a plan → TodoStore
  log: WorkingLogEntry[]; // append-FIFO buffer of recent milestones
  hypotheses: Hypothesis[]; // only the OPEN ones; ≤ hypothesesMaxOpen
}

export const emptyWorkingState = (): WorkingState => ({ next: [], log: [], hypotheses: [] });

// ---- Patch surface (the model-facing partial update; §4) -------------------

export interface HypothesisAdd {
  text: string;
  source?: HypothesisSource; // default 'model'
}
export interface HypothesisUpdate {
  id: string;
  status?: HypothesisStatus;
  evidenceAppend?: string[];
}
export interface WorkingStatePatch {
  focus?: string; // set; "" clears
  next?: string[]; // set (replaces the whole list)
  logAppend?: string[];
  hypothesisAdd?: HypothesisAdd;
  hypothesisUpdate?: HypothesisUpdate;
}

// Per-call mutation breakdown (§4.4). Echoed in the tool result (→ tool_calls
// audit, so usage metrics are projectable) and carried on the TUI event for a
// live counter. NOT persisted as its own store.
export interface MutationDelta {
  focusChanged: number;
  nextSet: number;
  logAppended: number;
  hypothesisCreated: number;
  hypothesisConfirmed: number;
  hypothesisRefuted: number;
  hypothesisEvicted: number;
}

export const emptyMutationDelta = (): MutationDelta => ({
  focusChanged: 0,
  nextSet: 0,
  logAppended: 0,
  hypothesisCreated: 0,
  hypothesisConfirmed: 0,
  hypothesisRefuted: 0,
  hypothesisEvicted: 0,
});

export interface ApplyResult {
  next: WorkingState;
  mutations: MutationDelta;
  notices: string[]; // human-facing hints echoed to the model (overflow, eviction)
  createdHypothesisId?: string; // populated when hypothesisAdd ran — the model needs the id
}

// Single-line, control-free, byte-capped field. flattenControlToLine strips
// ANSI + collapses every C0 control (incl. newlines) to a space and trims, so a
// stray newline can't break the [working_state] block; then we hard-cap length.
// Stripping (not rejecting) keeps "update barato" (§0.3) — a model that pastes a
// multi-line snippet gets it flattened, not an error.
const clip = (text: string, max: number): string => {
  const flat = flattenControlToLine(text);
  // Count by code points (not UTF-16 units) so the cap matches the spec's
  // "chars" and a slice never splits a surrogate pair (emoji / CJK supplementary)
  // into a lone half landing in the injected prompt.
  const cps = [...flat];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : flat;
};

// Most-stale open hypothesis: smallest updatedAtStep wins (the belief untouched
// longest). Tie-break keeps the earlier-created (reduce keeps the accumulator on
// equality). Used for eviction when the open count would exceed the cap (§3).
const mostStale = (hyps: Hypothesis[]): Hypothesis =>
  hyps.reduce((a, b) => (b.updatedAtStep < a.updatedAtStep ? b : a));

// Pure state transition. Takes the current state + a partial patch, returns a
// fresh state plus the mutation delta and notices. Never mutates `current`.
// `nextId` mints hypothesis ids ("H1"…) — injected so the store stays the sole
// id authority. `atStep` stamps focus/log/hypothesis recency.
//
// Validation of the patch SHAPE and hypothesisUpdate id-existence happens at the
// tool boundary (mirrors the todo tools); here we assume a well-formed patch and
// focus purely on the bookkeeping.
export const applyWorkingStatePatch = (
  current: WorkingState,
  patch: WorkingStatePatch,
  atStep: number,
  nextId: () => string,
): ApplyResult => {
  const mutations = emptyMutationDelta();
  const notices: string[] = [];

  let focus = current.focus ? { ...current.focus } : undefined;
  let next = [...current.next];
  const log: WorkingLogEntry[] = current.log.map((e) => ({ ...e }));
  let hypotheses: Hypothesis[] = current.hypotheses.map((h) => ({
    ...h,
    evidence: [...h.evidence],
  }));
  let createdHypothesisId: string | undefined;

  const pushLog = (text: string): void => {
    const t = clip(text, WS_CAPS.logItemMaxChars);
    if (t.length > 0) log.push({ text: t, atStep });
  };

  // focus — set (1 line); "" clears.
  if (patch.focus !== undefined) {
    const t = clip(patch.focus, WS_CAPS.focusMaxChars);
    focus = t.length === 0 ? undefined : { text: t, atStep };
    mutations.focusChanged += 1;
  }

  // next — set (replace whole list). Overflow past the cap is a plan signal.
  if (patch.next !== undefined) {
    const cleaned = patch.next
      .map((s) => clip(s, WS_CAPS.nextItemMaxChars))
      .filter((s) => s.length > 0);
    next = cleaned.slice(0, WS_CAPS.nextMax);
    if (cleaned.length > WS_CAPS.nextMax) {
      notices.push(
        `next holds ${WS_CAPS.nextMax} items; dropped ${cleaned.length - WS_CAPS.nextMax} — that's a plan, use todo_create`,
      );
    }
    mutations.nextSet += 1;
  }

  // log — append (FIFO trim happens once at the end).
  if (patch.logAppend !== undefined) {
    for (const entry of patch.logAppend) {
      const t = clip(entry, WS_CAPS.logItemMaxChars);
      if (t.length === 0) continue;
      log.push({ text: t, atStep });
      mutations.logAppended += 1;
    }
  }

  // hypothesisUpdate runs BEFORE hypothesisAdd. A single call that updates an
  // existing belief AND adds a new one must apply the update first: otherwise
  // the add's staleness eviction could silently drop the very hypothesis the
  // update targets, turning the update into a no-op and vanishing the
  // confirm/refute + evidence with no error — a silent failure-as-data
  // violation (§4.1). Updating first also refreshes the target's updatedAtStep,
  // so it can no longer be the eviction victim. Unknown id is a no-op here (the
  // tool rejects it upstream with not_found).
  if (patch.hypothesisUpdate !== undefined) {
    const hu = patch.hypothesisUpdate;
    const idx = hypotheses.findIndex((h) => h.id === hu.id);
    const h = idx >= 0 ? hypotheses[idx] : undefined;
    if (h !== undefined) {
      if (hu.evidenceAppend !== undefined) {
        for (const e of hu.evidenceAppend) {
          const t = clip(e, WS_CAPS.evidenceItemMaxChars);
          if (t.length === 0) continue;
          if (h.evidence.length >= WS_CAPS.evidenceMax) h.evidence.shift(); // FIFO
          h.evidence.push(t);
        }
      }
      h.updatedAtStep = atStep;
      if (hu.status === 'confirmed' || hu.status === 'refuted') {
        hypotheses.splice(idx, 1);
        pushLog(`${h.id} ${hu.status}: ${h.text}`);
        if (hu.status === 'confirmed') mutations.hypothesisConfirmed += 1;
        else mutations.hypothesisRefuted += 1;
      } else {
        h.status = 'open';
      }
    }
  }

  // hypothesisAdd — create an open belief; evict the most stale if over cap.
  if (patch.hypothesisAdd !== undefined) {
    const text = clip(patch.hypothesisAdd.text, WS_CAPS.hypothesisTextMaxChars);
    if (text.length > 0) {
      const id = nextId();
      hypotheses.push({
        id,
        text,
        status: 'open',
        source: patch.hypothesisAdd.source ?? 'model',
        evidence: [],
        updatedAtStep: atStep,
      });
      createdHypothesisId = id;
      mutations.hypothesisCreated += 1;
      // The just-added one has updatedAtStep = atStep (newest), so it is never
      // the victim — eviction always falls on a pre-existing stale belief.
      if (hypotheses.length > WS_CAPS.hypothesesMaxOpen) {
        const victim = mostStale(hypotheses);
        hypotheses = hypotheses.filter((h) => h.id !== victim.id);
        pushLog(`${victim.id} archived (stale): ${victim.text}`);
        mutations.hypothesisEvicted += 1;
        notices.push(
          `evicted ${victim.id} (most stale) to keep <=${WS_CAPS.hypothesesMaxOpen} open hypotheses`,
        );
      }
    }
  }

  // FIFO: keep only the newest logMax entries.
  const trimmedLog = log.length > WS_CAPS.logMax ? log.slice(log.length - WS_CAPS.logMax) : log;

  // exactOptionalPropertyTypes: optional keys are omitted, not set to undefined.
  const nextState: WorkingState = {
    ...(focus !== undefined ? { focus } : {}),
    next,
    log: trimmedLog,
    hypotheses,
  };
  return {
    next: nextState,
    mutations,
    notices,
    ...(createdHypothesisId !== undefined ? { createdHypothesisId } : {}),
  };
};

// ---- Render (the injected [working_state] block; §5) -----------------------

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

const renderBlock = (
  state: WorkingState,
  currentStep: number,
  opts: { log: boolean; evidence: boolean },
): string => {
  const lines: string[] = ['[working_state]'];
  if (state.focus) {
    const age = Math.max(0, currentStep - state.focus.atStep);
    lines.push(`focus: ${state.focus.text} (s.${state.focus.atStep}, ${age} steps atrás)`);
  }
  if (state.next.length > 0) {
    lines.push('next:');
    for (const n of state.next) lines.push(`  - ${n}`);
  }
  if (state.hypotheses.length > 0) {
    lines.push('hypotheses (open):');
    for (const h of state.hypotheses) {
      const age = Math.max(0, currentStep - h.updatedAtStep);
      lines.push(`  - ${h.id} (${h.source}, ${age} steps): ${h.text}`);
      if (opts.evidence && h.evidence.length > 0) {
        lines.push(`      evidence: ${h.evidence.join('; ')}`);
      }
    }
  }
  if (opts.log) {
    const windowed = state.log.filter((e) => e.atStep >= currentStep - WS_CAPS.logRenderWindow);
    if (windowed.length > 0) {
      lines.push(`recent log (últimos ~${WS_CAPS.logRenderWindow} steps; mais novo embaixo):`);
      for (const e of windowed) lines.push(`  - [s.${e.atStep}] ${e.text}`);
    }
  }
  return lines.join('\n');
};

// Render the [working_state] block for injection, or undefined when the panel is
// empty (so a session that never touched it leaves no trace; §5/§7.1). Enforces
// the global byte guard (§3) by shedding the noisiest content first: log →
// evidence → hard truncate. In practice the per-slot caps keep the block well
// under the limit; this is the safety net, not the common path.
export const formatWorkingState = (
  state: WorkingState,
  currentStep: number,
): string | undefined => {
  const empty =
    state.focus === undefined &&
    state.next.length === 0 &&
    state.log.length === 0 &&
    state.hypotheses.length === 0;
  if (empty) return undefined;

  const cap = WS_CAPS.globalRenderMaxBytes;

  const full = renderBlock(state, currentStep, { log: true, evidence: true });
  if (byteLen(full) <= cap) return full;

  // Build each fallback WITH its elision notice and check THAT against the cap:
  // a block that fits bare can still overflow once the ~30–40-byte notice is
  // appended, which would defeat the guard the step before injection.
  const noLog = `${renderBlock(state, currentStep, { log: false, evidence: true })}\n  (log elided: over size cap)`;
  if (byteLen(noLog) <= cap) return noLog;

  const bare = renderBlock(state, currentStep, { log: false, evidence: false });
  const bareNotice = `${bare}\n  (log + evidence elided: over size cap)`;
  if (byteLen(bareNotice) <= cap) return bareNotice;

  // Last resort: the bare block itself exceeds the cap. Trim by BYTES (the cap's
  // unit) so multibyte content is actually bounded, walking whole code points so
  // we never emit a split surrogate. Reserve 3 bytes for the '…' suffix.
  let out = '';
  for (const cp of bare) {
    if (byteLen(out + cp) > cap - 3) break;
    out += cp;
  }
  return `${out}…`;
};

// ---- Store (dumb container, mirrors TodoStore) -----------------------------

export interface WorkingStateStore {
  // Current state for a session; empty (not undefined) for an unknown session —
  // absence is semantically an empty panel, and a bare read leaves no Map entry.
  get(sessionId: string): WorkingState;
  // Replace the state for a session. Atomic; deep-cloned in so a caller mutating
  // its copy after set() can't corrupt stored state.
  set(sessionId: string, state: WorkingState): void;
  // Monotonic per-session hypothesis id ("H1", "H2", …). Never recycles within a
  // session, so a stale reference resolves to not_found, not a different belief.
  nextId(sessionId: string): string;
  // Session-monotonic step counter for staleness stamps (§6). `tickStep`
  // advances it (call once per loop step) and returns the new value;
  // `currentStep` peeks without advancing. It lives WITH the store, so in the
  // REPL — where the store is injected and reused across turns — the step keeps
  // climbing instead of resetting to 0 on each runAgent call. A per-run reset
  // would let the just-added hypothesis look older than a prior turn's entries
  // (wrong eviction) and clamp rendered ages back to 0. A one-shot run or
  // subagent gets a fresh store, so the counter starts at 0 and stays monotonic
  // for that single run.
  tickStep(sessionId: string): number;
  currentStep(sessionId: string): number;
  // Session-end teardown. Idempotent; drops state + counters so a long-lived
  // process running many sessions doesn't accumulate dead panels.
  clear(sessionId: string): void;
}

export const createWorkingStateStore = (): WorkingStateStore => {
  const states = new Map<string, WorkingState>();
  // Per-session id counter, independent of the state so it survives the
  // read-modify-write churn of the tool — a moved/evicted hypothesis must not
  // free its id for reuse. Monotonic; reset only by clear().
  const counters = new Map<string, number>();
  // Session-monotonic step counter (see interface). Separate from the per-run
  // step index the harness loop tracks for budget/events — this one persists
  // with the store across REPL turns so staleness never goes backward.
  const stepCounters = new Map<string, number>();
  return {
    get: (sessionId) => {
      const s = states.get(sessionId);
      // Deep defensive copy: set() is the only path that changes stored state.
      return s === undefined ? emptyWorkingState() : structuredClone(s);
    },
    set: (sessionId, state) => {
      states.set(sessionId, structuredClone(state));
    },
    nextId: (sessionId) => {
      const n = (counters.get(sessionId) ?? 0) + 1;
      counters.set(sessionId, n);
      return `H${n}`;
    },
    tickStep: (sessionId) => {
      const n = (stepCounters.get(sessionId) ?? 0) + 1;
      stepCounters.set(sessionId, n);
      return n;
    },
    currentStep: (sessionId) => stepCounters.get(sessionId) ?? 0,
    clear: (sessionId) => {
      states.delete(sessionId);
      counters.delete(sessionId);
      stepCounters.delete(sessionId);
    },
  };
};
