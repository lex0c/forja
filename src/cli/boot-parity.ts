// Single source of truth for the parts of the boot contract that
// MUST stay identical between the one-shot path (`run.ts`) and the
// interactive path (`repl.ts`).
//
// `BootstrapResult` is consumed by both entrypoints, and historically
// the REPL drifted into honoring a subset of what `run.ts` did —
// dropping operator-intent flags (`--autonomous`, `--accept-broken-
// chain`, ...) and skipping the refusing-engine guard entirely. Each
// drift was a separate bug. Centralizing the shared pieces here makes
// the parity load-bearing: a new operator flag added to one caller is
// added to both, and the refusing diagnostic can't diverge.
//
// Contextual fields stay in the callers because they legitimately
// differ: `prompt` (real vs empty), `cwd`, `json`, `signal`,
// `resumeFromSessionId`, and the teardown each caller runs after a
// refusing exit (the REPL must also tear down its live renderer/stdin
// stack; the one-shot path has none).

import type { ParsedArgs } from './args.ts';
import type { BootstrapInput, BootstrapResult } from './bootstrap.ts';

// Maps the operator-facing CLI flags that translate purely into
// `BootstrapInput` and are identical for both entrypoints. The spread
// idiom (`...(cond ? {k:v} : {})`) keeps absent flags OUT of the
// object rather than setting them to `undefined`, so callers can spread
// the result without tripping exactOptionalPropertyTypes.
//
// Notes:
//  - `--autonomous` and `--accept-broken-chain` have NO config
//    fallback; if a caller forgets to forward them, they silently
//    no-op (engine boots supervised / refuses with no override).
//  - The memory `*_llm` toggles propagate both `true` AND `false`
//    (Slice Q): `undefined` = no CLI override (bootstrap resolves from
//    config/default); explicit `true`/`false` = operator opt-in/out.
export const operatorBootstrapFlags = (args: ParsedArgs): Partial<BootstrapInput> => ({
  // `--model` autosaves the selection to `[providers].model` so the next
  // start resolves to it. `persistModelPin` rides WITH `modelId` here —
  // the shared helper is the one place that covers BOTH operator
  // entrypoints (one-shot run.ts + REPL repl.ts) while excluding the
  // headless `forja recap` bootstrap (builds its input by hand) and
  // subagents (never bootstrap). bootstrap re-guards on the resolved id,
  // and `persistModelPin` compares before writing (no churn on repeats).
  ...(args.model !== undefined ? { modelId: args.model, persistModelPin: true } : {}),
  ...(args.noRecap === true ? { noRecap: true } : {}),
  ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
  ...(args.acceptBrokenChain === true ? { acceptBrokenChain: true } : {}),
  ...(args.sandboxHost === true ? { sandboxHost: true } : {}),
  // Gate 2 of host passthrough (SECURITY.md §4.1/§4.7). Forwarded here so
  // BOTH entrypoints (one-shot + REPL) thread the opt-in identically;
  // pairs with `--sandbox-host` above. The same flag ALSO drives the
  // welcome flow's `sandbox_skip` marker, but that path consumes
  // `args.iKnowWhatImDoing` directly in `run.ts` (welcome branch) and
  // never reaches bootstrap — so forwarding it for the agent run can't
  // collide with welcome.
  ...(args.iKnowWhatImDoing === true ? { iKnowWhatImDoing: true } : {}),
  ...(args.autonomous === true ? { approvalPosture: 'autonomous' as const } : {}),
  ...(args.brokerMode !== undefined ? { brokerMode: args.brokerMode } : {}),
  ...(args.autoApproveMcp !== undefined ? { autoApproveMcp: args.autoApproveMcp } : {}),
  ...(args.memoryVerifyLlm !== undefined ? { memorySemanticVerify: args.memoryVerifyLlm } : {}),
  ...(args.memoryConflictLlm !== undefined ? { memoryConflictDetect: args.memoryConflictLlm } : {}),
  ...(args.memoryOverrideLlm !== undefined ? { memoryOverrideDetect: args.memoryOverrideLlm } : {}),
});

// The permission-engine fields a caller needs to evaluate the refusing
// guard. A `Pick` (rather than the whole `BootstrapResult`) lets the
// callers pass a literal of just the destructured fields they already
// hold.
// `permissionRefusingReason` is spelled `string | undefined` (not the
// `Pick`'s optional `?: string`) so callers can pass the destructured
// local directly under exactOptionalPropertyTypes — the field is
// present-but-maybe-undefined in their object literal.
type RefusingFields = Pick<BootstrapResult, 'permissionState' | 'permissionChain'> & {
  permissionRefusingReason?: string | undefined;
};

// Emits the operator-facing diagnostic when the permission engine
// refused to come up (PERMISSION_ENGINE.md §7.2): broken audit chain,
// invalid policy, install_id I/O failure, or sandbox required-but-
// unavailable. `refusing` is terminal — every subsequent check denies
// until restart — so both entrypoints must abort the boot rather than
// hand the operator a session where every tool call silently denies.
//
// Returns `true` when the engine refused (caller should run its own
// teardown and exit 2); `false` otherwise (boot continues). The
// teardown + exit code stay in the caller because they differ: the
// REPL also tears down its live renderer/stdin stack.
export const reportRefusingEngine = (b: RefusingFields, errSink: (s: string) => void): boolean => {
  if (b.permissionState !== 'refusing') return false;
  const reason = b.permissionRefusingReason ?? 'unknown';
  errSink(`forja: permission engine refused to start — ${reason}\n`);
  if (!b.permissionChain.ok) {
    errSink(`  chain broken at seq ${b.permissionChain.brokenAt} (${b.permissionChain.reason})\n`);
    errSink('  to continue under the known break, re-run with --accept-broken-chain\n');
    errSink(
      '  (the override is itself audited — a `chain-break-accepted` row lands before any new decisions)\n',
    );
  }
  return true;
};
