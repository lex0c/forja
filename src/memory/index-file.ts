import type { IndexEntry } from './types.ts';

// MEMORY.md (per-scope index) parser/writer.
//
// Spec §3.2: "Uma linha por memória, < 150 caracteres", "Não tem
// frontmatter próprio", "Truncado em 200 linhas — força disciplina".
//
// Format of a single entry line:
//
//   - [<title>](<href>) — <hook>
//
// We accept either an em-dash (—, U+2014) or a plain ` - ` (space
// hyphen space) as the separator between the link and the hook —
// operators editing by hand on a US keyboard don't always have
// the em-dash at fingertips. The writer always emits the em-dash
// to keep the repo canonical.
//
// Lines that don't match the entry shape are dropped on parse and
// not preserved on round-trip. The index is canonical state
// owned by the agent; operator-edited prose belongs in
// individual memory bodies, not the index.
//
// SECURITY CONTRACT — IMPORTANT:
//
// Index entries are USER-EDITABLE state (especially the shared
// scope, which is git-tracked and reachable via PR). The `href`
// field is NOT validated by the parser — it accepts any non-paren
// content. A malicious or hand-mangled MEMORY.md could contain
// `[Title](../../../etc/passwd)` and it would parse cleanly.
//
// Therefore: callers MUST NOT compute filesystem paths by joining
// the scope root with `entry.href`. The authoritative way to
// resolve a memory's path is `memoryFilePath(roots, scope, name)`
// from `./paths.ts`, which validates the name through
// `validateName` and re-applies the sandbox check. The 5.2
// lazy-loader keeps an in-memory map from `name` to scope and
// resolves through that map; the index href is treated as a UI
// hint only.
//
// Future hardening (5.4 / 5.5): when the writer regenerates the
// index, it always emits `href = "${name}.md"` derived from the
// validated frontmatter name, so re-saved indexes drift toward
// canonical hrefs. Operator-injected hrefs survive only until the
// next agent-driven write of the affected entry.

export class IndexError extends Error {
  override readonly name = 'IndexError';
}

const INDEX_LINE_HARD_MAX = 200;

// Per-line max from spec §3.2 ("< 150 caracteres"). Enforced as a
// soft warning at write time: the writer returns the offending
// indices but does not throw, since the index is mutated by the
// runtime under load and a single oversized entry should not
// fail a write.
export const INDEX_LINE_SOFT_MAX = 150;

// Match the canonical entry shape. We capture title, href, and
// hook. The separator allows the em-dash variant (`—`, optionally
// padded) and the ascii fallback (` - `). The link and hook
// captures are non-greedy through the well-defined bracket and
// paren delimiters; the hook is whatever remains on the line
// (trimmed by the consumer).
//
// We deliberately do NOT support nested brackets or parens in the
// title or href — kebab-case names + plain English titles cover
// 100% of real-world cases; supporting embedded delimiters would
// require a stateful parser for negligible gain.
const ENTRY_RE = /^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)\s*(.*)$/;

export interface ParsedIndex {
  entries: IndexEntry[];
  // Indices (1-based, matching the source) of lines that the
  // parser dropped because they didn't match the canonical entry
  // shape. Tests + the gc/audit slice use this to surface broken
  // index lines instead of silently losing them.
  malformedLines: number[];
}

export const parseIndex = (raw: string): ParsedIndex => {
  // Normalize CRLF and strip a single trailing newline so a
  // canonical writer's output round-trips cleanly through parse.
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  // Drop a trailing empty element produced by a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const entries: IndexEntry[] = [];
  const malformedLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    // Skip blank lines and the conventional `# Index` heading some
    // operators may add. Anything starting with `#` or `>` is
    // treated as prose and ignored.
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
    if (!trimmed.startsWith('- ')) {
      malformedLines.push(i + 1);
      continue;
    }
    const match = ENTRY_RE.exec(trimmed);
    if (match === null) {
      malformedLines.push(i + 1);
      continue;
    }
    const [, title, href, hook] = match;
    if (title === undefined || href === undefined || hook === undefined) {
      malformedLines.push(i + 1);
      continue;
    }
    entries.push({ title: title.trim(), href: href.trim(), hook: hook.trim() });
  }
  return { entries, malformedLines };
};

export interface SerializeIndexResult {
  text: string;
  // Indices (0-based into the input `entries` array) of entries
  // whose serialized line exceeded INDEX_LINE_SOFT_MAX. Caller
  // logs a warning; the entry is still emitted.
  oversizedEntries: number[];
}

const formatEntry = (entry: IndexEntry): string =>
  `- [${entry.title}](${entry.href}) — ${entry.hook}`;

// Serialize entries to a canonical MEMORY.md body. Caller decides
// whether to include the boilerplate header — pass `header` to
// prepend an arbitrary string (which can itself contain
// newlines). The serializer inserts exactly one blank line
// between header and the first entry when both are non-empty.
//
// Throws IndexError if the resulting file would exceed the hard
// 200-line cap (spec §3.2). The writer cannot truncate
// automatically — picking which entries to drop is policy that
// belongs in 5.2's eviction logic, not the storage primitive.
export const serializeIndex = (
  entries: readonly IndexEntry[],
  opts: { header?: string } = {},
): SerializeIndexResult => {
  const oversizedEntries: number[] = [];
  const lines: string[] = [];
  if (opts.header !== undefined && opts.header.length > 0) {
    lines.push(opts.header.trimEnd());
    lines.push('');
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const line = formatEntry(entry);
    if (line.length > INDEX_LINE_SOFT_MAX) oversizedEntries.push(i);
    lines.push(line);
  }
  // Total line count includes the trailing newline produced by
  // joining + adding one final newline; the cap counts content
  // lines, not bytes.
  if (lines.length > INDEX_LINE_HARD_MAX) {
    throw new IndexError(
      `MEMORY.md exceeds hard cap of ${INDEX_LINE_HARD_MAX} lines (got ${lines.length}); evict before writing`,
    );
  }
  return {
    text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    oversizedEntries,
  };
};

// Replace an entry by `href` (idempotent upsert). If no entry
// with that href exists, append. Returns a new array; the input
// is not mutated.
export const upsertIndexEntry = (
  entries: readonly IndexEntry[],
  entry: IndexEntry,
): IndexEntry[] => {
  const idx = entries.findIndex((e) => e.href === entry.href);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
};

// Remove an entry by `href`. Returns a new array; no-op when the
// href is absent. The repo layer logs a `deleted` audit event
// even on no-op so an operator-driven /memory delete that lost
// the index entry separately still leaves a trace.
export const removeIndexEntry = (entries: readonly IndexEntry[], href: string): IndexEntry[] =>
  entries.filter((e) => e.href !== href);
