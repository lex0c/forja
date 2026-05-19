// Template for `.agent/config.toml` written by `agent init`.
// Spec: AGENTIC_CLI.md §2.1.1.
//
// Posture: every key is commented out. The scaffolded file is a no-op
// until the operator uncomments a value. Real defaults live in loader
// code (currently `src/critique/config-loader.ts`); the template is
// documentation that becomes config when edited.
//
// Why scaffold a file that does nothing on its own?
//
//   1. Discovery — the operator opens `.agent/config.toml` and sees
//      every available toggle with a short explanation, instead of
//      grepping the source to learn the schema.
//   2. Tracked surface — the file lives in version control, so
//      enabling a toggle for the team becomes a diffable PR rather
//      than a configuration ritual whispered over Slack.
//
// Schema-creep in this template is acceptable (cost: token bloat in
// the operator's editor). Schema-creep in the loader's default
// behavior requires a PR against `AGENTIC_CLI.md §2.1.1` first.

export const renderInitConfigTemplate =
  (): string => `# .agent/config.toml — Forja per-project config (auto-scaffolded; safe to edit).
#
# Spec: AGENTIC_CLI.md §2.1.1 (this schema) + §8 (hierarchy).
# Resolution order: enterprise → user (~/.config/agent/config.toml) →
# project (this file) → session (CLI flag).
#
# All keys below are commented out. Defaults live in code; this file
# is documentation. Uncomment a key to override that default for
# this project.

# [memory] — three LLM-judge governance detectors, all default ON.
# Uncommenting a key DISABLES the corresponding detector for this
# project. Disabling does NOT delete past events or proposals; it
# only stops the scheduler from dispatching new ones.
#
# [memory]
# verify_semantic_llm = false   # S11: post-write semantic verification
# conflict_detect_llm = false   # S13: cross-memory conflict detection
# override_detect_llm = false   # S3: repeated-override threshold detector

# [critique] — write-time self-critique. Default mode = off.
# Uncommenting the block below ACTIVATES critique with the example
# values shown. 'on_writes' fires only on edits; 'always' fires on
# every assistant turn. Model + prompt_version below are illustrative;
# check src/critique/config-loader.ts for the current canonical
# defaults before adopting verbatim.
#
# [critique]
# mode = "on_writes"            # off | on_writes | always
# threshold = 0.65              # 0..1; severity threshold to surface
# model = "anthropic/claude-haiku-4-5"
# prompt_version = "v1"
`;
