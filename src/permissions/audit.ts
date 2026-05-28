// Audit sink — appends every engine decision to `approvals_log` with
// a sha256 hash chain. Two implementations:
//
//   - createNoopSink()   — for tests and the bypass path. Returns
//                          sentinel seq=0 / empty hash; verifyChain
//                          always ok. Lets engine code emit
//                          unconditionally without conditional
//                          plumbing.
//
//   - createSqliteSink() — production. Bound to an `install_id`
//                          identity at construction. Each emit
//                          reads the chain tip via
//                          `getLastApprovalsLogByInstall`, computes
//                          `this_hash = sha256(prev_hash ‖
//                          canonical_row)`, INSERTs the full row.
//                          `verifyChain` walks the chain in seq
//                          order, recomputes each `this_hash`, and
//                          stops at the first mismatch.
//
// Canonical row: every persisted column EXCEPT seq and this_hash,
// encoded via the canonical JSON encoder (RFC 8785 essentials, see
// `canonical.ts`). Two writers given the same logical row produce
// the same bytes; two readers given the same row produce the same
// hash on verify. Determinism is load-bearing — every decision
// must be replay-able.
//
// Genesis: the first row's `prev_hash` is
// `"GENESIS:" ‖ sha256(install_id ‖ created_at_ms)`. Bound to the
// installation: a DB copied from another machine fails verify
// because the genesis can't be reproduced without the matching
// identity file.

import { type DB, withImmediateTransaction } from '../storage/db.ts';
import {
  type ApprovalLogConfidence,
  type ApprovalLogDecision,
  type ApprovalLogRow,
  PERSISTED_COLUMNS,
  appendApprovalsLog,
  getLastApprovalsLogByInstall,
  listApprovalsLogByInstall,
} from '../storage/repos/approvals-log.ts';
import { getLatestChainMeta } from '../storage/repos/chain-rotation.ts';
import type { TelemetryEvent } from '../telemetry/index.ts';
import { canonicalize, sha256Hex } from './canonical.ts';
import type { InstallIdentity } from './install_id.ts';

// One entry in the decision's reason chain. Common stages:
// 'resolve' → 'static-rule' → 'risk-score' → 'classifier' →
// 'sandbox-plan' → 'approval-gate'. The field stays string so new
// stages don't require a schema bump.
export interface ReasonChainEntry {
  stage: string;
  // Optional context — origin layer in the hierarchy, the matched
  // rule literal, the section key, and any free-form note. All
  // optional so simple stages emit one-key entries.
  layer?: string;
  rule?: string;
  section?: string;
  note?: string;
}

export interface AuditEmitInput {
  // ---- Always required: the minimum carrier of decision identity.
  session_id: string;
  tool_name: string;
  // Tool args before they reach the tool. Engine hashes this with
  // `sha256(canonicalize(args))` to produce `args_hash` — raw args
  // never persist in the audit row (PII / secret hygiene).
  args: unknown;
  decision: 'allow' | 'deny' | 'confirm';
  // Resolved policy hash from the engine — same value for every
  // row emitted under a given policy. The engine computes this
  // once at construction (`canonicalize(policy)` → sha256).
  policy_hash: string;
  reason_chain: readonly ReasonChainEntry[];

  // ---- Load-bearing — `engine.emitAudit` ALWAYS populates these
  // in production (often with explicit `null` when not applicable
  // to the call, e.g. `classifier_adjust=null` when no classifier
  // consulted). The audit row's column for each has a non-default
  // semantic meaning ("0 score" ≠ "score not set"), so silently
  // defaulting would mask forensic bugs — these are required, not
  // optional.
  capabilities: readonly string[];
  score: number;
  score_components: Record<string, number>;
  // Classifier metadata. `classifier_hash` is `'none'` when no
  // classifier wired; `classifier_adjust` is null when the
  // classifier didn't run OR returned null/threw. Forensically
  // distinct from "consulted and returned 0".
  classifier_hash: string | null;
  classifier_adjust: number | null;
  // Sandbox planner result. Null when no planner ran (refused
  // before planner) OR no profile covered.
  sandbox_profile: string | null;
  // Grant TTL. Set when this decision was authorized by a pattern
  // grant — replays correlate against `grant-match` reason chain
  // stage. Null otherwise.
  ttl_expires_at: number | null;

