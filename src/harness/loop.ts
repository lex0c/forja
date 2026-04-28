import { createHash } from 'node:crypto';
import type {
  GenerateRequest,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/index.ts';
import { appendMessage, completeSession, createSession } from '../storage/index.ts';
import type { ToolContext } from '../tools/index.ts';
import { abortableIterable } from './abortable.ts';
import { collectStep } from './collect.ts';
import { invokeTool } from './invoke-tool.ts';
import { DEFAULT_RETRY, generateWithRetry } from './retry.ts';
import {
  DEFAULT_BUDGET,
  type ExitReason,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessResult,
  type RunBudget,
} from './types.ts';

type TerminalSessionStatus = 'done' | 'interrupted' | 'exhausted' | 'error';

const safeEmit = (onEvent: HarnessConfig['onEvent'], event: HarnessEvent): void => {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Renderers throwing must not derail the loop.
  }
};

const stableStringify = (obj: unknown): string => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
};

const hashToolCall = (name: string, args: Record<string, unknown>): string =>
  createHash('sha256')
    .update(`${name}:${stableStringify(args)}`)
    .digest('hex');

const exitToStatus: Record<ExitReason, TerminalSessionStatus> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
};

const exitToHarnessStatus: Record<ExitReason, HarnessResult['status']> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
};

const buildToolDefs = (config: HarnessConfig): ProviderToolDef[] =>
  config.toolRegistry.list().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

// Strip `name` from the tool model so it stays inside our domain — providers
// expect their own format already constructed by the adapter.

