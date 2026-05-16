// Verify scheduler — session-scoped queue that consumes the
// memory_provenance trail (S1) to drive heuristic verification
// of factual memories (S2/T2.4). Each new exposure produces one
// verify task per (session, scope, name); duplicates are no-ops.
//
// Design choices:
//
// 1. PROVENANCE-DRIVEN, not per-site enqueue. The harness calls
//    `pollAndEnqueue(sessionId)` once per step boundary; the
//    scheduler scans memory_provenance for rows added since the
//    last poll and enqueues each unique (scope, name). This keeps
//    the integration to ONE site in loop.ts instead of 6
//    (registry.auditExposure, retrieval runner, memory_read,
//    memory_search, eager block, retrieve_context tool).
//
// 2. FIRE-AND-FORGET, not awaited. Verify tasks run in the
//    background; the harness doesn't block the model's turn on
//    verifier work. `drain()` at shutdown gives in-flight tasks
//    a chance to finish, with a small grace window — never an
//    unbounded wait (one slow verifier shouldn't stall shutdown).
//
// 3. DEDUPED IN MEMORY. The Set<key> of "already enqueued" lives
//    per-scheduler-instance. Same (session, scope, name) won't be
//    verified twice in one session even if the memory is read
//    many times. Cross-session re-verification fires on the next
//    boot's poll naturally — each session has its own scheduler.
//
// 4. NON-FATAL FAILURES. A verifier that throws, or a
//    transitionMemoryState refusal, or registry.peek returning
//    not-present — all stderr-log and continue. Verification is
//    observability; the model's turn already happened.

import { redactSecrets } from '../../sanitize/secrets.ts';
import type { DB } from '../../storage/db.ts';
import type { MemoryRegistry } from '../registry.ts';
import { transitionMemoryState } from '../transitions.ts';
import type { MemoryScope, MemoryType } from '../types.ts';
import { isMemoryFactual } from './factuality.ts';
import type { MemoryVerifier } from './types.ts';

export interface VerifyScheduler {
  // Idempotent enqueue: same (scope, name) won't schedule twice.
  // Called from the harness's step boundary; tests can also call
  // directly for inline scheduling.
  enqueue(scope: MemoryScope, name: string): void;

  // Poll memory_provenance for new (scope, name) pairs in this
  // session and enqueue each. Idempotent — repeated calls without
  // new exposures are no-ops. Designed to be called per step
  // boundary in the harness loop.
  pollAndEnqueue(): void;

  // Best-effort wait for in-flight verifies. Returns once every
  // currently-queued task has resolved (passed/unknown/
  // contradicted), or after `timeoutMs`, whichever is first.
  // Default timeout is 2000ms — verifiers should complete much
  // faster (file-exists check is microseconds), but a network-
  // bound future verifier shouldn't block shutdown indefinitely.
  drain(timeoutMs?: number): Promise<void>;
}

