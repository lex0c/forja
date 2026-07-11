// Render an operator-facing `forja …` command that is safe to copy-paste,
// preserving the active `--profile`.
//
// Any suggestion / remediation string that tells the operator to run a `forja`
// command MUST build it through here. The reason: the verbs those strings name
// (purge, permission verify/rotate-chain/seal-now/inspect, …) resolve their
// target namespace from `FORJA_PROFILE` at runtime. Under `forja --profile dev`
// a diagnostic runs against the PROFILED state, but a bare `forja permission
// verify` suggestion would resolve the CANONICAL namespace — so copy-pasting it
// targets the operator's real state (and, for mutating verbs, mutates it) from
// a profiled context. Re-prefixing `--profile <name>` keeps the suggested
// command pointed at the same namespace the diagnostic actually used.
//
// `rest` is the command MINUS the leading `forja ` (e.g. `'permission verify'`,
// `'purge --force'`). No profile ⇒ `forja <rest>`, byte-identical to a bare
// string, so default-namespace output is unchanged. Empty `rest` yields the
// bare launch command (`forja` / `forja --profile <name>`) with no trailing
// space — used by the `init` "run '<cmd>' to start" follow-up.

import { activeProfile } from '../config/app-namespace.ts';

export const forjaCommand = (rest: string, env: NodeJS.ProcessEnv = process.env): string => {
  const profile = activeProfile(env);
  const base = profile === null ? 'forja' : `forja --profile ${profile}`;
  return rest.length > 0 ? `${base} ${rest}` : base;
};
