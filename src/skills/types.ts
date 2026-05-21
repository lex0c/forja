// Shared types for the skills subsystem (spec SKILLS.md).
//
// A skill is a gated, reusable procedure: a markdown file with YAML
// frontmatter (`name` + `description` load-bearing) and a prose
// body the LLM follows. The catalog surfaces name + description
// eager; the body loads lazy on `skill_invoke` (spec §0.3, §4).

// The three concrete scopes for v1 (spec §3.1–3.3): user (global
// per machine), project_shared (committed, team-wide), project_local
// (gitignored, per-person). The `imported` scope (§3.4) is v2 — it
// ships together with the import flow + injection scanning, so the
// v1 scope union omits it deliberately: nothing can resolve, write,
// or audit an imported skill before that machinery exists.
export type SkillScope = 'user' | 'project_shared' | 'project_local';

// Declared provenance of a skill (frontmatter `source`, spec §2.1).
// Same four-value vocabulary as the scope axis PLUS `imported` —
// `source` is the authored-origin marker and may legally read
// `imported` on a hand-written file even though the `imported`
// SCOPE is v2. The catalog derives the live scope from the file's
// directory; `source` only ever travels inside the frontmatter.
export type SkillSource = 'user' | 'project_shared' | 'project_local' | 'imported';

// Parsed frontmatter block. `name` + `description` are the only
// required fields (spec §2.1: "Resto é opt-in com defaults sãos").
// Optional fields preserve absence on round-trip — an omitted
// `version` stays omitted, never coerced to a serialized default.
//
// Field names mirror the YAML keys verbatim (snake_case for the
// multi-word keys) so the parser/serializer is a direct mapping
// with no case-translation layer — the same shape the tool I/O
// interfaces elsewhere in the tree use.
export interface SkillFrontmatter {
  name: string;
  description: string;
  // Monotonic integer; a bump signals the body changed
  // semantically (spec §6.2). Audit/changelog metadata only — the
  // runtime never branches on it.
  version?: number;
  // Lexical pre-filter hints (spec §2.1, RETRIEVAL §3.4.3). Free-
  // form lowercase phrases — the seed catalog uses multi-word
  // entries like "test fails sometimes" — NOT kebab-case ids; they
  // are substring-matched against goal text.
  trigger_keywords?: string[];
  // Tools the skill's procedure uses (spec §8). Declarative: the
  // runtime pre-flights their existence before injecting the body
  // but grants no privilege — PERMISSION_ENGINE still gates.
  tools?: string[];
  // Other subsystems the skill's procedure depends on (spec §2.1).
  requires?: string[];
  source?: SkillSource;
  // Authoring dates, ISO `YYYY-MM-DD` (spec §2.1).
  created_at?: string;
  updated_at?: string;
  // ISO `YYYY-MM-DD` review deadline (spec §2.1, §6.4). v1 parses
  // and surfaces it; the 90-day decay sweep is v2.
  expires?: string;
}

// One skill file: frontmatter + raw markdown body. The body is
// everything after the closing `---` fence, with one leading blank
// line stripped — the canonical writer emits exactly one blank
// between fence and body, so the parser undoes it for a clean
// round-trip.
export interface SkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}
