import type { ExitReason, HarnessResult } from '../harness/index.ts';

// One declarative expectation evaluated against a finished run.
// Each shape carries exactly the data needed for its assertion;
// the executor switches on the `kind` discriminant.
export type CompactionStrategy = 'llm' | 'fallback' | 'skipped';

export type EvalExpectation =
  | { kind: 'tool_called'; tool: string }
  | { kind: 'tool_not_called'; tool: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_not_exists'; path: string }
  | { kind: 'file_contains'; path: string; pattern: string }
  | { kind: 'status'; status: HarnessResult['status'] }
  | { kind: 'exit_reason'; reason: ExitReason }
  | { kind: 'output_contains'; pattern: string }
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
}

export interface EvalCase {
  name: string;
  // Resolved absolute path the case was loaded from. Used to
  // resolve `setup.fixture` relative paths.
  sourcePath: string;
  prompt: string;
  // When true, the harness runs in plan mode (writes blocked).
  // Same flag the CLI exposes as `--plan`.
  plan?: boolean;
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
