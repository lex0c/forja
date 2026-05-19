// Template for `.agent/config.toml` written by `agent init`.
// Spec: AGENTIC_CLI.md §2.1.1.
//
// Posture: the scaffolded file is a slim spec-pointer, NOT inline
// documentation. The operator opens the file, sees where the schema
// lives, and edits from there. Rich per-toggle documentation lives
// in AGENTIC_CLI.md §2.1.1 (schema reference) — not in this string.
//
// Why slim? `/memory governance enable|disable` rewrites this file
// via TOML round-trip (parse → mutate → emit), and `Bun.TOML.parse`
// does not preserve comments. If we shipped a richly-commented
// scaffold, the first slash-command toggle would silently delete
// every line of inline documentation. The operator would lose
// discovery exactly when they first acted on the file. Slim
// scaffold avoids the false promise: the docs live in the spec
// where comments do not get rewritten by the toggle path.
//
// Adding values to this scaffold (e.g., as defaults for new
// installs) requires a PR against AGENTIC_CLI.md §2.1.1 first —
// the spec lists the literal scaffold AND the schema reference.

export const renderInitConfigTemplate =
  (): string => `# .agent/config.toml — Forja per-project config (safe to edit).
#
# Schema: AGENTIC_CLI.md §2.1.1.
# Resolution order: enterprise → user (~/.config/agent/config.toml) →
# project (this file) → session (CLI flag).
#
# This file is empty by design. Add a [memory] or [critique] section
# to override loader defaults for this project. See the spec for the
# full toggle list; defaults live in code (src/critique/config-loader.ts).
#
# Note: \`/memory governance enable|disable\` rewrites this file and
# normalizes formatting (comments NOT preserved). Hand-edits to
# inactive sections survive; comments do not. Keep notes in the
# spec or your team's docs, not inline here.
`;
