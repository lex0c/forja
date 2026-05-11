// Conformance suite loader + runner. Per PERMISSION_ENGINE.md §16:
// the suite is the load-bearing definition of "the engine behaves
// deterministically". This slice ships the infrastructure and a
// seed of cases covering protected paths + hash chain. The spec's
// GA bar is ≥136 cases — future slices grow the suite per category:
//
//   - static_rules/      (20)  — deny precedence, hierarchy, locked
//   - capability_resolvers/ (30) — per-tool resolver behavior
//   - bash_adversarial/  (25)  — eval, $(), redirects, traversal
//   - path_traversal/    (15)  — symlink escape, mount checks
//   - hash_chain/        (8)   — genesis, append, verify, broken
//   - ttl_expiry/        (6)
//   - subagent/          (6)
//   - protected_paths/   (5)
//   - concurrency/       (5)
//   - score_determinism/ (10)
//   - sandbox_select/    (6)
//
// Case shape mirrors the spec §16.1 example: name + setup +
// input + expect. The loader walks the cases dir, parses each
// YAML, builds an engine with the right cwd/home/policy, and
// checks the Decision against `expect`. Mismatches produce
// readable diffs.

import { parse as parseYaml } from 'yaml';
import { type AuditEmitInput, createSqliteSink } from '../../src/permissions/audit.ts';
import {
  formatCapability,
  intersectCapabilities,
  parseCapability,
} from '../../src/permissions/capabilities.ts';
import type { Classifier } from '../../src/permissions/classifier.ts';
import type { LayerPolicy } from '../../src/permissions/hierarchy.ts';
import {
  type Decision,
  type EngineState,
  type PolicyCategory,
  createPermissionEngine,
} from '../../src/permissions/index.ts';
import { loadPolicyFromString, mergeLayers } from '../../src/permissions/index.ts';
import type { InstallIdentity } from '../../src/permissions/install_id.ts';
import { resolveCapabilities } from '../../src/permissions/resolvers/index.ts';
import { selectSandboxProfile } from '../../src/permissions/sandbox-plan.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';

// Pre-baked classifier fixtures keyed by name. YAML cases can pin
// a behavior without needing to express a function inline. Add new
// names here when a case needs a shape not already covered.
export type ClassifierFixtureName = 'noop' | 'neutral' | 'safe' | 'risky' | 'broken' | 'thrower';

// §7.2 hash chain seed event — minimum required fields to populate
// an `approvals_log` row via the sink's `emit`. The runner fills in
// defaults for session_id / args / policy_hash / reason_chain so
// YAML cases stay focused on what they're pinning.
export interface AuditEventSeed {
  tool: string;
  decision: 'allow' | 'deny' | 'confirm';
  ts?: number;
}

// §7.2 tamper operations against the seeded chain. Two shapes:
//   - `update_field` — raw SQL update of one column on one row.
//     Used to forge prev_hash / this_hash, or to mutate input
//     fields (decision / tool_name) so the stored this_hash no
//     longer matches the recomputed payload.
//   - `insert_forged` — raw SQL insert of an entirely fake row
//     between existing seqs. Tests that verify catches synthesized
//     rows that bypass the sink.
export type AuditTamperOp =
  | {
      kind: 'update_field';
      row: number;
      field: 'prev_hash' | 'this_hash' | 'decision' | 'tool_name';
      value: string;
    }
  | {
      kind: 'insert_forged';
      ts: number;
      prev_hash: string;
      this_hash: string;
    };

// §8 grant seed for ttl_expiry conformance cases (slice 42). Mirrors
// the engine's `GrantSnapshot` shape plus an optional `revoked_at`
// the runner uses to filter the seed list — a row with `revoked_at`
// set never appears in the snapshot the engine sees.
export interface GrantSeed {
  id: string;
  scope_kind: 'pattern' | 'capability';
  scope_value: string;
  capability: string;
  expires_at: number;
  revoked_at?: number;
}

