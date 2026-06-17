// Global `--profile <name>` / `--profile=<name>` pre-parse pass.
//
// `--profile` selects an ISOLATED on-disk namespace (see
// `config/app-namespace.ts`): a dev build runs against `~/.config/forja-dev`,
// `~/.local/share/forja-dev`, `<cwd>/.forja-dev`, … so it can't migrate or
// pollute the operator's real `forja` state. It is the CLI front-end for the
// `FORJA_PROFILE` env var.
//
// This MUST run before `parseArgs` and before any path resolver fires, for two
// reasons:
//   1. The resolvers read `process.env.FORJA_PROFILE` at call time, so the env
//      var has to be set first — we set it here, not via a parsed arg.
//   2. `--profile` is global (valid before or after the subcommand), but every
//      subcommand parser would reject it as unknown. So we strip it from argv
//      and hand the rest to `parseArgs`.
//
// A bare `FORJA_PROFILE=dev forja …` env var works too (no flag); the flag wins
// when both are present. Either way the value is validated HERE so a typo fails
// fast with a clean usage error instead of throwing deep in the first resolver.

import { isValidProfile } from '../config/app-namespace.ts';

export interface ProfileFlagResult {
  // argv with the `--profile` token(s) removed, ready for parseArgs.
  argv: string[];
  // Set when the flag/env value is malformed; the caller prints it + usage.
  error?: string;
}

const PROFILE_RULE = 'must be lowercase alphanumeric + hyphen (matching [a-z0-9][a-z0-9-]*)';

export const applyProfileFlag = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ProfileFlagResult => {
  const out: string[] = [];
  let flagValue: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '--profile') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        // Caller bails on `error` and never reads argv, so return the clean
        // accumulated argv — same shape as the other error paths.
        return { argv: out, error: '--profile requires a value (e.g. --profile dev)' };
      }
      flagValue = next;
      i++; // consume the value token
      continue;
    }
    if (tok.startsWith('--profile=')) {
      flagValue = tok.slice('--profile='.length);
      continue;
    }
    out.push(tok);
  }

  if (flagValue !== undefined) {
    if (!isValidProfile(flagValue)) {
      return { argv: out, error: `invalid --profile '${flagValue}': ${PROFILE_RULE}` };
    }
    env.FORJA_PROFILE = flagValue;
    return { argv: out };
  }

  // No flag — validate a pre-existing env value so `FORJA_PROFILE=Bad forja`
  // also fails fast and clean here, with the same message shape.
  const raw = env.FORJA_PROFILE;
  if (raw !== undefined && raw.length > 0 && !isValidProfile(raw)) {
    return { argv: out, error: `invalid FORJA_PROFILE '${raw}': ${PROFILE_RULE}` };
  }
  return { argv: out };
};
