// `find_references` — locate every site where a symbol is
// used. Spec CODE_INDEX.md §5.2: returns the call/heritage/
// import sites pointing at a symbol, with ±2 lines of
// surrounding source for each so the model can read intent
// without a separate read_file. Canonical use case:
// "before changing the `login` API, who calls it?"
//
// Resolution shape:
//   - `symbol` accepts a bare name OR an FQN (`<file>:foo`,
//     `<file>:Class.method`). FQN form is exact; bare name
//     queries the symbols table by name and surfaces
//     `symbol.ambiguous` when more than one file matches
//     (operator passes `file` to disambiguate).
//   - When the symbol resolves to a unique row, find
//     references both by symbol id (resolved bindings) and by
//     name (unresolved-but-name-matching). Merge + dedupe by
//     (file, line, col).
//   - `ref_kind` filters to a single category. The tool
//     surfaces ALL kinds by default — call, type, import,
//     extends, implements — so the operator gets a complete
//     picture.
//
// Cap of 100 references per call (spec §5.2). A larger result
// set surfaces `truncated: true` and the operator narrows via
// `file:` or `ref_kind:`.
//
// Self-gates against the resolved file's `fs.read` policy,
// matching the read_symbol pattern: misc category bypasses
// the harness pre-call gate (no path arg available); the
// per-result-file path is checked before the surrounding-text
// read.

import { isAbsolute, relative, resolve } from 'node:path';
import type { IndexSymbol, Reference, ReferenceKind } from '../../code-index/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface FindReferencesInput {
  symbol: string;
  file?: string;
  ref_kind?: ReferenceKind;
}

export interface FindReferenceHit {
  file: string;
  line: number;
  col: number;
  kind: ReferenceKind;
  // ±2 lines around the reference, joined with newlines. Empty
  // when surrounding text couldn't be loaded (file unreadable
  // — stale index — OR fs.read policy denied access). The
  // `text_unavailable` field below tells the caller WHY.
  surrounding_text: string;
  // Reason `surrounding_text` is empty. Omitted when the text
  // was loaded successfully.
  text_unavailable?: 'permission_denied' | 'file_missing';
}

export interface FindReferencesOutput {
  references: FindReferenceHit[];
  truncated: boolean;
}

const MAX_REFERENCES = 100;
const SURROUNDING_LINES = 2;

const VALID_REF_KINDS: ReadonlySet<string> = new Set([
  'call',
  'type',
  'import',
  'extends',
  'implements',
]);

const buildSurroundingText = (fullSource: string, line: number): string => {
  const lines = fullSource.split('\n');
  const start = Math.max(0, line - SURROUNDING_LINES);
  const end = Math.min(lines.length, line + SURROUNDING_LINES + 1);
  return lines.slice(start, end).join('\n');
};