  // ---- Optional fields. Leaving them optional keeps the present
  // call sites ergonomic while documenting the planned surface.
  //
  // `parent_approval_id`: subagent IPC link.
  // `confidence`: classifier promotion from `medium`/`low` —
  //               default `'high'` retains current behavior.
  // `tool_version` / `resolver_version`: engine version pin for
  //                forensic replay across versions.
  parent_approval_id?: string | null;
  confidence?: ApprovalLogConfidence;
  tool_version?: string;
  resolver_version?: string;
  // Test seam — pin the wall clock for deterministic chain hashes.
  ts?: number;
}

export interface EmittedRow {
  seq: number;
  this_hash: string;
}

export type VerifyResult =
  | {
      ok: true;
      rows: number;
      // Rotation metadata. Present for every result so the caller
      // can render quarantine status without a second query.
      // `current_rotation_id` is 0 for chains that never rotated.
      current_rotation_id: number;
      quarantined: boolean;
    }
  | {
      ok: false;
      brokenAt: number;
      // `ts_monotonic_break` flags a row whose `ts` is more than
      // AUDIT_TS_PAST_SKEW_MS earlier than the previous row's `ts`
      // — a forged-back-date shape. Hash chain may still be intact
      // (attacker rebuilds hashes), so this is a second independent
      // check during verify.
      reason: 'prev_hash_mismatch' | 'this_hash_mismatch' | 'ts_monotonic_break';
      expected: string;
      actual: string;
      current_rotation_id: number;
      quarantined: boolean;
    };

export interface AuditSink {
  emit(input: AuditEmitInput): EmittedRow;
  verifyChain(): VerifyResult;
}

const NOOP_ROW: EmittedRow = { seq: 0, this_hash: '' };

// Audit ts future-skew window. 1h forgiving — see validateTs
// rationale inline for the past-vs-future asymmetry.
export const AUDIT_TS_FUTURE_SKEW_MS = 60 * 60 * 1000;

// Past-side skew window: a forged row whose `ts` lands BEFORE the
// previous row's wall clock is also a forgery shape (drops a row
// "into the past" of the audit timeline, breaking forensic
// ordering). Without this guard, an attacker with DB write can
// insert a row with `ts = previous_row.ts - 86400000` and
// `verifyChain` accepts it because the hash chain stays intact. The
// seal doesn't catch this either — sealing is per-decision-count
// keyed on the hash chain, not on ts monotonic.
//
// Asymmetric with the future-side skew (1h): legitimate operator
// workflows produce backward clock jumps that DWARF NTP smear —
// closing a laptop overnight (8-12h) and resuming is the dominant
// shape; a 1h window false-positives on every overnight wake-up,
// transitioning the engine to `refusing` on the first emit after
// resume for benign timekeeping. 24h covers wake-from-suspend +
// post-DST NTP correction + virtual machine clock catch-up after a
// host migration. Forgery shapes that matter (back-dating by days
// or years to hide a row inside the "recent history" window of a
// forensic query) still get caught.
//
// The future side stays tight (1h) because forward-dated forgery is
// strictly more dangerous: a future ts makes a row look "newest" to
// any tooling sorting by time, and there's no operator workflow
// that legitimately produces a forward jump > 1h (NTP only smears
// over short windows; an admin who reset the clock manually has
// other audit signals to surface the disruption).
export const AUDIT_TS_PAST_SKEW_MS = 24 * 60 * 60 * 1000;

export const createNoopSink = (): AuditSink => ({
  emit: () => NOOP_ROW,
  verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
});