export const runAgent = async (config: HarnessConfig): Promise<HarnessResult> => {
  const budget: RunBudget = { ...DEFAULT_BUDGET, ...(config.budget ?? {}) };
  const startMs = Date.now();

  // Combine the caller's abort signal with a wall-clock timer so the cap
  // fires even when a provider call hangs mid-step (between-step checks
  // miss this case). AbortSignal.any composes them; either firing aborts
  // downstream provider/tool work via the canonical signal.
  const wallClockController = new AbortController();
  const wallClockTimer = setTimeout(() => wallClockController.abort(), budget.maxWallClockMs);
  const callerSignal = config.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([callerSignal, wallClockController.signal]);

  const session = createSession(config.db, {
    model: config.provider.id,
    cwd: config.cwd,
  });

  const userMsg = appendMessage(config.db, {
    sessionId: session.id,
    role: 'user',
    content: config.userPrompt,
  });

  const messages: ProviderMessage[] = [{ role: 'user', content: config.userPrompt }];
  const tools = buildToolDefs(config);
  const recentToolHashes: string[] = [];
  const HASH_WINDOW = 5;

  let steps = 0;
  let consecutiveErrors = 0;
  let lastMessageId = userMsg.id;

  // Distinguish wall-clock from user abort — both use `signal.aborted` but
  // the user wants different exit reasons.
  const isWallClockTimeout = (): boolean =>
    wallClockController.signal.aborted && !callerSignal.aborted;

  const finish = (reason: ExitReason, detail?: string): HarnessResult => {
    clearTimeout(wallClockTimer);
    try {
      completeSession(config.db, session.id, exitToStatus[reason], 0);
    } catch {
      // Storage already broken; nothing useful to do beyond return the
      // result so the caller knows the run is over.
    }
    const result: HarnessResult = {
      status: exitToHarnessStatus[reason],
      reason,
      sessionId: session.id,
      steps,
      durationMs: Date.now() - startMs,
      lastMessageId,
    };
    if (detail !== undefined) result.detail = detail;
    safeEmit(config.onEvent, { type: 'session_finished', result });
    return result;
  };

  // Convert any uncaught exception (typically SQLite errors from append
  // operations) into a clean error exit instead of letting it crash the
  // caller. Tool exceptions are already wrapped by invokeTool; this catch
  // is for the persistence path that surrounds it.
  const guardedFinish = (e: unknown): HarnessResult => {
    const detail = e instanceof Error ? e.message || e.name || String(e) : String(e);
    return finish('internalError', detail);
  };

  safeEmit(config.onEvent, { type: 'session_start', sessionId: session.id });

  // The whole loop body is wrapped so SQLite errors (or any uncaught
  // throw from the persistence path) become a clean error exit instead
  // of crashing the caller. Tool exceptions are wrapped earlier by
  // invokeTool; this is the safety net for the surrounding writes.
  try {
    while (true) {
      if (signal.aborted) {
        return finish(isWallClockTimeout() ? 'maxWallClockMs' : 'aborted');
      }
      if (steps >= budget.maxSteps) return finish('maxSteps');

      steps += 1;
      safeEmit(config.onEvent, { type: 'step_start', stepN: steps });

      const req: GenerateRequest = {
        model: config.provider.id,
        // Snapshot the running message list so post-call mutations (the next
        // iteration appends assistant + tool_results) don't retroactively
        // change what the provider observed.
        messages: [...messages],
        max_tokens: budget.maxOutputTokensPerCall,
        ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      };

      let collected: Awaited<ReturnType<typeof collectStep>>;
      try {
        // Wrap the provider stream so the combined abort signal (user +
        // wall-clock) actually reaches the for-await inside collectStep.
        // The Provider interface doesn't propagate signals to the SDK,
        // so without this a hung HTTP request blocks indefinitely and
        // neither Ctrl+C nor maxWallClockMs can interrupt it.
        collected = await collectStep(
          abortableIterable(generateWithRetry(config.provider, req, DEFAULT_RETRY), signal),
          (ev) => safeEmit(config.onEvent, { type: 'provider_event', event: ev }),
        );
      } catch (e) {
        // SDK throws when the abort signal fires mid-call (Ctrl+C or
        // wall-clock timeout). Reroute to the matching ExitReason so the
        // user sees `interrupted` exit code 130 instead of a generic
        // `error` from `providerError`.
        if (signal.aborted) {
          return finish(isWallClockTimeout() ? 'maxWallClockMs' : 'aborted');
        }
        const detail = e instanceof Error ? e.message || e.name || String(e) : String(e);
        return finish('providerError', detail);
      }

      // Build assistant content blocks: text first, then tool_uses, mirroring
      // the order the model produced them. Empty text is omitted.
      const assistantContent: ProviderContentBlock[] = [];
      if (collected.text.length > 0) {
        assistantContent.push({ type: 'text', text: collected.text });
      }
      for (const tu of collected.tool_uses) {
        const block: ProviderToolUseBlock = {
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input,
        };
        assistantContent.push(block);
      }

      const assistantMsg = appendMessage(config.db, {
        sessionId: session.id,
        role: 'assistant',
        parentId: lastMessageId,
        content: assistantContent.length > 0 ? assistantContent : '',
      });
      lastMessageId = assistantMsg.id;
      if (assistantContent.length > 0) {
        messages.push({ role: 'assistant', content: assistantContent });
      }

      // Stream errors (normalizer-level: malformed tool_use args, orphan
      // tool_use_stop, etc.) mean the provider produced output we couldn't
      // structure correctly. The most common case is a malformed JSON
      // arguments stream — `tool_use_stop` is dropped and the call vanishes
      // from `tool_uses`. If we then exited as `done` because the array
      // is empty, the run reports success while silently losing the
      // model's intent. Surface this as a step-level failure instead.
      // The assistant message is already persisted above so the audit
      // trail keeps whatever text did come through.
      if (collected.errors.length > 0) {
        const detail = collected.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        return finish('providerError', `stream errors: ${detail}`);
      }

      // No tool uses → check the stop_reason before declaring success.
      // `end_turn`, `stop_sequence`, and `refusal` are all "model finished
      // speaking" (the refusal IS the response, even if it's a no). But
      // `max_tokens` means the per-call output cap truncated the answer
      // mid-stream; reporting `done` here would silently hand the user
      // an incomplete response with exit code 0. Surface it as an
      // `exhausted` exit so callers know to retry with a higher cap or
      // route to compaction (M2).
      if (collected.tool_uses.length === 0) {
        if (collected.stop_reason === 'max_tokens') {
          return finish(
            'maxOutputTokens',
            `provider truncated at max_tokens (cap=${budget.maxOutputTokensPerCall})`,
          );
        }
        return finish('done');
      }

      // Execute every tool_use in this step, collecting results.
      const toolResults: ProviderToolResultBlock[] = [];
      for (const tu of collected.tool_uses) {
        // Same wall-clock-vs-user-abort distinction as the top-of-loop
        // check; otherwise a wall-clock timeout that lands between tool
        // invocations gets misreported as a user abort.
        if (signal.aborted) {
          return finish(isWallClockTimeout() ? 'maxWallClockMs' : 'aborted');
        }

        // Degenerate-loop detection: hash this call and check the sliding
        // window. We do this BEFORE invocation so we can refuse cheaply.
        const h = hashToolCall(tu.name, tu.input);
        recentToolHashes.push(h);
        if (recentToolHashes.length > HASH_WINDOW) recentToolHashes.shift();
        const repeats = recentToolHashes.filter((x) => x === h).length;
        if (repeats >= budget.maxRepeatedToolHash) {
          return finish(
            'degenerateLoop',
            `tool ${tu.name} called ${repeats} times with identical args in last ${HASH_WINDOW} calls`,
          );
        }

        const ctx: ToolContext = {
          signal,
          cwd: config.cwd,
          sessionId: session.id,
          stepId: assistantMsg.id,
          permissions: config.permissionEngine.view(),
        };

        safeEmit(config.onEvent, {
          type: 'tool_invoking',
          toolUseId: tu.id,
          toolName: tu.name,
          args: tu.input,
        });

        const inv = await invokeTool(
          {
            toolUseId: tu.id,
            toolName: tu.name,
            args: tu.input,
            messageId: assistantMsg.id,
          },
          {
            db: config.db,
            registry: config.toolRegistry,
            engine: config.permissionEngine,
            ctx,
          },
        );

        if (inv.decision !== null) {
          safeEmit(config.onEvent, {
            type: 'tool_decided',
            toolUseId: tu.id,
            decision: inv.decision,
          });
        }
        safeEmit(config.onEvent, {
          type: 'tool_finished',
          toolUseId: tu.id,
          toolName: tu.name,
          failed: inv.failed,
          durationMs: inv.durationMs,
        });

        toolResults.push(inv.toolResult);
        if (inv.failed) {
          consecutiveErrors += 1;
        } else {
          consecutiveErrors = 0;
        }

        if (consecutiveErrors >= budget.maxToolErrors) {
          // Persist the partial tool_result message before bailing so the
          // session history reflects what actually happened. Mirror it in
          // the in-memory `messages` array for symmetry with the normal
          // path; nothing reads it post-bail today, but a future refactor
          // that does (resume, replay) gets a consistent view.
          const partialMsg = appendMessage(config.db, {
            sessionId: session.id,
            role: 'user',
            parentId: lastMessageId,
            content: toolResults,
          });
          lastMessageId = partialMsg.id;
          messages.push({ role: 'user', content: toolResults });
          return finish('maxToolErrors', `${consecutiveErrors} consecutive tool errors`);
        }
      }

      // Persist tool_results back as a user message; mirror them in the
      // running provider message list for the next turn.
      const resultMsg = appendMessage(config.db, {
        sessionId: session.id,
        role: 'user',
        parentId: lastMessageId,
        content: toolResults,
      });
      lastMessageId = resultMsg.id;
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    return guardedFinish(e);
  }
};