export interface ConformanceCase {
  name: string;
  setup: {
    project_policy?: string;
    // §5 hierarchy precedence cases (slice 64). Optional raw YAML
    // strings for the enterprise/user/session layers. When ANY of
    // these is set, the runner merges all provided layers via
    // `mergeLayers` (bypassing disk discovery) — the merged Policy
    // feeds the engine. `project_policy` continues to work as the
    // project layer; absent layers are simply omitted from the
    // merge. Single-layer cases that don't care about hierarchy
    // pin `project_policy` only (existing shape).
    enterprise_policy?: string;
    user_policy?: string;
    session_policy?: string;
    cwd?: string;
    home?: string;
    // Pin the engine into a non-default state before the input
    // runs. Used by §2 state-machine cases (init/loading-policy/
    // validating-chain/refusing reject every check; degraded
    // upgrades allow → confirm).
    initialState?: EngineState;
    // Wire a pre-baked classifier fixture for §6.4 cases. See
    // `classifierFixtures` in the runner. Default: no classifier
    // wired (classifier_hash='none', classifier_adjust=null).
    classifier_fixture?: ClassifierFixtureName;
    // Version pin recorded in audit when a classifier is wired.
    // Default 'fixture' to surface fixture-driven runs vs the
    // 'none' default of unwired cases.
    classifier_hash?: string;
    // Strict mode toggle — unavailable classifier degrades the
    // engine. Default false (lenient).
    classifier_required?: boolean;
    // §10.1 subagent intersection cases (slice 31). When
    // `declared_capabilities` is present, the case runs the
    // intersection primitive directly INSTEAD of the engine pipeline
    // — `parent_capabilities` and `declared_capabilities` are parsed
    // via `parseCapability`, fed to `intersectCapabilities`, and the
    // result is checked against `expect.effective` / `expect.excess`.
    // The engine path is skipped (no policy, no decision, no audit
    // row). `input` is allowed to be omitted on intersection cases.
    parent_capabilities?: readonly string[];
    declared_capabilities?: readonly string[];
    // §6.5 sandbox profile selection cases (slice 32). When
    // `sandbox_capabilities` is present, the case runs
    // `selectSandboxProfile` directly. `host_explicitly_allowed`
    // gates the `host` profile per spec (CLI `--sandbox-host` flag).
    // Same engine-bypass pattern as intersection cases.
    sandbox_capabilities?: readonly string[];
    host_explicitly_allowed?: boolean;
    // §7.2 hash chain cases (slice 33). When `audit_events` is
    // present, the case seeds an in-memory bun:sqlite-backed audit
    // sink with the listed emits, optionally applies `audit_tamper`
    // to corrupt a row, then calls `verifyChain`. Engine pipeline
    // skipped (no policy, no decision).
    audit_events?: readonly AuditEventSeed[];
    audit_tamper?: AuditTamperOp;
    // §8 grants cases (slice 42). Seeds an engine with a fixed
    // grants snapshot — the runner filters by `setup.now` (defaults
    // to a fixed wall-clock if absent) so the engine sees only
    // un-expired, un-revoked grants. Engine path runs normally; the
    // grants provider mocks `listActive`. `now` doubles as the
    // engine's effective `Date.now()` for snapshot filtering.
    grants?: readonly GrantSeed[];
    now?: number;
  };
  // Optional for §10.1 subagent intersection cases (no engine call).
  // Required for every other case shape.
  input?: {
    tool: string;
    category: PolicyCategory;
    args: Record<string, unknown>;
  };
  expect: {
    // §10.1 intersection cases set `effective` and/or `excess` instead
    // of `kind`. The driver dispatches on the presence of
    // `setup.declared_capabilities`.
    effective?: readonly string[];
    excess?: readonly string[];
    // §6.5 sandbox cases: `sandbox_profile` pins the chosen profile;
    // `sandbox_refuse` pins the refuse envelope's reason; `sandbox_uncovered`
    // pins the kinds that no candidate covered.
    sandbox_profile?: 'ro' | 'cwd-rw' | 'cwd-rw-net' | 'home-rw' | 'host';
    sandbox_refuse?: 'no_viable_sandbox';
    sandbox_uncovered?: readonly string[];
    // §7.2 hash chain cases: `verify_ok` pins whether the chain
    // verifies; `verify_rows` pins the row count on the ok path;
    // `verify_broken_at` + `verify_reason` pin the seq and failure
    // mode on the broken path.
    verify_ok?: boolean;
    verify_rows?: number;
    verify_broken_at?: number;
    verify_reason?: 'prev_hash_mismatch' | 'this_hash_mismatch';
    kind?: 'allow' | 'deny' | 'confirm';
    source_section?: string;
    source_layer?: string;
    reason_substring?: string;
    // Subset assertion against the resolver's output. Each entry
    // must appear in the resolver's capability list (formatted via
    // `formatCapability`). The list may carry additional entries —
    // the assertion is "these are present", not "these are the
    // only ones".
    capabilities_include?: readonly string[];
    // Exact resolver outcome kind: 'ok' | 'conservative' | 'refuse'.
    resolver_kind?: 'ok' | 'conservative' | 'refuse';
    // Score bounds and component presence checks. Each is optional;
    // when set, the driver compares the audit row's `score` and
    // `score_components` against the assertion. score_gte/lte are
    // inclusive bounds; score_components_include is a subset match
    // — each named component must be present in the audit row.
    score_gte?: number;
    score_lte?: number;
    score_components_include?: readonly string[];
    // Classifier assertions. classifier_hash matches the audit
    // row's recorded hash; classifier_adjust is the post-clamp
    // value (number or null). engine_state_after lets §6.4 strict-
    // mode cases verify the engine degraded after the call.
    classifier_hash?: string;
    classifier_adjust?: number | null;
    engine_state_after?: EngineState;
  };
}