export interface VerifySchedulerDeps {
  db: DB;
  sessionId: string;
  registry: MemoryRegistry;
  repoRoot: string;
  // Verifier dispatch by memory type. v1 ships `project` only;
  // `reference` is stubbed at the dispatcher (returns silently).
  // Types absent from the map are skipped — never an error.
  verifiers: ReadonlyMap<MemoryType, MemoryVerifier>;
  // Optional stderr sink for tests. Defaults to
  // process.stderr.write.
  errSink?: (msg: string) => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

export const createVerifyScheduler = (deps: VerifySchedulerDeps): VerifyScheduler => {
  // Set<`${scope}/${name}`> — dedupe key. Mirrors the
  // memory-name uniqueness convention (scope-qualified).
  const enqueued = new Set<string>();
  // In-flight task promises. Each resolves regardless of verdict
  // (errors are caught inside `runOne`).
  const inflight: Set<Promise<void>> = new Set();
  const errSink = deps.errSink ?? ((msg: string) => process.stderr.write(msg));

  const runOne = async (scope: MemoryScope, name: string): Promise<void> => {
    try {
      // Peek — no audit row, no provenance emit. The verifier
      // reads the file body to extract claims; that's already
      // observability work, not a model-facing exposure.
      const peek = deps.registry.peek(name, { scope });
      if (peek.kind !== 'present') {
        // Body missing / malformed / unknown — nothing to verify
        // against. Stay silent; the operator sees the source
        // condition via `/memory list` flags.
        return;
      }
      const { frontmatter } = peek.file;
      if (!isMemoryFactual(frontmatter)) return; // preference memories — out of scope
      const verifier = deps.verifiers.get(frontmatter.type);
      if (verifier === undefined) return; // type not wired (reference v1)
      const result = await verifier.verify({
        scope,
        name,
        file: peek.file,
        repoRoot: deps.repoRoot,
      });
      if (result.kind === 'passed') return;
      if (result.kind === 'unknown') {
        // Forensic-only: visibility without state change. Operator
        // can grep stderr for `memory: verify_unknown` to see what
        // the heuristic couldn't decide. NOT an AUDIT DRIFT signal
        // (those are failures of the audit pipeline itself); this
        // is a successful verifier saying "no extractable claim".
        errSink(
          `memory: verify_unknown: ${scope}/${name} (verifier=${verifier.id}): ${redactSecrets(result.reason)}\n`,
        );
        return;
      }
      // `contradicted` — state transition. Heuristic verifier has
      // high-confidence ground truth contradiction; quarantine.
      //
      // Motivo: 'conflict'. EVICTION.md §4.1 LEGAL_TRANSITIONS
      // admits only `conflict` + `low_roi` for active→quarantined
      // — `shift` (the term MEMORY.md §6.5.2 uses for
      // verify_failed) is not in the allow-list. Semantic stretch:
      // verify_failed isn't a conflict BETWEEN MEMORIES, it's a
      // conflict with reality. Acceptable for v1; spec amendment
      // to admit a dedicated `shift` motivo is a follow-up issue.
      //
      // Actor: 'loop_cold'. The adaptation pipeline owns this kind
      // of background-correlation eviction (FEEDBACK_ADAPTATION
      // §3.2). The `trigger: 'verify_failed'` field carries the
      // precise detector identity for forensic queries via
      // `/memory audit --trigger verify_failed`.
      const transition = await transitionMemoryState({
        db: deps.db,
        registry: deps.registry,
        roots: deps.registry.roots,
        scope,
        name,
        toState: 'quarantined',
        actor: 'loop_cold',
        motivo: 'conflict',
        trigger: 'verify_failed',
        evidence: {
          // `failures: 1` satisfies the `conflict` motivo schema's
          // failure-burst branch (EVIDENCE_SCHEMAS in
          // eviction-events.ts). Semantic stretch: there's one
          // verifier failure (the claim contradicts reality), not
          // an unbounded burst — but the field is what the schema
          // requires, and 1 is honest. Auxiliary fields below
          // carry the actual forensic detail.
          failures: 1,
          claim: result.claim,
          expected: result.expected,
          observed: result.observed,
          verifier_id: verifier.id,
        },
        sessionId: deps.sessionId,
      });
      if (transition.kind === 'illegal_transition') {
        // Already not-active (somebody else quarantined first, or
        // operator restored to a different state mid-flight).
        // Silently skip — the verifier verdict still holds but the
        // state machine refused the transition for valid reasons.
        return;
      }
      if (transition.kind !== 'applied') {
        // unknown / io_error / invalid_evidence / blocked_by_hook
        // / refused_*: a guard upstream blocked the quarantine.
        // Log so the operator sees the contradiction was detected
        // but not acted on.
        errSink(`memory: verify_failed refused for ${scope}/${name}: ${transition.kind}\n`);
        return;
      }
      // `applied` — state machine accepted, eviction_events row
      // landed. Verbose stderr so operator gets a live signal even
      // before checking `/memory list`.
      errSink(
        `memory: verify_failed quarantined ${scope}/${name} (verifier=${verifier.id}): ${result.claim}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errSink(`memory: verify error for ${scope}/${name}: ${redactSecrets(msg)}\n`);
    }
  };

  const scheduler: VerifyScheduler = {
    enqueue(scope, name) {
      const key = `${scope}/${name}`;
      if (enqueued.has(key)) return;
      enqueued.add(key);
      const task = runOne(scope, name).finally(() => {
        inflight.delete(task);
      });
      inflight.add(task);
    },

    pollAndEnqueue() {
      // Scan provenance rows for this session, enqueue each
      // unique (scope, name). The internal dedupe Set makes
      // repeated calls cheap — already-enqueued keys short-
      // circuit before the runOne dispatch.
      //
      // We don't track a cursor; the helper queries the WHOLE
      // session every poll. listProvenanceForMemory is
      // session-scoped + indexed; for sessions with hundreds of
      // rows the scan is still microseconds. If/when that
      // breaks at scale, swap for an incremental query keyed
      // off `MAX(created_at)` from the last poll.
      //
      // Note: we DON'T use listProvenanceForMemory (which is
      // by-(scope,name)) here — we need every distinct
      // (scope, name) in the session. Use a direct query.
      const rows = deps.db
        .query<{ memory_scope: MemoryScope; memory_name: string }, [string]>(
          `SELECT DISTINCT memory_scope, memory_name
             FROM memory_provenance
            WHERE session_id = ?`,
        )
        .all(deps.sessionId);
      for (const row of rows) {
        scheduler.enqueue(row.memory_scope, row.memory_name);
      }
    },

    async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
      if (inflight.size === 0) return;
      const grace = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([Promise.allSettled(Array.from(inflight)).then(() => {}), grace]);
    },
  };

  return scheduler;
};
