import { migration001Initial } from './001-initial.ts';
import { migration002Approvals } from './002-approvals.ts';
import { migration003UsageCost } from './003-usage-cost.ts';
import { migration004SessionUsageComplete } from './004-session-usage-complete.ts';
import { migration005BackgroundProcesses } from './005-background-processes.ts';
import { migration006BgStderrCursor } from './006-bg-stderr-cursor.ts';
import { migration007MessageSeq } from './007-message-seq.ts';
import { migration008SessionSeq } from './008-session-seq.ts';
import { migration009Checkpoints } from './009-checkpoints.ts';
import { migration010Subagents } from './010-subagents.ts';
import { migration011SessionsIsSubagent } from './011-sessions-is-subagent.ts';
import { migration012SubagentRuns } from './012-subagent-runs.ts';
import { migration013SubagentWorktrees } from './013-subagent-worktrees.ts';
import { migration014SubagentOutputs } from './014-subagent-outputs.ts';
import { migration015SubagentRunsPolicy } from './015-subagent-runs-policy.ts';
import { migration016MemoryEvents } from './016-memory-events.ts';
import { migration017SessionsAbortCause } from './017-sessions-abort-cause.ts';
import { migration018ReplHistory } from './018-repl-history.ts';
import { migration019HookRuns } from './019-hook-runs.ts';
import { migration020SubagentRunsHooks } from './020-subagent-runs-hooks.ts';
import { migration021SubagentHandles } from './021-subagent-handles.ts';
import { migration022CostProgressEvents } from './022-cost-progress-events.ts';
import { migration023SubagentGateDecisions } from './023-subagent-gate-decisions.ts';
import { migration024SubagentRunsToolRestrictions } from './024-subagent-runs-tool-restrictions.ts';
import { migration025SubagentRunsSampling } from './025-subagent-runs-sampling.ts';
import { migration026SubagentRunsReferences } from './026-subagent-runs-references.ts';
import { migration027SubagentRunsOutputSchema } from './027-subagent-runs-output-schema.ts';
import { migration028SubagentRunsContextRecipe } from './028-subagent-runs-context-recipe.ts';
import { migration029SubagentProcesses } from './029-subagent-processes.ts';
import { migration030RecapRuns } from './030-recap-runs.ts';
import { migration031CritiqueRuns } from './031-critique-runs.ts';
import { migration032RecapCache } from './032-recap-cache.ts';
import { migration033RecapRunsCost } from './033-recap-runs-cost.ts';
import { migration034ApprovalsLog } from './034-approvals-log.ts';
import { migration035ChainRotation } from './035-chain-rotation.ts';
import { migration036SubagentGateEscalation } from './036-subagent-gate-escalation.ts';
import { migration037PolicyArchive } from './037-policy-archive.ts';
import { migration038ApprovalCallLinks } from './038-approval-call-links.ts';
import { migration039Grants } from './039-grants.ts';
import { migration040SubagentRunsEffectiveCapabilities } from './040-subagent-runs-effective-capabilities.ts';
import { migration041FailureEvents } from './041-failure-events.ts';
import { migration042OutcomeSignals } from './042-outcome-signals.ts';
import { migration043BgBytesDropped } from './043-bg-bytes-dropped.ts';
import { migration044HookRunsPostToolUseFailure } from './044-hook-runs-post-tool-use-failure.ts';
import { migration045ContextPins } from './045-context-pins.ts';
import { migration046EvictionEvents } from './046-eviction-events.ts';
import { migration047EvictionHookRuns } from './047-eviction-hook-runs.ts';
import { migration048MemoryEventsLifecycleActions } from './048-memory-events-lifecycle-actions.ts';
import { migration049Outcomes } from './049-outcomes.ts';
import { migration050Policies } from './050-policies.ts';
import { migration051DispatchRewrites } from './051-dispatch-rewrites.ts';
import { migration052EvictionThrashingScope } from './052-eviction-thrashing-scope.ts';
import { migration053RetrievalTrace } from './053-retrieval-trace.ts';
import { migration054MemoryProvenance } from './054-memory-provenance.ts';
import { migration055SharedCorpusTrust } from './055-shared-corpus-trust.ts';
import { migration056MemoryGovernanceProposals } from './056-memory-governance-proposals.ts';
import { migration057MemoryVerifyAttempts } from './057-memory-verify-attempts.ts';
import { migration058SubagentRunsScopeBuiltinAndApproval } from './058-subagent-runs-scope-builtin-and-approval.ts';
import { migration059MemoryVerifyAttemptsFkDiscipline } from './059-memory-verify-attempts-fk-discipline.ts';
import { migration060MemoryVerifyAttemptsBackfillDrift } from './060-memory-verify-attempts-backfill-drift.ts';
import { migration061MemoryConflictAttempts } from './061-memory-conflict-attempts.ts';
import { migration062MemoryGovernanceProposalsDefer } from './062-memory-governance-proposals-defer.ts';
import { migration063MemoryEventsDeferredAction } from './063-memory-events-deferred-action.ts';
import { migration064MemoryOverrideEvents } from './064-memory-override-events.ts';
import { migration065MemoryVerifyOverrideAttempts } from './065-memory-verify-override-attempts.ts';
import { migration066PurgeEvents } from './066-purge-events.ts';
import { migration067SkillEvents } from './067-skill-events.ts';
import { migration068PromptVersions } from './068-prompt-versions.ts';
import { migration069MemoryEventsSeedSource } from './069-memory-events-seed-source.ts';
import { migration070SubagentRunsApprovalPosture } from './070-subagent-runs-approval-posture.ts';
import { migration071ContextPinsModelCreatedBy } from './071-context-pins-model-created-by.ts';
import { migration072CompactionEvents } from './072-compaction-events.ts';
import { migration073CompactionEventsCallUsage } from './073-compaction-events-call-usage.ts';
import { migration074MessagesEffort } from './074-messages-effort.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  migration001Initial,
  migration002Approvals,
  migration003UsageCost,
  migration004SessionUsageComplete,
  migration005BackgroundProcesses,
  migration006BgStderrCursor,
  migration007MessageSeq,
  migration008SessionSeq,
  migration009Checkpoints,
  migration010Subagents,
  migration011SessionsIsSubagent,
  migration012SubagentRuns,
  migration013SubagentWorktrees,
  migration014SubagentOutputs,
  migration015SubagentRunsPolicy,
  migration016MemoryEvents,
  migration017SessionsAbortCause,
  migration018ReplHistory,
  migration019HookRuns,
  migration020SubagentRunsHooks,
  migration021SubagentHandles,
  migration022CostProgressEvents,
  migration023SubagentGateDecisions,
  migration024SubagentRunsToolRestrictions,
  migration025SubagentRunsSampling,
  migration026SubagentRunsReferences,
  migration027SubagentRunsOutputSchema,
  migration028SubagentRunsContextRecipe,
  migration029SubagentProcesses,
  migration030RecapRuns,
  migration031CritiqueRuns,
  migration032RecapCache,
  migration033RecapRunsCost,
  migration034ApprovalsLog,
  migration035ChainRotation,
  migration036SubagentGateEscalation,
  migration037PolicyArchive,
  migration038ApprovalCallLinks,
  migration039Grants,
  migration040SubagentRunsEffectiveCapabilities,
  migration041FailureEvents,
  migration042OutcomeSignals,
  migration043BgBytesDropped,
  migration044HookRunsPostToolUseFailure,
  migration045ContextPins,
  migration046EvictionEvents,
  migration047EvictionHookRuns,
  migration048MemoryEventsLifecycleActions,
  migration049Outcomes,
  migration050Policies,
  migration051DispatchRewrites,
  migration052EvictionThrashingScope,
  migration053RetrievalTrace,
  migration054MemoryProvenance,
  migration055SharedCorpusTrust,
  migration056MemoryGovernanceProposals,
  migration057MemoryVerifyAttempts,
  migration058SubagentRunsScopeBuiltinAndApproval,
  migration059MemoryVerifyAttemptsFkDiscipline,
  migration060MemoryVerifyAttemptsBackfillDrift,
  migration061MemoryConflictAttempts,
  migration062MemoryGovernanceProposalsDefer,
  migration063MemoryEventsDeferredAction,
  migration064MemoryOverrideEvents,
  migration065MemoryVerifyOverrideAttempts,
  migration066PurgeEvents,
  migration067SkillEvents,
  migration068PromptVersions,
  migration069MemoryEventsSeedSource,
  migration070SubagentRunsApprovalPosture,
  migration071ContextPinsModelCreatedBy,
  migration072CompactionEvents,
  migration073CompactionEventsCallUsage,
  migration074MessagesEffort,
];