export const loadCasesFromYaml = (content: string): ConformanceCase[] => {
  const parsed = parseYaml(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('conformance: top-level YAML must be a list of cases');
  }
  return parsed.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new Error(`conformance: case[${i}] must be a mapping`);
    }
    const obj = c as Record<string, unknown>;
    if (typeof obj.name !== 'string') throw new Error(`conformance: case[${i}] missing name`);
    if (typeof obj.setup !== 'object' || obj.setup === null) {
      throw new Error(`conformance: case '${obj.name}' missing setup`);
    }
    // Engine-bypass cases (slices 31/32/33) don't need an `input`
    // block — their setup carries the primitive's inputs directly.
    const setupObj = obj.setup as Record<string, unknown>;
    const isEngineBypass =
      Array.isArray(setupObj.declared_capabilities) ||
      Array.isArray(setupObj.sandbox_capabilities) ||
      Array.isArray(setupObj.audit_events);
    if (!isEngineBypass && (typeof obj.input !== 'object' || obj.input === null)) {
      throw new Error(`conformance: case '${obj.name}' missing input`);
    }
    if (typeof obj.expect !== 'object' || obj.expect === null) {
      throw new Error(`conformance: case '${obj.name}' missing expect`);
    }
    return c as ConformanceCase;
  });
};

export interface CaseRunResult {
  case: ConformanceCase;
  // Null for §10.1 subagent intersection cases (no engine call). Set
  // for every engine-path case.
  decision: Decision | null;
  ok: boolean;
  reasons: string[];
}