// Merge resolved + name-matched references, deduping by
// (file, line, col). Resolved entries win on conflict so
// `targetSymbolId` info isn't lost. Returns a stable order
// suitable for slicing.
const mergeAndDedupe = (resolved: Reference[], byName: Reference[]): Reference[] => {
  const seen = new Map<string, Reference>();
  for (const r of resolved) {
    seen.set(`${r.sourceFile}:${r.sourceLine}:${r.sourceCol}`, r);
  }
  for (const r of byName) {
    const key = `${r.sourceFile}:${r.sourceLine}:${r.sourceCol}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
    if (a.sourceLine !== b.sourceLine) return a.sourceLine - b.sourceLine;
    return a.sourceCol - b.sourceCol;
  });
};

export const findReferencesTool: Tool<FindReferencesInput, FindReferencesOutput> = {
  name: 'find_references',
  description:
    "Find every site where a symbol is used. Currently captures calls, class extends, and class/interface implements; type annotations like `function f(): User` are NOT yet captured (roadmap). `symbol` accepts a bare name or FQN (`src/auth.ts:login`, `src/auth.ts:Auth.login`). Returns up to 100 references with ±2 lines of surrounding source; pass `ref_kind` to filter. Hits in fs.read-denied files appear with `text_unavailable: 'permission_denied'` so the model isn't blind to their existence.",
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol name or fully-qualified name.' },
      file: {
        type: 'string',
        description:
          'Project-relative file path used to disambiguate when `symbol` is a bare name appearing in multiple files.',
      },
      ref_kind: {
        type: 'string',
        enum: ['call', 'type', 'import', 'extends', 'implements'],
        description: 'Filter results to one reference category. Default: all kinds.',
      },
    },
    required: ['symbol'],
  },
  metadata: {
    // misc + self-gate per file. Same rationale as read_symbol:
    // the resolved file paths come from the index, not from
    // an `args.path` field, so the engine's fs.read pre-gate
    // can't validate them upfront.
    category: 'misc',
    writes: false,
    idempotent: true,
    display: 'list',
    cost: { latency_ms_typical: 20 },
  },
  async execute(args, ctx): Promise<ToolResult<FindReferencesOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before lookup', { retryable: true });
    }
    if (typeof args.symbol !== 'string' || args.symbol.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'symbol must be a non-empty string');
    }
    if (args.file !== undefined && typeof args.file !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'file must be a string when provided');
    }
    if (args.ref_kind !== undefined && !VALID_REF_KINDS.has(args.ref_kind)) {
      return toolError(
        ERROR_CODES.invalidArg,
        `ref_kind must be one of: ${[...VALID_REF_KINDS].join(', ')}`,
      );
    }
    if (ctx.codeIndex === undefined) {
      return toolError(
        ERROR_CODES.indexUnavailable,
        'code index unavailable — run `agent --code-index scan` and retry',
        { retryable: false },
      );
    }

    // Normalize absolute file filter to project-relative.
    let fileFilter = args.file;
    if (fileFilter !== undefined && isAbsolute(fileFilter)) {
      const rel = relative(ctx.codeIndex.projectRoot, resolve(fileFilter));
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        fileFilter = rel.replaceAll('\\', '/');
      }
    }

    // FQN-first lookup, then name fallback. Matches read_symbol.
    let candidates: IndexSymbol[] = [];
    const looksLikeFqn = args.symbol.includes(':');
    if (looksLikeFqn) {
      candidates = ctx.codeIndex.getSymbolByFqn(args.symbol);
    }
    if (candidates.length === 0) {
      candidates = ctx.codeIndex.getSymbol(
        args.symbol,
        fileFilter !== undefined ? { file: fileFilter } : {},
      );
    }

    if (candidates.length === 0) {
      return toolError(ERROR_CODES.symbolNotFound, `symbol not found: ${args.symbol}`, {
        retryable: false,
      });
    }
    if (candidates.length > 1) {
      return toolError(
        ERROR_CODES.symbolAmbiguous,
        `symbol '${args.symbol}' is ambiguous — pass \`file\` (or use an FQN)`,
        {
          retryable: false,
          details: {
            candidates: candidates.map((c) => ({
              file: c.filePath,
              kind: c.kind,
              line: c.startLine + 1,
            })),
          },
        },
      );
    }

    const sym = candidates[0];
    if (sym === undefined) {
      return toolError(ERROR_CODES.symbolNotFound, 'unexpected: empty match');
    }

    // Both query paths: resolved (target_symbol_id = ?) and
    // unresolved-by-name (target_symbol_name = ?, id null).
    // Merge + dedupe so a reference that's both resolved AND
    // name-matched (most cases) appears once.
    const resolved = ctx.codeIndex.findReferences(sym.id);
    const byName = ctx.codeIndex.findReferencesByName(sym.name);
    let merged = mergeAndDedupe(resolved, byName);

    if (args.ref_kind !== undefined) {
      merged = merged.filter((r) => r.refKind === args.ref_kind);
    }

    const truncated = merged.length > MAX_REFERENCES;
    if (truncated) merged = merged.slice(0, MAX_REFERENCES);

    // Per-file source cache so we don't re-read a hot file
    // (e.g., a file with 10 references to the same symbol).
    // null = denied or unreadable; undefined = not yet probed.
    const sourceCache = new Map<string, string | { error: 'permission_denied' | 'file_missing' }>();
    const projectRoot = ctx.codeIndex.projectRoot;
    const hits: FindReferenceHit[] = [];
    for (const r of merged) {
      const absPath = resolve(projectRoot, r.sourceFile);
      let cached = sourceCache.get(r.sourceFile);
      if (cached === undefined) {
        // First time we see this file. Decide gate, then read
        // (or skip read if denied). Cache the outcome so other
        // refs in the same file reuse it.
        const decision = ctx.permissionCheck('read_file', 'fs.read', { path: absPath });
        if (decision.kind !== 'allow') {
          cached = { error: 'permission_denied' };
        } else {
          const file = Bun.file(absPath);
          if (!(await file.exists())) {
            cached = { error: 'file_missing' };
          } else {
            try {
              cached = await file.text();
            } catch {
              cached = { error: 'file_missing' };
            }
          }
        }
        sourceCache.set(r.sourceFile, cached);
      }

      // Always emit the hit — the model needs to know the ref
      // exists even when surrounding text is unavailable.
      // Suppressing the hit silently misled refactor decisions
      // ("only 3 callers" when actually 8, 5 in denied files).
      const baseHit = {
        file: r.sourceFile,
        line: r.sourceLine + 1, // 1-indexed display
        col: r.sourceCol + 1,
        kind: r.refKind,
      };
      if (typeof cached === 'string') {
        hits.push({
          ...baseHit,
          surrounding_text: buildSurroundingText(cached, r.sourceLine),
        });
      } else {
        hits.push({
          ...baseHit,
          surrounding_text: '',
          text_unavailable: cached.error,
        });
      }
    }

    return { references: hits, truncated };
  },
};
