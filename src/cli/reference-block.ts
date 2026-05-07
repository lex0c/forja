// Reference-block compositor for playbook subagents
// (`PLAYBOOKS.md` §1.1). The playbook author declares
// `references: [path1, path2, ...]` in frontmatter; the child
// appends a trailing block to its system prompt listing those
// paths. The model reads them lazily via the `read_file` tool —
// the harness does NOT load the documents eagerly. This is a
// pointer surface, not a context surface (token-bloat anti-
// pattern, `PLAYBOOKS.md` §13).
//
// Composition direction: the block goes AFTER the playbook body
// (suffix), not before. Reasoning:
//   - The playbook body is the role + constraints — what the
//     child does.
//   - The reference list is metadata about resources — what the
//     child may consult.
//   - A reader (model included) parses role first, then asks
//     "what tools / docs do I have?". Suffix matches that
//     reading order.
//
// Both `composeWithParallelHint` (slice 2) and the playbook body
// have already been resolved by the caller; this function only
// appends. Empty / null / absent reference lists collapse to a
// passthrough returning the prompt verbatim.

// Markdown header for the reference block. Pinned at one literal
// site so tests assert against a stable surface, and a future
// renderer change (e.g., a different heading depth) lands here.
export const REFERENCE_BLOCK_HEADER = '## References (read on demand)';

const PREAMBLE =
  'The following documents are available for consultation. Read them with `read_file` when relevant — do not embed eagerly.';

// Build the trailing block. Returns null when there is nothing to
// render (empty list, undefined). Caller decides how to attach
// the result; `composeWithReferenceBlock` is the convenience.
export const buildReferenceBlock = (
  refs: ReadonlyArray<string> | null | undefined,
): string | null => {
  if (refs === undefined || refs === null) return null;
  if (refs.length === 0) return null;
  // Bullet list keeps the surface compact and grep-able. We
  // intentionally do NOT escape `_` / `*` inside the path —
  // identifiers are filenames, not markdown that needs sanitizing,
  // and a path that legitimately contains `*` would only ever
  // appear if an author got creative with frontmatter quoting.
  // Keeping the path verbatim preserves the audit-shape: what
  // the .md said is what the model reads.
  const bullets = refs.map((p) => `- ${p}`).join('\n');
  return `${REFERENCE_BLOCK_HEADER}\n\n${PREAMBLE}\n\n${bullets}`;
};

// Append the reference block to a downstream prompt. Mirror of
// `composeWithParallelHint` but in the OPPOSITE direction (this
// one is a suffix, not a prefix). When there is no block to
// render, the downstream is returned unchanged (or undefined when
// caller passed undefined / empty).
//
// Separator: a `\n\n---\n\n` boundary between the playbook body
// and the reference block — same convention the parallel hint
// uses to fence sections, so the model sees a uniform structure
// regardless of which side prepended/appended.
export const composeWithReferenceBlock = (
  downstream: string | undefined,
  refs: ReadonlyArray<string> | null | undefined,
): string | undefined => {
  const block = buildReferenceBlock(refs);
  if (block === null) return downstream;
  if (downstream === undefined || downstream.length === 0) return block;
  return `${downstream}\n\n---\n\n${block}`;
};
