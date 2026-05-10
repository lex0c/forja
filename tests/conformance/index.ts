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
import {
  type Decision,
  type PolicyCategory,
  createPermissionEngine,
} from '../../src/permissions/index.ts';
import { loadPolicyFromString } from '../../src/permissions/index.ts';

export interface ConformanceCase {
  name: string;
  setup: {
    project_policy?: string;
    cwd?: string;
    home?: string;
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
  const engine = createPermissionEngine(policy, { cwd, home });
  const decision = engine.check(
    c.input.tool,
    c.input.category,
    c.input.args as Parameters<typeof engine.check>[2],
  );

  const reasons: string[] = [];
  if (decision.kind !== c.expect.kind) {
    reasons.push(`kind mismatch: expected ${c.expect.kind}, got ${decision.kind}`);
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
  return { case: c, decision, ok: reasons.length === 0, reasons };
};
