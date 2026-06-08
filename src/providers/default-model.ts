// Single canonical home for the default executor model id. Lives in
// a tiny dependency-free file so the `agent init` path can import
// without pulling in `bootstrap.ts` (which transitively loads
// storage, providers, hooks, telemetry) just to write a scaffold.
//
// Updating this string is a deliberate per-release operation — bumps
// flow through to (a) the harness's hardcoded fallback when no CLI
// flag / [providers].model overrides, and (b) the scaffolded
// `.agent/config.toml` for fresh `forja init` invocations. Existing
// operators with a scaffolded config.toml keep their pinned value
// until they re-run `agent init --force=config`.

export const DEFAULT_MODEL = 'anthropic/claude-opus-4-8';