// Order-preserving array equality on formatted capability strings.
// `intersectCapabilities` preserves declared order in both `effective`
// and `excess`, so order is part of the contract — tests assert it.
const arraysEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// §10.1 subagent intersection runner. Pure: no engine, no policy, no
// audit. Parses both capability lists with `parseCapability` (the same
// path the harness uses at spawn time), invokes `intersectCapabilities`,
// and asserts the resulting `effective` + `excess` arrays match the
// YAML expectations — order-preserving on both arrays.
// §8 grants snapshot builder. Filters the seed array by the case's
// `now` timestamp + revocation state so the engine's `listActive`
// receives exactly the rows that should be live. The engine's call
// passes its own snapshot ts (production: `Date.now()`); the
// returned closure ignores that argument and returns the pre-filtered
// list — conformance pins the snapshot at case-build time, not at
// check-time, so the result is deterministic across runs.
const buildGrantsProvider = (seeds: readonly GrantSeed[], now: number | undefined) => {
  const ts = now ?? Date.now();
  const filtered = seeds.filter((g) => g.revoked_at === undefined && g.expires_at > ts);
  const snapshot = filtered.map((g) => ({
    id: g.id,
    scope_kind: g.scope_kind,
    scope_value: g.scope_value,
    capability: g.capability,
    expires_at: g.expires_at,
  }));
  return { listActive: () => snapshot };
};

const runIntersectionCase = (c: ConformanceCase): CaseRunResult => {
  const reasons: string[] = [];
  let parent: ReturnType<typeof parseCapability>[];
  let declared: ReturnType<typeof parseCapability>[];
  try {
    parent = (c.setup.parent_capabilities ?? []).map(parseCapability);
    declared = (c.setup.declared_capabilities ?? []).map(parseCapability);
  } catch (e) {
    reasons.push(`capability parse error: ${(e as Error).message}`);
    return { case: c, decision: null, ok: false, reasons };
  }
  const { effective, excess } = intersectCapabilities(parent, declared);
  const effectiveFmt = effective.map(formatCapability);
  const excessFmt = excess.map(formatCapability);
  if (c.expect.effective !== undefined) {
    if (!arraysEqual(effectiveFmt, c.expect.effective)) {
      reasons.push(
        `effective mismatch: expected ${JSON.stringify(c.expect.effective)}, got ${JSON.stringify(effectiveFmt)}`,
      );
    }
  }
  if (c.expect.excess !== undefined) {
    if (!arraysEqual(excessFmt, c.expect.excess)) {
      reasons.push(
        `excess mismatch: expected ${JSON.stringify(c.expect.excess)}, got ${JSON.stringify(excessFmt)}`,
      );
    }
  }
  return { case: c, decision: null, ok: reasons.length === 0, reasons };
};

// §6.5 sandbox profile selection runner. Pure: no engine, no policy.
// Parses capabilities via `parseCapability`, invokes
// `selectSandboxProfile`, then asserts the result against
// `expect.sandbox_profile`, `expect.sandbox_refuse`, and
// `expect.sandbox_uncovered`. Walks every assertion the case
// carries; tolerates either ok-shape or refuse-shape on the planner
// return.
const runSandboxSelectCase = (c: ConformanceCase): CaseRunResult => {
  const reasons: string[] = [];
  let capabilities: ReturnType<typeof parseCapability>[];
  try {
    capabilities = (c.setup.sandbox_capabilities ?? []).map(parseCapability);
  } catch (e) {
    reasons.push(`capability parse error: ${(e as Error).message}`);
    return { case: c, decision: null, ok: false, reasons };
  }
  const result = selectSandboxProfile({
    capabilities,
    hostExplicitlyAllowed: c.setup.host_explicitly_allowed ?? false,
  });
  if (c.expect.sandbox_profile !== undefined) {
    if (result.kind !== 'ok') {
      reasons.push(
        `sandbox_profile mismatch: expected ${c.expect.sandbox_profile}, got refuse(${result.reason})`,
      );
    } else if (result.profile !== c.expect.sandbox_profile) {
      reasons.push(
        `sandbox_profile mismatch: expected ${c.expect.sandbox_profile}, got ${result.profile}`,
      );
    }
  }
  if (c.expect.sandbox_refuse !== undefined) {
    if (result.kind !== 'refuse') {
      reasons.push(
        `sandbox_refuse mismatch: expected ${c.expect.sandbox_refuse}, got ok(${result.profile})`,
      );
    } else if (result.reason !== c.expect.sandbox_refuse) {
      reasons.push(
        `sandbox_refuse mismatch: expected ${c.expect.sandbox_refuse}, got ${result.reason}`,
      );
    }
  }
  if (c.expect.sandbox_uncovered !== undefined) {
    if (result.kind !== 'refuse') {
      reasons.push(`sandbox_uncovered set but planner returned ok(${result.profile})`);
    } else if (!arraysEqual(result.uncovered, c.expect.sandbox_uncovered)) {
      reasons.push(
        `sandbox_uncovered mismatch: expected ${JSON.stringify(c.expect.sandbox_uncovered)}, got ${JSON.stringify(result.uncovered)}`,
      );
    }
  }
  return { case: c, decision: null, ok: reasons.length === 0, reasons };
};

