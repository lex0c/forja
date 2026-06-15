// `forja welcome` — §13.5 first-boot UX. Composes `forja doctor`
// (slice 43) + `forja sandbox setup` (slice 44) + an intro and
// next-steps section into a single guided walkthrough.
//
// Designed for operators running Forja for the first time, but
// it's idempotent — running `forja welcome` later is harmless and
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
// `forja doctor --json` and `forja sandbox setup --json` directly.
//
// DEFERRED (REVIEW_NOTES.md R9 P0 #10 / slice 125 decision-C):
// Spec PERMISSION_ENGINE.md §13.4 and §13.5 describe a dual-confirm
// interactive menu for the sandbox-absent case:
//   [1] Show         — display install commands
//   [2] Run install  — requires --yes AND writes `ci_mode_acknowledged`
//                      to the policy
//   [3] Continue unsafe — writes `unsafe_mode_acknowledged_at` to the
//                         policy
//   [4] Cancel
//
// The current implementation is INFO-ONLY: it prints the install
// recommendations and leaves the policy untouched. The operator's
// existing acknowledgment surface is `--i-know-what-im-doing` (slice
// 91), which writes the `~/.config/forja/sandbox_skip` marker. The
// dual-confirm + per-policy acknowledgment fields are deliberately
// deferred — implementing them is ~300-500 LOC of TUI + policy
// schema migration for a UX gain that the marker already covers in
// 99% of cases.
//
// The gap is acknowledged, not denied. A future slice can implement
// the spec-canonical menu when (a) operator reports show real
// friction with the marker-only flow, or (b) compliance scenarios
// emerge that need per-policy `*_acknowledged_at` timestamps for
// audit trails. Until then, the marker IS the acknowledgment.

import { appDirName } from '../config/app-namespace.ts';
import { runDoctor } from './doctor.ts';
import { runSandboxSetup } from './sandbox-setup.ts';
import {
  type SandboxSkipMetadata,
  createSandboxSkip,
  hasSandboxSkip,
  readSandboxSkipMetadata,
} from './sandbox-skip.ts';

export interface RunWelcomeOptions {
  // Test seams — both inner verbs accept the same hooks. Forwarded
  // so welcome inherits their deterministic-test surface without
  // re-declaring shape.
  env?: NodeJS.ProcessEnv;
  which?: (cmd: string) => string | null;
  // Slice 154 (review): forward canonical-first resolver seams.
  exists?: (path: string) => boolean;
  stat?: (path: string) => { uid: number; mode: number } | null;
  isExecutable?: (path: string) => boolean;
  // Forwarded to the embedded `runDoctor` (the env-health section).
  // Without these, the doctor's net_filtering / mac_lsm /
  // user_namespaces probes hit the real host (nft --version,
  // getenforce, /proc), and that output leaks into welcome's own
  // assertions — e.g. a runner without nftables renders "nft ...
  // version probe failed", which trips a `not.toContain('version ')`
  // check. Stubbable so welcome's output is host-independent.
  readFile?: (path: string) => string | null;
  runCmd?: (cmd: string, args: readonly string[]) => string | null;
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
  // Slice 123 (R9 P1): read the marker's metadata for the
  // "Sandbox setup skipped — marker present (created <ts>)"
  // message. Returns null when absent / unreadable / non-regular-
  // file (welcome falls back to the no-timestamp message).
  readSkipMarker?: (env: NodeJS.ProcessEnv) => SandboxSkipMetadata | null;
}

const INTRO_LINES = [
  'Welcome to Forja!',
  '',
  "Let's check your environment first, then walk you through how to get started.",
  '',
];

const SECTION_DIVIDER = '─'.repeat(60);

// Slice 125 (R2 P2): strip CC0 (U+0000-U+001F) + CC1 (U+0080-U+009F)
// control characters. Used to sanitize operator-readable values
// (e.g., marker timestamps parsed from a file body) before
// emitting to stdout, where ANSI escape sequences (`\x1b...`)
// or window-title escapes (`\x1b]0;evil\x07`) would otherwise
// render. Preserves common whitespace (\t, \n, \r) for layout.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule's purpose IS to match control chars (defense intent)
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const stripControlChars = (s: string): string => s.replace(CONTROL_CHAR_RE, '');

const NEXT_STEPS_LINES = [
  '',
  SECTION_DIVIDER,
  'Next steps',
  SECTION_DIVIDER,
  '',
  '  forja init                Scaffold the .forja/ bootstrap bundle',
  '                            (permissions, gitignore, config, playbooks)',
  '  forja "your prompt"        Ask the agent something',
  '  forja --explain-permissions',
  '                            Show the resolved policy + per-section attribution',
  '  forja permission grants    List active grants',
  '  forja --help               See all options',
  '',
  'Run `forja doctor` any time to re-check the environment.',
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
    ...(options.exists !== undefined ? { exists: options.exists } : {}),
    ...(options.stat !== undefined ? { stat: options.stat } : {}),
    ...(options.isExecutable !== undefined ? { isExecutable: options.isExecutable } : {}),
    ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
    ...(options.runCmd !== undefined ? { runCmd: options.runCmd } : {}),
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
  const readSkip = options.readSkipMarker ?? ((e) => readSandboxSkipMetadata({ env: e }));

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
    // Slice 123 (R9 P1): surface the marker's created/version
    // metadata so operators can see WHEN they last opted into
    // unsafe mode. Falls back to the no-timestamp message when
    // the marker is unreadable / corrupted (rare; readSkipMarker
    // returns null defensively).
    //
    // Slice 125 (R2 P2): strip control characters before printing.
    // The marker body is operator-controlled (per slice 122 docs
    // it's expected to be hand-inspected, sometimes hand-edited).
    // If an attacker can write the marker (mode 0600 makes that
    // require operator-level access — already game-over for most
    // threat models, but defense in depth) they could inject
    // ANSI / window-title escape sequences (`\x1b]0;evil\x07`)
    // that render arbitrarily in the operator's terminal.
    // Strip CC0/CC1 control chars before emitting.
    const meta = readSkip(env);
    if (meta !== null && meta.createdAt !== undefined) {
      const safeCreatedAt = stripControlChars(meta.createdAt);
      const safeVersion = meta.version !== undefined ? stripControlChars(meta.version) : undefined;
      const safePath = stripControlChars(meta.path);
      const versionStr = safeVersion !== undefined ? `, version ${safeVersion}` : '';
      out(
        `Sandbox setup skipped — marker present at ${safePath} (created ${safeCreatedAt}${versionStr}).\n`,
      );
    } else {
      out(
        `Sandbox setup skipped — \`~/.config/${appDirName(env)}/sandbox_skip\` marker present.\n`,
      );
    }
    out('Remove that file to re-enable the prompt.\n');
  } else {
    setupCode = await runSandboxSetup({
      ...(options.which !== undefined ? { which: options.which } : {}),
      ...(options.exists !== undefined ? { exists: options.exists } : {}),
      ...(options.stat !== undefined ? { stat: options.stat } : {}),
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
  // pipeline running `forja welcome` as a pre-deploy sanity check
  // surfaces the bad state via exit code.
  return Math.max(doctorCode, setupCode);
};