// Recursive strip of undefined values before canonicalize. JSON has
// no `undefined`; canonicalize.ts throws on any undefined
// encountered. Without this strip, programmatic callers spreading
// `{ ...rest, optional: maybeUndef }` would throw out of
// `audit.emit` before the BEGIN IMMEDIATE transaction. The strip
// pass is shape-preserving — keys with undefined values are
// silently dropped (matches JSON.stringify semantics), nested
// objects are recursed. Arrays preserve undefined elements as
// `null` (JSON.stringify behavior). Non-object inputs pass through.
//
// Path-based cycle guard: a node is in `seen` only while its
// recursion is active. We `add` on entry and `delete` on exit, so
// a true cycle (A → B → A) hits a hot path entry and returns null,
// while DAG-sharing (root references `shared` twice without
// looping) walks `shared` cleanly the second time. This matches
// JSON.stringify, which silently serializes DAGs and only throws
// on real cycles.
//
// Asymmetry vs `canonical.ts:canonicalize`: canonicalize THROWS
// on encountering undefined or a non-finite number; this strip
// SWALLOWS undefined and silently substitutes cycles with null.
// The choice is deliberate — audit.emit is a critical path
// (every engine.check writes a row), so we prefer "stable hash
// over weird input" to "mid-transaction throw". Side effect: two
// distinct cyclic-args inputs hash to the same args_hash because
// both collapse to a null stand-in at the cycle point. Model
// emissions don't produce cyclic JSON in practice (the LLM emits
// JSON-serializable args), so this is a defensive convergence,
// not a forensic risk class operators should track. If a future
// tool surfaces cycles, the right fix is to wire the tool to
// detect + reject upstream rather than thread bigger semantics
// through audit emit.
const stripUndefined = (value: unknown, seen: WeakSet<object> = new WeakSet()): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return null; // true cycle → null stand-in (see asymmetry note above)
  seen.add(value as object);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => (v === undefined ? null : stripUndefined(v, seen)));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      obj[k] = stripUndefined(v, seen);
    }
    out = obj;
  }
  seen.delete(value as object);
  return out;
};

// Build the canonical-hash payload from a row's persisted columns.
// Pulls fields in the order declared by `PERSISTED_COLUMNS` except
// `this_hash`, because `this_hash` is the OUTPUT of the hash — it
// can't be input to itself. The `canonicalize` JSON encoder sorts
// keys lexicographically anyway, so the column order in the column
// list is purely aesthetic; what matters is that both `emit` and
// `verifyChain` build the SAME object shape from the SAME source.
const HASH_INPUT_COLUMNS = PERSISTED_COLUMNS.filter((c) => c !== 'this_hash');

// Exported so tamper-test fixtures can construct rows with valid-
// but-back-dated hashes (the threat `ts_monotonic_break` defends
// against). The function is pure + deterministic; exposing it for
// tests carries no security cost — an attacker who can already
// write the DB can compute hashes by hand or import this same
// module.
export const buildHashPayload = (
  row: Omit<ApprovalLogRow, 'seq' | 'this_hash'>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const col of HASH_INPUT_COLUMNS) {
    payload[col] = (row as unknown as Record<string, unknown>)[col];
  }
  return payload;
};

// `prev_hash = "GENESIS:" || sha256(install_id || created_at_ms)`
// for the first row of each installation. The genesis hash is
// stable for a given identity. A chain rotation keeps the same
// install_id so the genesis MUST shift to remain distinct from the
// pre-rotation chain; `computeRotatedGenesisHash` below carries
// that shift.
export const computeGenesisHash = (identity: InstallIdentity): string =>
  `GENESIS:${sha256Hex(`${identity.install_id}${identity.created_at_ms}`)}`;

