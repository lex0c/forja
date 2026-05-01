// Helpers shared between the full-scan pipeline (pipeline.ts)
// and the incremental update path (incremental.ts). Lives here
// rather than in a top-level utils module because the callers
// are siblings and the surface is intentionally tiny.

// Schema version persisted on every file row. Must match the
// latest migration's id (slice 4.3.0 ships migration 1). When a
// migration bumps the schema in a way that invalidates parser
// output (new field, kind expansion), files indexed under the
// older value are rebuilt by `agent code-index rebuild`.
//
// Kept in ONE place so the full-scan and incremental paths can't
// drift out of sync — re-indexing via PostToolUse must stamp the
// same version a full scan would.
export const CURRENT_SCHEMA_VERSION = 1;

// Hash a string with SHA-256 via Bun's CryptoHasher. Hex is
// 64 chars — slightly bigger than base64's 44, but
// case-insensitive and JSON-safe by default.
export const sha256Hex = (text: string): string => {
  const h = new Bun.CryptoHasher('sha256');
  h.update(text);
  return h.digest('hex');
};

// Count logical lines. Convention matches `wc -l`-style "files
// ending in newline have N lines" — a trailing newline closes
// the last line, it doesn't open a new empty one. Examples:
//   ''            → 0
//   'foo'         → 1   (no newline; final line has no terminator)
//   'foo\n'       → 1   (one closed line)
//   'foo\nbar'    → 2
//   'foo\nbar\n'  → 2
export const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
};