// §7.2 hash chain runner. Spins up an in-memory bun:sqlite DB,
// migrates the schema, builds a real `createSqliteSink` against a
// fixed identity, replays `audit_events`, optionally applies one
// `audit_tamper` op via raw SQL, then calls `verifyChain` and
// matches the result against the case's `verify_*` expectations.
//
// Uses a stable identity (deterministic install_id + ts) so the
// computed genesis hash is reproducible across runs.
const HASH_CHAIN_IDENTITY: InstallIdentity = {
  install_id: '00000000-0000-0000-0000-0000000000aa',
  created_at_ms: 1731000000000,
};

const runHashChainCase = (c: ConformanceCase): CaseRunResult => {
  const reasons: string[] = [];
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const sink = createSqliteSink({ db, identity: HASH_CHAIN_IDENTITY });

  // Seed the chain. Defaults mirror `audit.test.ts` baseInput so
  // YAML cases stay focused on what they're pinning (tool, decision,
  // optional ts). The runner fills session_id / args / policy_hash /
  // reason_chain with deterministic placeholders — the values matter
  // only because the chain hashes them, not because the test reads
  // them back.
  const events = c.setup.audit_events ?? [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as AuditEventSeed;
    const input: AuditEmitInput = {
      session_id: 'sess-1',
      tool_name: e.tool,
      args: { command: `seed-${i}` },
      decision: e.decision,
      policy_hash: 'sha256:policy-fixture',
      reason_chain: [{ stage: 'static-rule', layer: 'project', section: 'bash' }],
      ts: e.ts ?? 1731000001000 + i,
    };
    sink.emit(input);
  }

  // Apply tamper if present. `update_field` overwrites a single
  // column on an existing row; `insert_forged` synthesizes a row
  // with the given hashes but no genuine chain link. Both are raw
  // SQL because the sink's `emit` rebuilds the hash each call —
  // there's no in-API way to corrupt a row.
  if (c.setup.audit_tamper !== undefined) {
    const t = c.setup.audit_tamper;
    if (t.kind === 'update_field') {
      db.run(`UPDATE approvals_log SET ${t.field} = ? WHERE seq = ?`, [t.value, t.row]);
    } else if (t.kind === 'insert_forged') {
      db.run(
        `INSERT INTO approvals_log (
          ts, install_id, session_id, tool_name, args_hash, decision,
          policy_hash, reason_chain_json, prev_hash, this_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.ts,
          HASH_CHAIN_IDENTITY.install_id,
          'sess-1',
          'forged',
          'forged_args_hash',
          'allow',
          'sha256:policy-fixture',
          '[]',
          t.prev_hash,
          t.this_hash,
        ],
      );
    }
  }

  const result = sink.verifyChain();
  if (c.expect.verify_ok !== undefined) {
    if (result.ok !== c.expect.verify_ok) {
      reasons.push(`verify_ok mismatch: expected ${c.expect.verify_ok}, got ${result.ok}`);
    }
  }
  if (c.expect.verify_rows !== undefined) {
    if (!result.ok) {
      reasons.push(`verify_rows expected ${c.expect.verify_rows}, got broken chain`);
    } else if (result.rows !== c.expect.verify_rows) {
      reasons.push(`verify_rows mismatch: expected ${c.expect.verify_rows}, got ${result.rows}`);
    }
  }
  if (c.expect.verify_broken_at !== undefined) {
    if (result.ok) {
      reasons.push(`verify_broken_at expected ${c.expect.verify_broken_at}, got ok chain`);
    } else if (result.brokenAt !== c.expect.verify_broken_at) {
      reasons.push(
        `verify_broken_at mismatch: expected ${c.expect.verify_broken_at}, got ${result.brokenAt}`,
      );
    }
  }
  if (c.expect.verify_reason !== undefined) {
    if (result.ok) {
      reasons.push(`verify_reason expected ${c.expect.verify_reason}, got ok chain`);
    } else if (result.reason !== c.expect.verify_reason) {
      reasons.push(
        `verify_reason mismatch: expected ${c.expect.verify_reason}, got ${result.reason}`,
      );
    }
  }
  return { case: c, decision: null, ok: reasons.length === 0, reasons };
};

// Pre-baked classifier fixtures keyed by name. Each is a sync
// function with the documented shape per §6.4. New shapes plug in
// here without touching the YAML loader.
const classifierFixtures: Record<ClassifierFixtureName, Classifier> = {
  noop: () => null,
  neutral: () => ({ score_adjust: 0, reason: 'fixture: neutral' }),
  safe: () => ({ score_adjust: -0.1, reason: 'fixture: safe' }),
  risky: () => ({ score_adjust: 0.1, reason: 'fixture: risky' }),
  broken: () => ({ wrong: 'shape' }) as unknown as ReturnType<Classifier>,
  thrower: () => {
    throw new Error('fixture: thrower');
  },
};

export const runCase = (c: ConformanceCase): CaseRunResult => {
  // Dispatch to the §10.1 intersection runner when the case carries
  // a `declared_capabilities` set. The engine pipeline is skipped.
  if (c.setup.declared_capabilities !== undefined) {
    return runIntersectionCase(c);
  }
  // Dispatch to the §6.5 sandbox planner runner when the case carries
  // a `sandbox_capabilities` set. Same engine-bypass pattern.
  if (c.setup.sandbox_capabilities !== undefined) {
    return runSandboxSelectCase(c);
  }
  // Dispatch to the §7.2 hash chain runner when the case carries an
  // `audit_events` set. Same engine-bypass pattern.
  if (c.setup.audit_events !== undefined) {
    return runHashChainCase(c);
  }
  // Engine path: input is required (the YAML loader enforces this
  // when declared_capabilities is absent). Narrow the type so the
  // rest of the function can dereference c.input without guards.
  const input = c.input;
  if (input === undefined) {
    return {
      case: c,
      decision: null,
      ok: false,
      reasons: ['engine case requires `input` block'],
    };
  }
  const cwd = c.setup.cwd ?? '/work/proj';
  const home = c.setup.home ?? '/home/op';
  // §5 hierarchy resolution. When any of enterprise/user/session
  // policies are present, merge all provided layers via
  // `mergeLayers`. Otherwise fall back to the legacy single-layer
  // path that parses `project_policy` as the active policy.
  const hasMultiLayer =
    c.setup.enterprise_policy !== undefined ||
    c.setup.user_policy !== undefined ||
    c.setup.session_policy !== undefined;
  let policy: ReturnType<typeof loadPolicyFromString>;
  if (hasMultiLayer) {
    const layers: LayerPolicy[] = [];
    const parseLayer = (yaml: string | undefined, layer: LayerPolicy['layer']): void => {
      if (yaml === undefined) return;
      const trimmed = yaml.trim();
      if (trimmed.length === 0) return;
      layers.push({ layer, policy: loadPolicyFromString(yaml, { cwd, home }) });
    };
    parseLayer(c.setup.enterprise_policy, 'enterprise');
    parseLayer(c.setup.user_policy, 'user');
    parseLayer(c.setup.project_policy, 'project');
    parseLayer(c.setup.session_policy, 'session');
    policy = mergeLayers(layers).policy;
  } else {
    const policyYaml = c.setup.project_policy ?? '';
    policy =
      policyYaml.trim().length === 0
        ? loadPolicyFromString('defaults: { mode: strict }')
        : loadPolicyFromString(policyYaml, { cwd, home });
  }
  // Capture the audit row so score / score_components / capabilities
  // assertions can read what the engine actually emitted instead of
  // recomputing. Lets the suite anchor on the production wiring.
  interface CapturedRow {
    score?: number;
    score_components?: Record<string, number>;
    classifier_hash?: string | null;
    classifier_adjust?: number | null;
  }
  const captured: CapturedRow[] = [];
  const sink = {
    emit(input: CapturedRow) {
      captured.push(input);
      return { seq: captured.length, this_hash: `fake-${captured.length}` };
    },
    verifyChain() {
      return {
        ok: true as const,
        rows: captured.length,
        current_rotation_id: 0,
        quarantined: false,
      };
    },
  };
  const classifier =
    c.setup.classifier_fixture !== undefined
      ? classifierFixtures[c.setup.classifier_fixture]
      : undefined;
  // §8 grants snapshot for ttl_expiry conformance (slice 42). The
  // case provides a seed array + `now` timestamp; the runner filters
  // out revoked + expired rows BEFORE handing the snapshot to the
  // engine, so the engine's `listActive` call returns exactly what
  // the spec's `WHERE expires_at > snapshot_ts AND revoked_at IS NULL`
  // clause would return at that point in time. Engine path unchanged
  // when `setup.grants` is absent.
  const grantsProvider =
    c.setup.grants !== undefined ? buildGrantsProvider(c.setup.grants, c.setup.now) : undefined;
  const engine = createPermissionEngine(policy, {
    cwd,
    home,
    audit: sink,
    ...(c.setup.initialState !== undefined ? { initialState: c.setup.initialState } : {}),
    ...(classifier !== undefined ? { classifier } : {}),
    ...(c.setup.classifier_hash !== undefined ? { classifierHash: c.setup.classifier_hash } : {}),
    ...(c.setup.classifier_required === true ? { classifierRequired: true } : {}),
    ...(grantsProvider !== undefined ? { grants: grantsProvider } : {}),
  });
  const decision = engine.check(
    input.tool,
    input.category,
    input.args as Parameters<typeof engine.check>[2],
  );
  const auditRow = captured[0];

  // Resolver-side assertions consult the resolver directly. The
  // engine consumes the same result for its audit row, so this is
  // the source of truth for "what capabilities did this tool
  // declare" — independent of any policy gating.
  const needsResolver =
    c.expect.capabilities_include !== undefined || c.expect.resolver_kind !== undefined;
  const resolverResult = needsResolver
    ? resolveCapabilities(input.tool, input.args as Record<string, unknown>, { cwd, home })
    : null;

  const reasons: string[] = [];
  if (c.expect.kind !== undefined && decision.kind !== c.expect.kind) {
    reasons.push(`kind mismatch: expected ${c.expect.kind}, got ${decision.kind}`);
  }
  if (c.expect.resolver_kind !== undefined && resolverResult !== null) {
    if (resolverResult.kind !== c.expect.resolver_kind) {
      reasons.push(
        `resolver_kind mismatch: expected ${c.expect.resolver_kind}, got ${resolverResult.kind}`,
      );
    }
  }
  if (c.expect.capabilities_include !== undefined && resolverResult !== null) {
    if (resolverResult.kind === 'refuse') {
      reasons.push(
        `capabilities_include set but resolver refused (reason: ${resolverResult.reason})`,
      );
    } else {
      const got = new Set(resolverResult.capabilities.map(formatCapability));
      for (const expected of c.expect.capabilities_include) {
        if (!got.has(expected)) {
          reasons.push(
            `capabilities missing '${expected}' (got: ${[...got].sort().join(', ') || '<none>'})`,
          );
        }
      }
    }
  }
  if (c.expect.source_section !== undefined) {
    if (decision.source?.section !== c.expect.source_section) {
      reasons.push(
        `source.section mismatch: expected ${c.expect.source_section}, got ${decision.source?.section ?? '<absent>'}`,
      );
    }
  }
  if (c.expect.source_layer !== undefined) {
    if (decision.source?.layer !== c.expect.source_layer) {
      reasons.push(
        `source.layer mismatch: expected ${c.expect.source_layer}, got ${decision.source?.layer ?? '<absent>'}`,
      );
    }
  }
  if (c.expect.reason_substring !== undefined) {
    if (decision.reason === undefined || !decision.reason.includes(c.expect.reason_substring)) {
      reasons.push(
        `reason missing substring '${c.expect.reason_substring}' (got: ${decision.reason ?? '<absent>'})`,
      );
    }
  }
  // IEEE 754 epsilon for score bound comparisons. The spec weights
  // (§6.3.1) are decimal multiples of 0.05 that don't all round-trip
  // through binary float (e.g. 0.4 + 0.2 = 0.6000000000000001). Without
  // tolerance, exact-pin cases like score_gte=score_lte=0.6 fail
  // spuriously even when the engine is correct. 1e-9 is far below any
  // meaningful score delta and far above the float precision noise.
  const SCORE_EPSILON = 1e-9;
  if (c.expect.score_gte !== undefined) {
    const score = auditRow?.score ?? 0;
    if (score < c.expect.score_gte - SCORE_EPSILON) {
      reasons.push(`score_gte mismatch: expected >= ${c.expect.score_gte}, got ${score}`);
    }
  }
  if (c.expect.score_lte !== undefined) {
    const score = auditRow?.score ?? 0;
    if (score > c.expect.score_lte + SCORE_EPSILON) {
      reasons.push(`score_lte mismatch: expected <= ${c.expect.score_lte}, got ${score}`);
    }
  }
  if (c.expect.score_components_include !== undefined) {
    const components = auditRow?.score_components ?? {};
    for (const expectedComp of c.expect.score_components_include) {
      if (!(expectedComp in components)) {
        const got = Object.keys(components).sort().join(', ') || '<none>';
        reasons.push(`score_components missing '${expectedComp}' (got: ${got})`);
      }
    }
  }
  if (c.expect.classifier_hash !== undefined) {
    if (auditRow?.classifier_hash !== c.expect.classifier_hash) {
      reasons.push(
        `classifier_hash mismatch: expected ${c.expect.classifier_hash}, got ${auditRow?.classifier_hash ?? '<absent>'}`,
      );
    }
  }
  if (c.expect.classifier_adjust !== undefined) {
    const actual = auditRow?.classifier_adjust ?? null;
    if (actual !== c.expect.classifier_adjust) {
      reasons.push(
        `classifier_adjust mismatch: expected ${c.expect.classifier_adjust}, got ${actual}`,
      );
    }
  }
  if (c.expect.engine_state_after !== undefined) {
    if (engine.state() !== c.expect.engine_state_after) {
      reasons.push(
        `engine_state_after mismatch: expected ${c.expect.engine_state_after}, got ${engine.state()}`,
      );
    }
  }
  return { case: c, decision, ok: reasons.length === 0, reasons };
};
