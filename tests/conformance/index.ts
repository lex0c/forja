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
import { formatCapability } from '../../src/permissions/capabilities.ts';
import {
  type Decision,
  type EngineState,
  type PolicyCategory,
  createPermissionEngine,
} from '../../src/permissions/index.ts';
import { loadPolicyFromString } from '../../src/permissions/index.ts';
import { resolveCapabilities } from '../../src/permissions/resolvers/index.ts';

export interface ConformanceCase {
  name: string;
  setup: {
    project_policy?: string;
    cwd?: string;
    home?: string;
    // Pin the engine into a non-default state before the input
    // runs. Used by §2 state-machine cases (init/loading-policy/
    // validating-chain/refusing reject every check; degraded
    // upgrades allow → confirm).
    initialState?: EngineState;
  };
  input: {
    tool: string;
    category: PolicyCategory;
    args: Record<string, unknown>;
  };
  expect: {
    kind: 'allow' | 'deny' | 'confirm';
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
    if (typeof obj.input !== 'object' || obj.input === null) {
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
  decision: Decision;
  ok: boolean;
  reasons: string[];
}

export const runCase = (c: ConformanceCase): CaseRunResult => {
  const cwd = c.setup.cwd ?? '/work/proj';
  const home = c.setup.home ?? '/home/op';
  const policyYaml = c.setup.project_policy ?? '';
  const policy =
    policyYaml.trim().length === 0
      ? loadPolicyFromString('defaults: { mode: strict }')
      : loadPolicyFromString(policyYaml, { cwd, home });
  // Capture the audit row so score / score_components / capabilities
  // assertions can read what the engine actually emitted instead of
  // recomputing. Lets the suite anchor on the production wiring.
  interface CapturedRow {
    score?: number;
    score_components?: Record<string, number>;
  }
  const captured: CapturedRow[] = [];
  const sink = {
    emit(input: CapturedRow) {
      captured.push(input);
      return { seq: captured.length, this_hash: `fake-${captured.length}` };
    },
    verifyChain() {
      return { ok: true as const, rows: captured.length };
    },
  };
  const engine = createPermissionEngine(policy, {
    cwd,
    home,
    audit: sink,
    ...(c.setup.initialState !== undefined ? { initialState: c.setup.initialState } : {}),
  });
  const decision = engine.check(
    c.input.tool,
    c.input.category,
    c.input.args as Parameters<typeof engine.check>[2],
  );
  const auditRow = captured[0];

  // Resolver-side assertions consult the resolver directly. The
  // engine consumes the same result for its audit row, so this is
  // the source of truth for "what capabilities did this tool
  // declare" — independent of any policy gating.
  const needsResolver =
    c.expect.capabilities_include !== undefined || c.expect.resolver_kind !== undefined;
  const resolverResult = needsResolver
    ? resolveCapabilities(c.input.tool, c.input.args as Record<string, unknown>, { cwd, home })
    : null;

  const reasons: string[] = [];
  if (decision.kind !== c.expect.kind) {
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
  if (c.expect.score_gte !== undefined) {
    const score = auditRow?.score ?? 0;
    if (score < c.expect.score_gte) {
      reasons.push(`score_gte mismatch: expected >= ${c.expect.score_gte}, got ${score}`);
    }
  }
  if (c.expect.score_lte !== undefined) {
    const score = auditRow?.score ?? 0;
    if (score > c.expect.score_lte) {
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
  return { case: c, decision, ok: reasons.length === 0, reasons };
};
