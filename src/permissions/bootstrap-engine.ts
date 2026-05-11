// Production bootstrap for the permission engine. Walks the §2 state
// machine explicitly (init → loading-policy → validating-chain →
// ready) so every phase is auditable and every failure can be
// pinpointed by the operator.
//
// Why not fold this into `createPermissionEngine`: tests build
// engines from a hand-crafted Policy and a synthetic cwd; they
// don't care about install_id discovery, DB migrations, or chain
// verification. Splitting the production wiring out lets those
// tests stay synchronous and dep-free while production bootstrap
// gets the explicit state walk + audit sink it needs.
//
// Failure modes:
//   - install_id read/write fails              → state=refusing
//   - policy load throws (validation, YAML)    → state=refusing
//   - verifyChain returns broken + no override → state=refusing
//   - verifyChain returns broken + accept flag → state=ready;
//                                                emit `chain-break-accepted`
//                                                audit row (audit-loud)
//   - all of the above clean                   → state=ready

import type { DB } from '../storage/db.ts';
import {
  type AuditSink,
  type ReasonChainEntry,
  type VerifyResult,
  createSqliteSink,
} from './audit.ts';
import { initBashParser } from './bash-parser.ts';
import { canonicalHash } from './canonical.ts';
import { type PermissionEngine, createPermissionEngine } from './engine.ts';
import {
  type Layer,
  type LayerPolicy,
  type LockConflict,
  type SectionProvenance,
  resolvePolicy,
} from './hierarchy.ts';
import { type InstallIdentity, ensureInstallId } from './install_id.ts';
import { type EngineState, type StateTransition, createStateController } from './state-machine.ts';
import type { Policy } from './types.ts';

export interface BootstrapPermissionEngineInput {
  cwd: string;
  // Operator home for §11 protected-paths context + install_id
  // discovery. Defaults to `env.HOME` (or platform equivalent) via
  // `installIdPath`. Tests pin both fields.
  home?: string;
  env?: NodeJS.ProcessEnv;
  db: DB;
  sessionId: string;
  // Continue under a known-broken chain. Audit-loud: a
  // `chain-break-accepted` row lands BEFORE the engine starts
  // accepting new decisions, so retrospective audits see the
  // operator's authorization on the chain itself.
  acceptBrokenChain?: boolean;
  // Test seams for policy discovery.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Inject the policy session layer (CLI flag overrides) — flows
  // straight into resolvePolicy.
  sessionPolicy?: Policy;
  // Test seams for deterministic timestamps + UUID generation.
  now?: () => number;
  uuid?: () => string;
  // Skip the install_id + policy load phases by supplying their
  // already-validated outputs from `preflightPermissionEngine`.
  // Production CLI bootstrap runs preflight BEFORE opening the
  // SQLite DB so a bad policy fails the boot without creating the
  // DB file — same invariant the v1 leak test pinned. Without
  // preflight, bootstrap performs the two phases inline; either
  // path produces the same final state.
  preflight?: PreflightResult;
}

export interface PreflightResult {
  identity: InstallIdentity;
  resolved: ReturnType<typeof resolvePolicy>;
}

export interface PreflightInput {
  cwd: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  enterprisePath?: string | null;
  userPath?: string | null;
  sessionPolicy?: Policy;
  now?: () => number;
  uuid?: () => string;
}

// Validate install_id + policy WITHOUT opening any SQLite handle.
// Throws on the two boot-blocking failures (install_id discovery,
// malformed policy) so the CLI driver can fail the boot before any
// DB file is created. Production bootstrap calls this, then opens
// the DB, then calls `bootstrapPermissionEngine` with the cached
// result — the chain-verify phase still produces a `refusing`
// state when applicable, but install_id and policy failures stay
// hard exceptions per the v1 leak-test invariant.
export const preflightPermissionEngine = (input: PreflightInput): PreflightResult => {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? process.env.HOME ?? input.cwd;
  const identity = ensureInstallId({
    env,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
  });
  const resolved = resolvePolicy({
    cwd: input.cwd,
    home,
    env,
    ...(input.enterprisePath !== undefined ? { enterprisePath: input.enterprisePath } : {}),
    ...(input.userPath !== undefined ? { userPath: input.userPath } : {}),
    ...(input.sessionPolicy !== undefined ? { session: input.sessionPolicy } : {}),
  });
  return { identity, resolved };
};

