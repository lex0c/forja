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
];
