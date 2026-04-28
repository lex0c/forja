import type { Decision, PermissionEngine, ToolArgs } from '../permissions/index.ts';
import type { ProviderToolResultBlock } from '../providers/index.ts';
import {
  type DB,
  createToolCall,
  finishToolCall,
  recordApproval,
  startToolCall,
  withTransaction,
} from '../storage/index.ts';
import {
  type Tool,
  type ToolContext,
  type ToolError,
  type ToolRegistry,
  isToolError,
} from '../tools/index.ts';

export interface InvokeToolInput {
  toolUseId: string;
  toolName: string;
  args: Record<string, unknown>;
  messageId: string;
}

export interface InvokeToolDeps {
  db: DB;
  registry: ToolRegistry;
  engine: PermissionEngine;
  ctx: ToolContext;
}

export interface InvokeToolResult {
  toolResult: ProviderToolResultBlock;
  toolCallId: string;
  durationMs: number;
  // True when the call surfaced any failure mode (unknown tool, denied,
  // confirmation required, tool error, exception). Used by the loop to
  // count consecutive errors against `maxToolErrors`.
  failed: boolean;
  // Permission decision that gated this call. Null when the tool wasn't
  // found (no decision happened). The loop uses this to emit a
  // `tool_decided` event for renderers.
  decision: Decision | null;
}

const buildErrorBlock = (
  toolUseId: string,
  toolName: string,
  message: string,
): ProviderToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  name: toolName,
  content: message,
  is_error: true,
});

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) {
    // Empty `message` is a real case (`new Error()`); fall through to name
    // and finally toString so we never report `tool crashed: ` with no body.
    return e.message || e.name || String(e);
  }
  return String(e);
};

const wrapException = (e: unknown): ToolError => ({
  is_error: true,
  error_code: 'tool.exception',
  error_message: `tool crashed: ${errorMessage(e)}`,
  retryable: false,
});

// Single-tool pipeline:
//   1. Look up the tool. Unknown name → error tool_result, no DB rows.
//   2. Persist the tool_call row.
//   3. Run the permission engine; record the approval against the row.
//   4. On allow → start, execute, finish. On deny / confirm → finish with
//      the appropriate status and surface the reason as an error result.
//   5. Tool exceptions never propagate — they become tool_result errors.
export const invokeTool = async (
  input: InvokeToolInput,
  deps: InvokeToolDeps,
): Promise<InvokeToolResult> => {
  const start = Date.now();
  const tool: Tool | null = deps.registry.get(input.toolName);
  if (tool === null) {
    return {
      toolResult: buildErrorBlock(
        input.toolUseId,
        input.toolName,
        `unknown tool: ${input.toolName}`,
      ),
      toolCallId: '',
      durationMs: Date.now() - start,
      failed: true,
      decision: null,
    };
  }

  const decision = deps.engine.check(
    input.toolName,
    tool.metadata.category,
    input.args as ToolArgs,
  );

  // Setup phase: persist the tool_call, the approval, and the initial
  // status (denied / running) atomically. Without the transaction, a
  // crash between createToolCall and recordApproval leaves an orphan
  // call row; between recordApproval and finishToolCall leaves a row
  // stuck in 'pending' with an approval that says it should be denied.
  type Setup =
    | { phase: 'denied'; toolCall: { id: string }; reason: string }
    | { phase: 'confirm_no'; toolCall: { id: string }; prompt: string }
    | { phase: 'started'; toolCall: { id: string } };

  const setup = withTransaction(deps.db, (): Setup => {
    const toolCall = createToolCall(deps.db, {
      messageId: input.messageId,
      toolName: input.toolName,
      input: input.args,
    });

    if (decision.kind === 'deny') {
      recordApproval(deps.db, {
        toolCallId: toolCall.id,
        decision: 'deny',
        decidedBy: 'policy',
        reason: decision.reason,
      });
      finishToolCall(deps.db, {
        id: toolCall.id,
        status: 'denied',
        durationMs: Date.now() - start,
        error: decision.reason,
      });
      return { phase: 'denied', toolCall, reason: decision.reason };
    }

    if (decision.kind === 'confirm') {
      // M1 has no UI to ask the user, so we treat `confirm` as denied with a
      // dedicated reason. Step 6 (TUI) will wire a real confirm prompt and
      // change `decision` to `confirm_yes`/`confirm_no` based on user input.
      recordApproval(deps.db, {
        toolCallId: toolCall.id,
        decision: 'confirm_no',
        decidedBy: 'policy',
        reason: 'confirmation required, no UI in M1',
      });
      finishToolCall(deps.db, {
        id: toolCall.id,
        status: 'denied',
        durationMs: Date.now() - start,
        error: `confirmation required: ${decision.prompt}`,
      });
      return { phase: 'confirm_no', toolCall, prompt: decision.prompt };
    }

    // allow
    recordApproval(deps.db, {
      toolCallId: toolCall.id,
      decision: 'allow',
      decidedBy: 'policy',
      reason: decision.reason ?? null,
    });
    startToolCall(deps.db, toolCall.id);
    return { phase: 'started', toolCall };
  });

  if (setup.phase === 'denied') {
    return {
      toolResult: buildErrorBlock(input.toolUseId, input.toolName, `denied: ${setup.reason}`),
      toolCallId: setup.toolCall.id,
      durationMs: Date.now() - start,
      failed: true,
      decision,
    };
  }

  if (setup.phase === 'confirm_no') {
    return {
      toolResult: buildErrorBlock(
        input.toolUseId,
        input.toolName,
        `requires user confirmation: ${setup.prompt}`,
      ),
      toolCallId: setup.toolCall.id,
      durationMs: Date.now() - start,
      failed: true,
      decision,
    };
  }

  const toolCall = setup.toolCall;

  let result: unknown;
  let crashed = false;
  try {
    result = await tool.execute(input.args, deps.ctx);
  } catch (e) {
    result = wrapException(e);
    crashed = true;
  }

  const duration = Date.now() - start;

  if (isToolError(result) || crashed) {
    const err = result as ToolError;
    finishToolCall(deps.db, {
      id: toolCall.id,
      status: 'error',
      output: err,
      durationMs: duration,
      error: err.error_message,
    });
    return {
      toolResult: buildErrorBlock(input.toolUseId, input.toolName, JSON.stringify(err)),
      toolCallId: toolCall.id,
      durationMs: duration,
      failed: true,
      decision,
    };
  }

  finishToolCall(deps.db, {
    id: toolCall.id,
    status: 'done',
    output: result,
    durationMs: duration,
  });
  return {
    toolResult: {
      type: 'tool_result',
      tool_use_id: input.toolUseId,
      name: input.toolName,
      content: JSON.stringify(result),
    },
    toolCallId: toolCall.id,
    durationMs: duration,
    failed: false,
    decision,
  };
};