export interface BootstrapPermissionEngineResult {
  engine: PermissionEngine;
  identity: InstallIdentity;
  sink: AuditSink;
  state: EngineState;
  events: readonly StateTransition[];
  // Forwarded from resolvePolicy so the CLI driver can render layer
  // diagnostics (`--explain-permissions`, /perms why).
  policy: Policy;
  layers: readonly LayerPolicy[];
  layerNames: readonly Layer[];
  lockConflicts: readonly LockConflict[];
  provenance: SectionProvenance;
  // Outcome of the chain integrity check; useful for `forja doctor`
  // and the CLI to render an explicit "chain ok / broken at seq N"
  // line on every boot.
  chain: VerifyResult;
  // Set when refusing — operator-facing description of what failed.
  // Empty when state is ready.
  refusingReason?: string;
}

const emitChainBreakAcceptedRow = (
  sink: AuditSink,
  sessionId: string,
  policyHash: string,
  verify: Extract<VerifyResult, { ok: false }>,
): void => {
  const reasonChain: ReasonChainEntry[] = [
    {
      stage: 'chain-break-accepted',
      note: `broken_at=${verify.brokenAt} reason=${verify.reason} expected=${verify.expected} actual=${verify.actual}`,
    },
  ];
  sink.emit({
    session_id: sessionId,
    tool_name: 'permission-engine',
    args: { acceptBrokenChain: true },
    decision: 'allow',
    policy_hash: policyHash,
    reason_chain: reasonChain,
  });
};

export const bootstrapPermissionEngine = async (
  input: BootstrapPermissionEngineInput,
): Promise<BootstrapPermissionEngineResult> => {
  // Bash AST resolver requires the tree-sitter-bash grammar to be
  // loaded. Init is idempotent and cached across invocations — first
  // call is ~30ms (wasm + grammar load), subsequent calls return
  // immediately. Runs during the validating-chain phase so the
  // engine's first check() finds a warm parser.
  await initBashParser();

  const events: StateTransition[] = [];
  const controller = createStateController({
    initial: 'init',
    ...(input.now !== undefined ? { now: input.now } : {}),
    onTransition: (e) => events.push(e),
  });

  const home = input.home ?? input.env?.HOME ?? process.env.HOME ?? input.cwd;

  // Phases 1 + 2: install_id + policy load. Pre-flight (callable
  // separately by the CLI driver) lets a malformed policy throw
  // BEFORE any SQLite handle is opened, preserving the v1
  // leak-test invariant. When the caller supplied a `preflight`
  // result, we trust it and skip the work. Either way we still
  // record the explicit transitions so the events trail mirrors
  // the spec §2 walk.
  controller.transition('loading-policy', 'bootstrap_start');
  let identity: InstallIdentity;
  let resolveResult: ReturnType<typeof resolvePolicy>;
  if (input.preflight !== undefined) {
    identity = input.preflight.identity;
    resolveResult = input.preflight.resolved;
  } else {
    try {
      identity = ensureInstallId({
        env: input.env ?? process.env,
        ...(input.now !== undefined ? { now: input.now } : {}),
        ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
      });
    } catch (e) {
      const reason = `install_id_failed: ${(e as Error).message}`;
      controller.transition('refusing', reason);
      return buildRefusingResult({ controller, events, reason, db: input.db });
    }
    try {
      resolveResult = resolvePolicy({
        cwd: input.cwd,
        home,
        env: input.env ?? process.env,
        ...(input.enterprisePath !== undefined ? { enterprisePath: input.enterprisePath } : {}),
        ...(input.userPath !== undefined ? { userPath: input.userPath } : {}),
        ...(input.sessionPolicy !== undefined ? { session: input.sessionPolicy } : {}),
      });
    } catch (e) {
      const reason = `policy_load_failed: ${(e as Error).message}`;
      controller.transition('refusing', reason);
      return buildRefusingResult({ controller, events, reason, db: input.db, identity });
    }
  }

  // Phase 3: validate the audit chain. The sink we build here is the
  // same one the engine will emit through, so a single SQLite handle
  // backs the entire lifetime.
  controller.transition('validating-chain', 'policy_loaded');
  const sink = createSqliteSink({ db: input.db, identity });
  const chain = sink.verifyChain();

  if (!chain.ok && input.acceptBrokenChain !== true) {
    const reason = `chain_broken: seq=${chain.brokenAt} reason=${chain.reason}`;
    controller.transition('refusing', reason);
    return buildRefusingResult({
      controller,
      events,
      reason,
      db: input.db,
      identity,
      sink,
      chain,
      resolved: resolveResult,
    });
  }

  // Phase 4: ready (or ready + audit-loud chain-break acknowledgement).
  // The engine is constructed with the controller already in
  // validating-chain — the final transition lands AFTER the
  // chain-break audit row so the row's prev_hash anchors on the
  // last broken-but-accepted hash, not on a phantom mid-bootstrap
  // state.
  if (!chain.ok && input.acceptBrokenChain === true) {
    // Compute a policy_hash matching what the engine will use, so
    // the audit row's policy_hash field is stable. The engine
    // computes the same value internally via `canonicalHash(policy)`.
    const policyHash = `sha256:${canonicalHash(resolveResult.policy)}`;
    emitChainBreakAcceptedRow(sink, input.sessionId, policyHash, chain);
  }

  const engine = createPermissionEngine(resolveResult.policy, {
    cwd: input.cwd,
    home,
    provenance: resolveResult.provenance,
    audit: sink,
    sessionId: input.sessionId,
    stateController: controller,
  });

  controller.transition('ready', chain.ok ? 'chain_intact' : 'chain_break_accepted');

  return {
    engine,
    identity,
    sink,
    state: 'ready',
    events,
    policy: resolveResult.policy,
    layers: resolveResult.layers,
    layerNames: resolveResult.layers.map((l) => l.layer),
    lockConflicts: resolveResult.lockConflicts,
    provenance: resolveResult.provenance,
    chain,
  };
};

