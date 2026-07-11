// Output-schema instruction block for playbook subagents
// (`PLAYBOOKS.md` §1.2). Composes a trailing system-prompt
// section that tells the child to terminate with YAML matching
// the declared schema. The runtime then validates the terminal
// text post-hoc (see `src/subagents/output-schema.ts`); this
// module owns only the prompt-side surface.
//
// The block sits at the end of the system prompt — after the
// playbook body and the reference block (slice 7) — because it
// describes the FINAL action the model must take. Putting it
// last keeps the output instruction proximate to the moment the
// model decides to terminate, which empirically beats burying
// the instruction in the middle of a long prompt.

import { stringify as stringifyYaml } from 'yaml';

// Markdown header. Pinned at one literal so tests assert against
// a stable surface and a future renderer change lands here.
export const OUTPUT_SCHEMA_BLOCK_HEADER = '## Output schema';

// Render a schema as a YAML code fence. JSON Schema input gets
// rendered as YAML too — both dialects survive `stringify`,
// which is more readable for the model than serialized JSON. A
// schema that fails serialization (cycles, exotic types) falls
// back to a JSON.stringify; the block is best-effort and the
// model parses what it sees.
const renderSchema = (schema: Record<string, unknown>): string => {
  try {
    return stringifyYaml(schema, { indent: 2 });
  } catch {
    return JSON.stringify(schema, null, 2);
  }
};

const PREAMBLE =
  'Your final assistant turn MUST be a YAML mapping that matches the schema below. Wrap it in a ```yaml code fence (or emit it bare). The runtime parses your terminal text and validates against this schema; a mismatch buys exactly ONE retry pass with a diagnostic, then the run fails with `playbook.output_invalid`.';

// Build the trailing block. Returns null when there is nothing
// to render (no schema declared, or schema is malformed). Caller
// (the child path) treats null as "no schema enforcement",
// preserving the legacy free-form output behavior.
export const buildOutputSchemaBlock = (schema: unknown): string | null => {
  if (schema === null || schema === undefined) return null;
  if (typeof schema !== 'object' || Array.isArray(schema)) return null;
  const map = schema as Record<string, unknown>;
  if (Object.keys(map).length === 0) return null;
  const yaml = renderSchema(map);
  return `${OUTPUT_SCHEMA_BLOCK_HEADER}\n\n${PREAMBLE}\n\n\`\`\`yaml\n${yaml}\`\`\``;
};

// Append the schema block to a downstream prompt. Suffix
// composition mirrors `composeWithReferenceBlock` (slice 7) — the
// model reads the body first, then refs, then the final
// "what to emit" instruction.
//
// Empty schema / undefined / non-object → returns downstream
// untouched. Caller doesn't need to branch on schema presence.
export const composeWithOutputSchemaBlock = (
  downstream: string | undefined,
  schema: unknown,
): string | undefined => {
  const block = buildOutputSchemaBlock(schema);
  if (block === null) return downstream;
  if (downstream === undefined || downstream.length === 0) return block;
  return `${downstream}\n\n---\n\n${block}`;
};
