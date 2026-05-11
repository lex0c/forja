// `agent welcome` — §13.5 first-boot UX. Composes `agent doctor`
// (slice 43) + `agent sandbox setup` (slice 44) + an intro and
// next-steps section into a single guided walkthrough.
//
// Designed for operators running Forja for the first time, but
// it's idempotent — running `agent welcome` later is harmless and
// useful as a "checkup". The verb doesn't write anything; it only
// reads the host state and prints recommendations.
//
// Output structure:
//   1. Welcome banner.
//   2. Doctor health check (5 checks from slice 43).
//   3. Sandbox setup recommendation (slice 44).
//   4. Next-steps menu.
//
// Plain text only — operators consuming structured data should call
// `agent doctor --json` and `agent sandbox setup --json` directly.

import { runDoctor } from './doctor.ts';
import { runSandboxSetup } from './sandbox-setup.ts';
import { createSandboxSkip, hasSandboxSkip } from './sandbox-skip.ts';

export interface RunWelcomeOptions {
  // Test seams — both inner verbs accept the same hooks. Forwarded
  // so welcome inherits their deterministic-test surface without
  // re-declaring shape.
  env?: NodeJS.ProcessEnv;
  which?: (cmd: string) => string | null;
  readOsRelease?: () => string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  // §13.5 first-boot UX (slice 91). When true, welcome creates
  // the `~/.config/forja/sandbox_skip` marker (if absent) AND
  // skips the sandbox-setup prompt for this run. Forwarded from
  // `--i-know-what-im-doing` on the CLI.
  iKnowWhatImDoing?: boolean;
  // Test seams for the sandbox_skip marker mechanism.
  hasSkipMarker?: (env: NodeJS.ProcessEnv) => boolean;
  createSkipMarker?: (env: NodeJS.ProcessEnv) => { path: string; created: boolean };
}

const INTRO_LINES = [
  'Welcome to Forja!',
  '',
  "Let's check your environment first, then walk you through how to get started.",
  '',
];

const SECTION_DIVIDER = '─'.repeat(60);

const NEXT_STEPS_LINES = [
  '',
  SECTION_DIVIDER,
  'Next steps',
  SECTION_DIVIDER,
  '',
  '  agent init                Generate a permission policy in .agent/',
  '  agent "your prompt"        Ask the agent something',
  '  agent --explain-permissions',
  '                            Show the resolved policy + per-section attribution',
  '  agent permission grants    List active grants',
  '  agent --help               See all options',
  '',
  'Run `agent doctor` any time to re-check the environment.',
];

export const runWelcome = async (options: RunWelcomeOptions = {}): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));

  for (const line of INTRO_LINES) out(`${line}\n`);

  out(`${SECTION_DIVIDER}\n`);
  out('Environment health check\n');
  out(`${SECTION_DIVIDER}\n\n`);

  // Forward all test seams so the welcome handler stays deterministic
  // under tests. Production callers leave them undefined and both
  // inner verbs fall back to system probes.
  const doctorCode = await runDoctor({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.which !== undefined ? { which: options.which } : {}),
    out,
    err,
  });

  out(`\n${SECTION_DIVIDER}\n`);
  out('Sandbox setup\n');
  out(`${SECTION_DIVIDER}\n\n`);

  // §13.5 sandbox_skip marker (slice 91). Two interacting gates:
  //   1. --i-know-what-im-doing on this run → create the marker
  //      (if absent) and skip the setup prompt;
  //   2. marker already present → silently skip the setup prompt.
  // Either path produces a one-line acknowledgment so audits +
  // operators tracing welcome output see WHY setup was skipped.
  // Marker has zero effect on runtime enforcement; engine still
  // degrades + confirms per the standard posture.
  const env = options.env ?? process.env;
  const hasSkip = (options.hasSkipMarker ?? ((e) => hasSandboxSkip({ env: e })))(env);
  const createSkip = options.createSkipMarker ?? ((e) => createSandboxSkip({ env: e }));

  let setupCode = 0;
  if (options.iKnowWhatImDoing === true) {
    const result = createSkip(env);
    out(
      result.created
        ? `Marker created at ${result.path} — sandbox setup will be silenced in future sessions.\n`
        : `Marker already at ${result.path} — sandbox setup will stay silenced.\n`,
    );
    out('Engine enforcement (degraded state, per-call confirm) is unchanged.\n');
  } else if (hasSkip) {
    out('Sandbox setup skipped — `~/.config/forja/sandbox_skip` marker present.\n');
    out('Remove that file to re-enable the prompt.\n');
  } else {
    setupCode = await runSandboxSetup({
      ...(options.which !== undefined ? { which: options.which } : {}),
      ...(options.readOsRelease !== undefined ? { readOsRelease: options.readOsRelease } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.arch !== undefined ? { arch: options.arch } : {}),
      out,
      err,
    });
  }

  for (const line of NEXT_STEPS_LINES) out(`${line}\n`);

  // Welcome's exit code is the worst of the two inner verbs. doctor
  // returns 1 on any `fail` check; sandbox-setup returns 1 only on
  // internal failure. Either non-zero → welcome non-zero so a CI
  // pipeline running `agent welcome` as a pre-deploy sanity check
  // surfaces the bad state via exit code.
  return Math.max(doctorCode, setupCode);
};
