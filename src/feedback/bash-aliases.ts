// Known L1 alias adaptations for bash commands.
//
// The loop frio (3.4) needs `alias:<from>:<to>` outcomes to track —
// success/failure tallies that, with enough N, justify promoting a
// policy that swaps `from` for `to` at dispatch time. But the LOOP
// quente (3.2 outcome emitter) only emits `flag:bash:default:default`
// for every bash call; there's no L1 producer.
//
// This table fixes that. The bash parser (`bash-parser.ts`) detects
// the leading binary of a bash command and emits an `alias:<from>:<to>`
// outcome alongside the generic `flag:bash:default:default` one. The
// adaptation direction (`from` → `to`) is OPINIONATED — Forja's
// curators picked binaries where the alternative is broadly known to
// be a drop-in OR a flag-compatible superset:
//
//   - grep → ripgrep: rg is faster + flag-compatible with the
//     90% of grep usage (the regex dialect differs marginally;
//     PCRE-mode flag covers the rest)
//   - find → fd: fd is faster + ergonomics; flag set differs more
//     than grep/rg (path-only filter vs find's broader test
//     vocabulary), so commands using exotic find flags will
//     diverge in success rate
//   - sed → sed (self-alias): no broadly-recommended alternative;
//     listed to capture per-tool tally without proposing change
//   - awk → awk: same as sed
//
// SEMANTIC: an outcome `alias:grep:ripgrep` with `result=success`
// means "the bash command using grep terminated cleanly". The
// success/failure ratio tracks how grep performs IN THIS SCOPE; if
// it's consistently >70% over n≥10, the loop frio proposes "alias
// grep to ripgrep" (rg supports the same flags 90% of the time;
// the promotion gate's ci_low > 0.7 is the bet that this command
// pattern is in that 90%). Operator promotes; future dispatch
// rewrites grep→rg. If the rewrite then FAILS in this scope
// (rg-unsupported flags in the operator's workflow), the policy
// gets invalidated and reverts.
//
// Self-aliases (sed:sed, awk:awk) are included so we have per-bin
// telemetry without proposing change. Loop frio's L1 proposer
// builds `actionJson = {target: 'sed'}` for these — operator would
// see a "promote alias:sed:sed → use sed" proposal which is a
// no-op rewrite. We rely on the duplicate-guard + the fact that
// self-alias proposals would land as `proposed` not `active`; the
// operator never promotes them. Future slice can filter self-
// aliases out of proposer surface entirely.
//
// Table is CONFIG-SHAPED but hardcoded today. Future slice loads
// from TOML (per-repo override, operator-curated additions).

export interface BashAlias {
  from: string;
  to: string;
}

const KNOWN_BASH_ALIASES: readonly BashAlias[] = [
  { from: 'grep', to: 'ripgrep' },
  { from: 'find', to: 'fd' },
  { from: 'cat', to: 'cat' },
  { from: 'awk', to: 'awk' },
  { from: 'sed', to: 'sed' },
];

// Lookup table indexed by `from` for O(1) detection.
const ALIAS_INDEX: Map<string, BashAlias> = new Map(KNOWN_BASH_ALIASES.map((a) => [a.from, a]));

// Look up the L1 alias adaptation for a binary name. Returns null
// when the binary isn't in the curated table (most binaries — we
// don't generate outcomes for every bash invocation).
export const lookupBashAlias = (binary: string): BashAlias | null => {
  return ALIAS_INDEX.get(binary) ?? null;
};

export { KNOWN_BASH_ALIASES };
