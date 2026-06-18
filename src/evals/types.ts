import type { CompactionStrategy, ExitReason, HarnessResult } from '../harness/index.ts';
import type { ApprovalPosture } from '../permissions/index.ts';

// One declarative expectation evaluated against a finished run.
// Each shape carries exactly the data needed for its assertion;
// the executor switches on the `kind` discriminant.
export type EvalExpectation =
  | { kind: 'tool_called'; tool: string }
  | { kind: 'tool_not_called'; tool: string }
  // Asserts the tool was invoked AND the harness/permission engine
  // returned a deny decision for it. Critical for proving guards
  // fire under load: `file_not_exists` confirms the sandbox held,
  // but a model that never even attempted the call would satisfy
  // it vacuously. Pairing with `tool_denied` proves the gate
  // actually executed and refused — not that nothing happened.
  // Catches regressions where a future refactor makes a guard
  // silently allow what it was meant to block.
  | { kind: 'tool_denied'; tool: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_not_exists'; path: string }
  | { kind: 'file_contains'; path: string; pattern: string }
  | { kind: 'status'; status: HarnessResult['status'] }
  | { kind: 'exit_reason'; reason: ExitReason }
  | { kind: 'output_contains'; pattern: string }
  // Asserts the run took at least `count` steps. Pairs with a
  // forced dependency-chain prompt to prove the agent actually ran
  // a LONG trajectory — a model that shortcuts the chain in a few
  // steps fails even if it happens to land the answer. Critical for
  // long-horizon evals where the property under test (e.g. reasoning
  // continuity) only manifests across many tool round-trips; without
  // it a 3-step lucky pass would mask the regime we mean to measure.
  | { kind: 'min_steps'; count: number }
  // Compaction observability: assert that at least `minCount`
  // `compaction_finished` events fired during the run, optionally
  // restricted to a specific `strategy` ('llm' / 'fallback' /
  // 'skipped'). Without `strategy`, every emission counts.
  // Critical to observe explicitly because the harness emits a
  // `compaction_finished` event with `strategy: 'fallback'` when
  // the LLM call fails — silently masking adapter bugs unless
  // we assert against the strategy directly.
  | { kind: 'compaction_triggered'; minCount: number; strategy?: CompactionStrategy };

// Optional setup applied before the run: copy a fixture directory
// into the eval's temp cwd, then overwrite/create files declared
// inline. Inline files take precedence over fixture files at the
// same path.
export interface EvalSetup {
  // Path (relative to the eval YAML file) to a directory whose
  // contents are copied into the eval cwd as starting state.
  fixture?: string;
  // Inline files: { 'src/x.ts': 'export const x = 1\n' }. Useful
  // for cases too small to deserve a fixture dir.
  files?: Record<string, string>;
  // Initialize the eval cwd as a git work-tree (`git init`) before the run.
  // Needed for tools that require a repo (git_apply_patch) — the eval cache dir
  // is not otherwise a git repo, so without this they'd dead-end on
  // git.not_a_repo. cwd == worktree root, so patch paths resolve cleanly.
  gitInit?: boolean;
  // Initial approval posture (operation-mode, AGENTIC_CLI §8.1).
  // Default 'supervised'. Evals run headless (no confirm bridge), so
  // under 'supervised' a `confirm` verdict dead-ends as a deny; under
  // 'autonomous' a routine `policy` confirm auto-approves while risk
  // confirms still deny — the security invariant a posture eval pins.
  approvalPosture?: ApprovalPosture;
  // Hermetic HTTP stub for network tools (fetch_url). Maps an exact
  // request URL to a canned response. The executor swaps `globalThis.fetch`
  // for the duration of the run so the tool fetches the canned bytes
  // instead of the live network; unmatched URLs (the provider's own API
  // calls) pass through to the real fetch. Lets a model-in-the-loop eval
  // exercise fetch_url deterministically — the live-network alternative is
  // both flaky and blocked by the SSRF gate for local stub servers.
  httpStub?: Record<string, EvalHttpResponse>;
}

// One canned HTTP response for `EvalSetup.httpStub`.
export interface EvalHttpResponse {
  // Response body — for fetch_url, typically an HTML or text page.
  body: string;
  // HTTP status. Default 200.
  status?: number;
  // Content-Type header. Default 'text/html; charset=utf-8'.
  contentType?: string;
}

export interface EvalBudget {
  maxSteps?: number;
  maxCostUsd?: number;
  // Override the harness compaction trigger ratio for this case.
  // Useful for forcing compaction with small fixtures: setting
  // 0.01 means a ~2k-token prompt against a 200k-window provider
  // will trip compaction, instead of needing the default 70%
  // (~140k tokens).
  compactionThreshold?: number;
  // Override how many trailing turns compaction preserves
  // literally. Lower values let compaction fire more
  // aggressively in narrow tests.
  compactionPreserveTail?: number;
  // Enable the relevance compaction pre-pass for this case (default ON,
  // mirroring DEFAULT_BUDGET). Lets the eval measure relevance ON vs OFF on
  // the same scenario by pinning `false`.
  compactionRelevance?: boolean;
}

export interface EvalCase {
  name: string;
  // Resolved absolute path the case was loaded from. Used to
  // resolve `setup.fixture` relative paths.
  sourcePath: string;
  prompt: string;
  setup?: EvalSetup;
  expect: EvalExpectation[];
  budget?: EvalBudget;
}

export interface ExpectationOutcome {
  expectation: EvalExpectation;
  passed: boolean;
  // Human-readable detail when failed. Empty on pass.
  detail?: string;
}

export interface EvalCaseResult {
  name: string;
  sourcePath: string;
  // True iff every expectation passed AND the run finished without
  // an internal/provider error AND cost stayed within budget.
  passed: boolean;
  durationMs: number;
  // Pulled from the harness result; falsy when the run errored
  // before producing one (e.g., setup failure).
  status?: HarnessResult['status'];
  exitReason?: ExitReason;
  costUsd: number;
  steps: number;
  // True iff the run reported `usage` for every assistant turn.
  // When false, costUsd is a lower bound — surfaced so summary
  // stats can flag inflight underreporting.
  usageComplete: boolean;
  expectations: ExpectationOutcome[];
  // Top-level failure reason when the case never reached the
  // expect phase (fixture missing, runAgent threw, budget cap).
  failure?: string;
  // Pass-through of `HarnessResult.detail` — the provider error
  // message, the tool that exhausted the error budget, etc.
  // Surfacing it on the eval line keeps debugging a `tail | jq`
  // away instead of requiring a re-run with extra logging.
  detail?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number; // [0, 1]
  // p50 cost across cases that produced a cost number (passed or
  // failed equally). Undefined when no case produced cost.
  p50CostUsd?: number;
  totalCostUsd: number;
  totalDurationMs: number;
}
