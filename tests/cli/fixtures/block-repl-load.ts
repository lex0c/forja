// Bun --preload script used by tests/cli/index.test.ts. Registers a
// loader hook that throws if anything tries to import src/cli/repl.ts.
// Mirrors block-run-load.ts: the bare invocation (`forja` with no
// args, no TTY) must reject via the entry-level TTY check BEFORE
// loading the REPL stack — otherwise an install with broken
// provider/storage deps surfaces "unexpected error" instead of the
// clean "interactive mode requires a TTY" diagnostic for the user
// running `forja` in CI / piped stdin.
import { plugin } from 'bun';

plugin({
  name: 'block-repl-load',
  setup(build) {
    build.onLoad({ filter: /[/\\]cli[/\\]repl\.ts$/ }, () => {
      throw new Error('cli/repl.ts was loaded — TTY gate ran AFTER the import');
    });
  },
});
