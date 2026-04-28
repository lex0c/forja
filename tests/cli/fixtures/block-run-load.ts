// Bun --preload script used by tests/cli/index.test.ts. Registers a
// loader hook that throws if anything tries to import src/cli/run.ts —
// the file that transitively pulls the provider stack. If main()
// regresses to a top-level `import './run.ts'`, the help/version
// subprocess test in index.test.ts will fail because this hook fires
// before main() even runs.
import { plugin } from 'bun';

plugin({
  name: 'block-run-load',
  setup(build) {
    build.onLoad({ filter: /[/\\]cli[/\\]run\.ts$/ }, () => {
      throw new Error('cli/run.ts was loaded — lazy import is broken');
    });
  },
});
