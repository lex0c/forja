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

  // --list-sessions is a standalone inspection mode that takes no
  // prompt; the prompt-required gate below is the right shape for
  // every other entry path (a normal run, --plan, --resume — all
  // need an instruction for the model). Resume's empty-prompt
  // check fires inside run() with a more specific error.
  if (args.prompt.length === 0 && !args.listSessions) {
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