// Post-rotation genesis hash. Same install_id, but the genesis incor-
// porates the rotation event identifiers so the new chain is byte-
// distinct from the archived one. The `GENESIS-ROTATED:` prefix makes
// the distinction visible in raw row inspection — a forensic reader
// scanning `prev_hash` columns can spot the boundary without joining
// against `chain_meta`.
export const computeRotatedGenesisHash = (
  identity: InstallIdentity,
  rotation_id: number,
  rotated_at_ms: number,
): string => `GENESIS-ROTATED:${sha256Hex(`${identity.install_id}${rotated_at_ms}${rotation_id}`)}`;

// `--accept-broken-chain` lookup. Returns (seq, ts) for every audit
// row emitted by the bootstrap when the operator opted to continue
// under a known-broken chain. The `bootstrapPermissionEngine` flow
// writes one such row PER acceptance (so multiple resumes under
// different breaks all stack visibly in the chain).
//
// Filter strategy: `tool_name = 'permission-engine'` narrows the
// scan to engine-emitted rows (the only path that produces these),
// then a LIKE on `reason_chain_json` matches the
// `chain-break-accepted` stage marker. The LIKE is acceptable here
// because (a) the prefix filter on tool_name keeps the scanned set
// tiny in production (typically zero or single-digit rows), and
// (b) the chain stage marker is a stable string literal the engine
// writes verbatim — no JSON-shape sensitivity.
export interface ChainBreakAcceptedRow {
  seq: number;
  ts: number;
}

export const listChainBreakAcceptedRows = (db: DB, installId: string): ChainBreakAcceptedRow[] => {
  return db
    .query(
      `SELECT seq, ts
         FROM approvals_log
        WHERE install_id = ?
          AND tool_name = 'permission-engine'
          AND reason_chain_json LIKE '%chain-break-accepted%'
        ORDER BY seq ASC`,
    )
    .all(installId) as ChainBreakAcceptedRow[];
};

export interface CreateSqliteSinkOptions {
  identity: InstallIdentity;
  db: DB;
  // Sealing integration. When set, every successful `emit`
  // notifies the scheduler via `tick()` so the scheduler can count
  // decisions toward `interval_decisions` and seal at the
  // appropriate threshold. Optional — sinks created without a
  // scheduler simply skip the notification. Production wiring
  // lives in the bootstrap: construct the scheduler from `[seal]`
  // Policy config, pass it here.
  scheduler?: { tick(): void };
  // Telemetry integration. When set, every successful `emit`
  // produces a typed `permission.decision` telemetry event
  // mirroring the audit row's content. Structurally-typed so the
  // sink doesn't import from src/telemetry (peer modules — same
  // posture as the scheduler tick option). Production wires the
  // OTEL adapter; tests inject a recording sink. Failures in the
  // telemetry sink NEVER break audit emit — wrapped in try/catch
  // identical to the scheduler.tick handling.
  telemetry?: { emit: (event: TelemetryEvent) => void };
  // Engine state bridge. Optional getter that populates the
  // `permission.decision` event's `engine_state` field. The audit
  // sink doesn't own a state controller — the bootstrap (which
  // constructs both the sink and the controller) plumbs
  // `controller.get` through here. Production wiring:
  // `engineState: () => controller.get()`. Without this getter,
  // the event's `engine_state` field is omitted.
  //
  // Wrapped in try/catch at emit time — a thrown getter does not
  // break the audit path nor the telemetry emission; the event
  // simply ships without the field.
  engineState?: () => string;
}

