// Single source for the on-disk app-namespace segment, profile-aware.
//
// `FORJA_PROFILE` (env) — or `--profile <name>`, which the CLI sets into
// `process.env.FORJA_PROFILE` early — selects an ISOLATED namespace so a dev
// build can't migrate or pollute the operator's real state. No profile ⇒ the
// canonical `forja` / `.forja`, byte-identical to pre-profile behavior.
//
// Two segments because Forja's USER and PROJECT state live at two levels:
//   - user-level: `~/.config/<app>`, `~/.local/share/<app>`, `~/.cache/<app>`
//     (sessions.db, audit.db, install_id, config, memory, trust, cache)
//   - project:    `<cwd>/<dotApp>` (permissions.yaml, playbooks, skills, …)
// A profile relocates BOTH, so `forja --profile dev` is fully sandboxed.
//
// NOT relocated: the ENTERPRISE layer (`/etc/forja`, `%PROGRAMDATA%\forja`).
// That is the admin-installed machine guardrail (locked policy + hooks) at a
// fixed location — profiling it would let `--profile <x>` skip the enterprise
// layer entirely (a bypass). `enterpriseAgentPath` in config/agent-paths.ts
// stays canonical on purpose; do NOT route it through these helpers.
//
// The profile name becomes a filesystem path segment, so it is allowlisted to
// `[a-z0-9][a-z0-9-]*` (checked char-by-char, no regex — this feeds path
// construction and the project bans regex on security-adjacent surfaces). That
// rejects `/`, `..`, leading hyphen, control bytes, and the empty string,
// closing the path-traversal window for an operator-influenced value.

export const isValidProfile = (s: string): boolean => {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    const lower = c >= 'a' && c <= 'z';
    const digit = c >= '0' && c <= '9';
    const hyphen = c === '-' && i > 0; // never leading
    if (!(lower || digit || hyphen)) return false;
  }
  return true;
};

// Resolve the active profile, or null when none is set. Throws on a malformed
// value rather than silently falling back — a typo'd profile that resolved to
// the real namespace would defeat the isolation the operator asked for.
const resolveProfile = (env: NodeJS.ProcessEnv): string | null => {
  const raw = env.FORJA_PROFILE;
  if (raw === undefined || raw.length === 0) return null;
  if (!isValidProfile(raw)) {
    throw new Error(
      `invalid FORJA_PROFILE '${raw}': profile must be lowercase alphanumeric + hyphen (matching [a-z0-9][a-z0-9-]*) — it becomes an on-disk path segment`,
    );
  }
  return raw;
};

// User-level config/data/cache dir segment: `forja` or `forja-<profile>`.
export const appDirName = (env: NodeJS.ProcessEnv = process.env): string => {
  const profile = resolveProfile(env);
  return profile === null ? 'forja' : `forja-${profile}`;
};

// Per-project dir segment: `.forja` or `.forja-<profile>`.
export const projectDirName = (env: NodeJS.ProcessEnv = process.env): string => {
  const profile = resolveProfile(env);
  return profile === null ? '.forja' : `.forja-${profile}`;
};

// The active profile name, or null. Exposed for diagnostics (`forja doctor`)
// and the banner indicator — NOT for path construction (use the two helpers).
export const activeProfile = (env: NodeJS.ProcessEnv = process.env): string | null =>
  resolveProfile(env);

// Every user-level app dir segment a session must defend, most specific last.
// Always includes the canonical `forja`; under a profile it ALSO includes
// `forja-<profile>`. The security lists (protected-paths escalate-on-write,
// sandbox hide-paths) build their `.config/<seg>` + `.local/share/<seg>`
// entries from this so a dev session's sandbox hides BOTH the dev install's
// own state AND the operator's real `forja` state — neither leaks into the
// other. No profile ⇒ `['forja']`, byte-identical to pre-profile behavior.
export const appDirNames = (env: NodeJS.ProcessEnv = process.env): readonly string[] => {
  const profile = resolveProfile(env);
  return profile === null ? ['forja'] : ['forja', `forja-${profile}`];
};

// Project-segment analog of `appDirNames`: every per-project dir a session must
// defend. Always includes the canonical `.forja`; under a profile it ALSO
// includes `.forja-<profile>`. The protected-paths cwd escalate-on-write list
// builds from this so a profiled run STILL escalates writes to the operator's
// real `.forja/` (sessions, policy, traces) — a profile must not become a way
// to silently edit the canonical project state — while also escalating its own
// `.forja-<profile>/`. No profile ⇒ `['.forja']`, byte-identical to before.
export const projectDirNames = (env: NodeJS.ProcessEnv = process.env): readonly string[] => {
  const profile = resolveProfile(env);
  return profile === null ? ['.forja'] : ['.forja', `.forja-${profile}`];
};

// Per-project dir(s) that belong to a DIFFERENT namespace than the active
// session and must be FULLY isolated at the read floor — masked from the
// sandbox AND read-denied by the permission engine. Under a profile that's the
// operator's REAL canonical `.forja/` (project memory/config/traces): a
// profiled session must neither read nor write it. Empty on the default
// namespace — the canonical `.forja/` IS the active session's, and other
// `.forja-<x>/` profile dirs are themselves throwaway state, not the real
// project, so they're out of scope (enumerating them would also need a cwd
// scan). The active session's OWN dir (`projectDirName()`) is never here, so
// it stays readable/writable.
export const foreignProjectDirNames = (env: NodeJS.ProcessEnv = process.env): readonly string[] => {
  const profile = resolveProfile(env);
  return profile === null ? [] : ['.forja'];
};
