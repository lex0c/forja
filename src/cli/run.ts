import { type HarnessResult, runAgent } from '../harness/index.ts';
import type { ParsedArgs } from './args.ts';
import { type BootstrapInput, bootstrap } from './bootstrap.ts';
import { createJsonRenderer } from './output/json.ts';
import { createPlainRenderer } from './output/plain.ts';
import type { OutputRenderer } from './output/types.ts';
import { installSignalHandler } from './signal.ts';

export interface RunOptions {
  args: ParsedArgs;
  // Test seams: defaults derive from args + process state in production.
  bootstrapOverride?: Partial<BootstrapInput>;
  signal?: AbortSignal;
  // Inject a renderer to capture output instead of writing to process
  // streams. Skips the json/plain selection branch when set.
  rendererOverride?: OutputRenderer;
  // Sink for the catastrophic "forja: <error>" line printed when
  // bootstrap or runAgent throws unexpectedly. Defaults to
  // process.stderr; tests inject a string collector.
  errSink?: (s: string) => void;
}

const pickRenderer = (args: ParsedArgs): OutputRenderer => {
  if (args.json) return createJsonRenderer();
  // ANSI colors only when stderr is a TTY and NO_COLOR is unset.
  // Stdout might be piped (`agent "..." | tee`); stderr is where indicators
  // live, so its TTY-ness is what matters for color decisions.
  const useColor = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;
  return createPlainRenderer({ useColor });
};

// Maps harness exit reasons to process exit codes per spec §2.2.
//   0  done                                 (success)
//   1  task error (provider, tool errors)   (generic failure)
//   2  exhausted (budget caps)              (per spec)
//  130 interrupted (SIGINT, abort)          (Unix convention)
export const exitCodeFor = (result: HarnessResult): number => {
  switch (result.status) {
    case 'done':
      return 0;
    case 'exhausted':
      return 2;
    case 'interrupted':
      return 130;
    case 'error':
      return 1;
  }
};

export const run = async (options: RunOptions): Promise<number> => {
  const { args } = options;
  const renderer = options.rendererOverride ?? pickRenderer(args);
  const errSink = options.errSink ?? ((s: string) => process.stderr.write(s));

  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  // In production, wire SIGINT to abort. Tests pass their own signal and
  // skip the handler.
  const restoreSignal =
    options.signal === undefined ? installSignalHandler(controller) : () => undefined;

  try {
    const bootstrapInput: BootstrapInput = {
      prompt: args.prompt,
      ...(args.model !== undefined ? { modelId: args.model } : {}),
      ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
      signal,
      ...(options.bootstrapOverride ?? {}),
    };
    const { config, db } = bootstrap(bootstrapInput);
    const cfg = {
      ...config,
      onEvent: (e: Parameters<OutputRenderer['onEvent']>[0]) => renderer.onEvent(e),
    };
    try {
      const result = await runAgent(cfg);
      renderer.flush();
      return exitCodeFor(result);
    } finally {
      db.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    errSink(`forja: ${msg}\n`);
    return 1;
  } finally {
    restoreSignal();
  }
};