export const createSqliteSink = ({
  identity,
  db,
  scheduler,
  telemetry,
  engineState,
}: CreateSqliteSinkOptions): AuditSink => {
  // Resolve the active genesis once at construction. Rotations are
  // operator-driven via the CLI `--rotate-chain` flow that exits
  // before any engine starts, so the sink never sees a mid-flight
  // rotation; the latest `chain_meta` row at construction is the
  // definitive answer for this sink's lifetime.
  const latestMeta = getLatestChainMeta(db, identity.install_id);
  const current_rotation_id = latestMeta?.rotation_id ?? 0;
  const isQuarantined = latestMeta?.quarantined === 1;
  const genesisHash =
    latestMeta === null
      ? computeGenesisHash(identity)
      : computeRotatedGenesisHash(identity, latestMeta.rotation_id, latestMeta.rotated_at_ms);

  // Caller-supplied `ts` must be a sane wall-clock integer. The
  // test seam on `AuditEmitInput` accepts any number, so without
  // this validation a forged row with `ts=2099-01-01` would be
  // indistinguishable from a real one (verifyChain doesn't check
  // monotonic ordering across the chain). Clamp to a sane window:
  //   - integer
  //   - finite
  //   - non-negative
  //   - not in the far future (more than 1h ahead of wall clock)
  // The skew window is forgiving on the past side (operator clocks
  // run backwards routinely under NTP correction) but tight on
  // the future side because forgery-forward is the dangerous
  // direction — a future ts makes the row look "newest" to any
  // tooling sorting by time. 1h tolerance covers NTP smear and
  // light skew without admitting "datestamp in 2099" forgeries.
  const validateTs = (input: AuditEmitInput, now: number): number => {
    const ts = input.ts ?? now;
    if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
      throw new Error(`audit: ts must be a non-negative finite integer (got ${String(ts)})`);
    }
    if (ts > now + AUDIT_TS_FUTURE_SKEW_MS) {
      throw new Error(
        `audit: ts is more than ${AUDIT_TS_FUTURE_SKEW_MS}ms ahead of wall clock (got ${ts}, now ${now}) — suspected forgery`,
      );
    }
    return ts;
  };

  const emit = (input: AuditEmitInput): EmittedRow => {
    const ts = validateTs(input, Date.now());
    // Strip undefined values from args before canonicalize. JSON
    // has no `undefined`; canonicalize.ts throws on any undefined
    // encountered. Without this strip, a caller spreading
    // `{ ...rest, optional: maybeUndef }` (legal TS, illegal JSON)
    // throws out of `audit.emit` AFTER validateTs but BEFORE
    // `withImmediateTransaction` — engine.check() has no
    // try/catch, so the throw propagates to the harness as
    // `internalError`. Today model-emitted JSON can't carry
    // undefined, so production path is safe; this shields
    // programmatic callers and future emit sites.
    const args_hash = sha256Hex(canonicalize(stripUndefined(input.args ?? {})));

    // Wrap read-prev-hash + insert-this-row in a single IMMEDIATE
    // transaction. Without this, the SELECT and INSERT in
    // autocommit mode let parent + parallel task_async child
    // processes sharing the same install_id both read `prev_hash=X`
    // and both insert with that prev_hash, breaking chain
    // continuity (`verifyChain` then fails).
    //
    // BEGIN IMMEDIATE acquires the writer lock at transaction
    // start so the SELECT's snapshot stays stable through to
    // COMMIT. Concurrent BEGIN IMMEDIATEs serialize via
    // busy_timeout=5000 (set in openDb): the second caller waits
    // up to 5s for the first to commit, then proceeds with a
    // fresh snapshot.
    //
    // scheduler.tick() + telemetry.emit() stay OUTSIDE the
    // transaction — they're observability paths that mustn't
    // hold the writer lock or block other audit emitters.
    const { inserted, this_hash, persistedExceptHash } = withImmediateTransaction(db, () => {
      const last = getLastApprovalsLogByInstall(db, identity.install_id);
      const prev_hash = last === null ? genesisHash : last.this_hash;

      // Past-side ts monotonicity guard. The future-side check in
      // `validateTs` (above, before the transaction) catches
      // forward-dated forgeries; this catches backward-dated ones.
      // AUDIT_TS_PAST_SKEW_MS gives an hour of tolerance for NTP
      // smear / suspend-resume jumps so we don't false-positive on
      // legitimate clock corrections. Beyond that window, the
      // row's ts is treated as a forgery attempt — refuse the
      // insert. The chain has now been read inside the IMMEDIATE
      // writer lock, so the comparison is race-free.
      if (last !== null && ts < last.ts - AUDIT_TS_PAST_SKEW_MS) {
        throw new Error(
          `audit: ts ${ts} is more than ${AUDIT_TS_PAST_SKEW_MS}ms before previous row's ts ${last.ts} (forgery suspected)`,
        );
      }

      // The 7 load-bearing fields below (capabilities, score,
      // score_components, classifier_hash, classifier_adjust,
      // sandbox_profile, ttl_expires_at) are required on
      // `AuditEmitInput`. The 4 still-optional fields
      // (parent_approval_id, confidence, tool_version,
      // resolver_version) keep their persistence defaults here.
      const persisted: Omit<ApprovalLogRow, 'seq' | 'this_hash'> = {
        ts,
        install_id: identity.install_id,
        session_id: input.session_id,
        parent_approval_id: input.parent_approval_id ?? null,
        tool_name: input.tool_name,
        tool_version: input.tool_version ?? 'v1',
        resolver_version: input.resolver_version ?? 'v1',
        args_hash,
        capabilities_json: JSON.stringify(input.capabilities),
        decision: input.decision as ApprovalLogDecision,
        score: input.score,
        score_components_json: JSON.stringify(input.score_components),
        confidence: input.confidence ?? 'high',
        classifier_hash: input.classifier_hash,
        classifier_adjust: input.classifier_adjust,
        policy_hash: input.policy_hash,
        sandbox_profile: input.sandbox_profile,
        ttl_expires_at: input.ttl_expires_at,
        reason_chain_json: JSON.stringify(input.reason_chain),
        prev_hash,
      };

      const hash = sha256Hex(prev_hash + canonicalize(buildHashPayload(persisted)));
      const row = appendApprovalsLog(db, { ...persisted, this_hash: hash });
      return { inserted: row, this_hash: hash, persistedExceptHash: persisted };
    });
    // Sealing tick. ORDER MATTERS: the row is already persisted,
    // so the scheduler's `sealLatestInternal` sees the up-to-date
    // chain head when it queries `getLastApprovalsLogByInstall`.
    // Wrapped in try/catch because the audit path is critical and
    // sealing is best-effort — scheduler internals OR a user-
    // supplied `onSealFailed` callback throwing must NOT break
    // audit emission.
    if (scheduler !== undefined) {
      try {
        scheduler.tick();
      } catch {
        // Best-effort. Surfacing the error here would mean a
        // half-emitted row from the caller's perspective — the row
        // is in the DB, but emit() threw. Silently swallow.
      }
    }
    // Telemetry emission. Same posture as the scheduler tick:
    // AFTER persist so the event's approval_id (= row.seq) is
    // stable, wrapped in try/catch because observability MUST NOT
    // break audit emit. The event carries the row's content minus
    // secrets-bearing fields (args + raw chain hashes); resolved
    // capabilities + decision + score + policy_hash +
    // classifier_hash are operator-facing diagnostics, safe to
    // export.
    if (telemetry !== undefined) {
      try {
        // Resolve the engine state via the optional getter;
        // failures inside the getter surface as an omitted field,
        // not a corrupted event.
        let resolvedEngineState: string | undefined;
        if (engineState !== undefined) {
          try {
            resolvedEngineState = engineState();
          } catch {
            // Getter threw — ship the event without the field.
          }
        }
        telemetry.emit({
          kind: 'permission.decision',
          ts,
          approval_id: inserted.seq,
          parent_approval_id: persistedExceptHash.parent_approval_id,
          tool: persistedExceptHash.tool_name,
          tool_version: persistedExceptHash.tool_version,
          resolver_version: persistedExceptHash.resolver_version,
          capabilities: input.capabilities ?? [],
          decision: persistedExceptHash.decision,
          score: persistedExceptHash.score,
          score_components: input.score_components ?? {},
          confidence: persistedExceptHash.confidence,
          policy_hash: persistedExceptHash.policy_hash,
          classifier_hash: persistedExceptHash.classifier_hash,
          classifier_adjust: persistedExceptHash.classifier_adjust,
          sandbox_profile: persistedExceptHash.sandbox_profile,
          ttl_expires_at: persistedExceptHash.ttl_expires_at,
          ...(resolvedEngineState !== undefined ? { engine_state: resolvedEngineState } : {}),
        });
      } catch {
        // Same rationale as the scheduler tick — observability
        // failures cannot corrupt the audit emit signal.
      }
    }
    return { seq: inserted.seq, this_hash };
  };

  const verifyChain = (): VerifyResult => {
    // Re-read the rotation tip on every verify so an out-of-process
    // CLI rotation between `createSqliteSink` and a later
    // `verifyChain` call is still reflected. emit() does not re-read
    // (no concurrent rotation under the same sink by construction),
    // but verify is also exposed via `agent permission verify` which
    // operates on a freshly-constructed sink.
    const tipMeta = getLatestChainMeta(db, identity.install_id);
    const tipRotationId = tipMeta?.rotation_id ?? 0;
    const tipQuarantined = tipMeta?.quarantined === 1;
    // Recompute genesis from the LIVE rotation tip, not the
    // construction-time snapshot. Without this recompute, an
    // out-of-process `--rotate-chain` between sink construction
    // and verify (long-lived REPL + operator running rotate in
    // another terminal) produces a spurious `prev_hash_mismatch`
    // on a perfectly intact post-rotation chain: the live
    // approvals_log rows belong to the NEW chain whose first
    // row's prev_hash is the rotated genesis, but `expectedPrev`
    // would start at the STALE construction-time hash.
    const liveGenesisHash =
      tipMeta === null
        ? computeGenesisHash(identity)
        : computeRotatedGenesisHash(identity, tipMeta.rotation_id, tipMeta.rotated_at_ms);
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    let expectedPrev = liveGenesisHash;
    // ts monotonic floor for the current walk position. `lastTs`
    // tracks the previous row's ts; the next row must not be more
    // than AUDIT_TS_PAST_SKEW_MS earlier. Same semantics as the
    // emit-time guard, reapplied post-hoc to catch DB-tamper that
    // bypassed emit.
    let lastTs: number | null = null;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: 'prev_hash_mismatch',
          expected: expectedPrev,
          actual: row.prev_hash,
          current_rotation_id: tipRotationId,
          quarantined: tipQuarantined,
        };
      }
      const recomputed = sha256Hex(row.prev_hash + canonicalize(buildHashPayload(row)));
      if (recomputed !== row.this_hash) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: 'this_hash_mismatch',
          expected: recomputed,
          actual: row.this_hash,
          current_rotation_id: tipRotationId,
          quarantined: tipQuarantined,
        };
      }
      // ts monotonic break detection. Hash chain can stay intact
      // while ts is forged backward (attacker with DB write
      // recomputes hashes). The verify path is the second-line
      // check.
      if (lastTs !== null && row.ts < lastTs - AUDIT_TS_PAST_SKEW_MS) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: 'ts_monotonic_break',
          expected: `>= ${lastTs - AUDIT_TS_PAST_SKEW_MS}`,
          actual: String(row.ts),
          current_rotation_id: tipRotationId,
          quarantined: tipQuarantined,
        };
      }
      lastTs = row.ts;
      expectedPrev = row.this_hash;
    }
    return {
      ok: true,
      rows: rows.length,
      current_rotation_id: tipRotationId,
      quarantined: tipQuarantined,
    };
  };

  // Surface construction-time rotation snapshot for tests that need
  // to inspect the sink state without populating any rows first.
  // Returned as a side-channel through verifyChain (already includes
  // current_rotation_id + quarantined) — unused vars below silence
  // TS noUnused; both are read inside verifyChain's closures.
  void current_rotation_id;
  void isQuarantined;
  return { emit, verifyChain };
};