// Build a placeholder result for any refusing transition. The engine
// here is a stub that denies every check — caller MUST inspect
// `state` before using it. We still return a valid object so the CLI
// driver can render diagnostics + the policy layer trail (if loaded).
const buildRefusingResult = (params: {
  controller: ReturnType<typeof createStateController>;
  events: readonly StateTransition[];
  reason: string;
  db: DB;
  identity?: InstallIdentity;
  sink?: AuditSink;
  chain?: VerifyResult;
  resolved?: ReturnType<typeof resolvePolicy>;
}): BootstrapPermissionEngineResult => {
  // Synthesize a placeholder identity when install_id failed —
  // downstream consumers should never reach decision code in
  // refusing state, but they may still want to render a "no
  // identity" message.
  const identity: InstallIdentity = params.identity ?? {
    install_id: 'unknown',
    created_at_ms: 0,
  };
  const sink = params.sink ?? createSqliteSink({ db: params.db, identity });
  const policy: Policy = params.resolved?.policy ?? {
    defaults: { mode: 'strict' },
    tools: {},
  };
  // Build a refusing engine. We hand it a fresh controller pinned
  // to refusing so every check returns deny, but mirror the audit
  // wiring of the live path so the caller's audit pipeline keeps
  // working.
  const refusingController = createStateController({ initial: 'refusing' });
  const engine = createPermissionEngine(policy, {
    cwd: '.',
    audit: sink,
    sessionId: 'refusing',
    stateController: refusingController,
  });
  return {
    engine,
    identity,
    sink,
    state: 'refusing',
    events: params.events,
    policy,
    layers: params.resolved?.layers ?? [],
    layerNames: (params.resolved?.layers ?? []).map((l) => l.layer),
    lockConflicts: params.resolved?.lockConflicts ?? [],
    provenance: params.resolved?.provenance ?? { defaults: 'default' },
    chain: params.chain ?? { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    refusingReason: params.reason,
  };
};
