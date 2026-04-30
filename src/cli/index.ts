#!/usr/bin/env bun
import { parseArgs, usage } from './args.ts';

const VERSION = '0.0.0';

const main = async (): Promise<number> => {
  const parsed = parseArgs(Bun.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`forja: ${parsed.message}\n\n${usage()}\n`);
    return 1;
  }
  const { args } = parsed;

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (args.version) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return 0;
  }

  // Inspection / lifecycle modes don't need a prompt:
  //   - --list-sessions: pure DB read.
  //   - --undo / --checkpoints: DB + git only, no provider call.
  // Every other entry path (normal run, --plan, --resume) does need
  // an instruction for the model. Resume's empty-prompt check fires
  // inside run() with a more specific error.
  const promptOptional =
    args.listSessions || args.undo !== undefined || args.checkpoints !== undefined;
  if (args.prompt.length === 0 && !promptOptional) {
    process.stderr.write(`forja: missing prompt\n\n${usage()}\n`);
    return 1;
  }

  // Lazy import: pulling `./run.ts` transitively loads provider SDKs,
  // storage, permissions — the whole stack. Keeping it behind the help/
  // version branches means a broken or missing provider dep can't break
  // `forja --help` or `forja --version`, which users hit first when
  // diagnosing install issues.
  const { run } = await import('./run.ts');
  return run({ args });
};

// `run()` has its own try/catch for expected failures (bootstrap, runtime).
// This outer wrap catches anything synchronous in `main` itself or any
// stray throw `run()` doesn't handle, so the user gets a diagnostic
// instead of Bun's default unhandled-rejection trace.
let code: number;
try {
  code = await main();
} catch (e) {
  const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
  process.stderr.write(`forja: unexpected error: ${msg}\n`);
  code = 1;
}
process.exit(code);
