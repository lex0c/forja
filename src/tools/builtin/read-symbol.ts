// `read_symbol` — symbolic alternative to `read_file`. Spec
// CODE_INDEX.md §5.1: takes a symbol name (or FQN) plus an
// optional file disambiguator and returns just the symbol's
// source slice (function/class/method body) instead of the
// whole file. Typical token cost is 5-20× smaller than
// `read_file` — that's the win this tool exists for.
//
// Failure modes:
//   - index.unavailable: ToolContext didn't carry a CodeIndex
//     (harness didn't initialize, or DB open failed)
//   - symbol.not_found: name doesn't resolve to anything in the
//     index. Returnable for "did the model misspell?" or "the
//     index is stale and needs rebuild?".
//   - symbol.ambiguous: name resolves to >1 file. The tool
//     surfaces the candidate file paths; the model retries
//     with `file:` to disambiguate.
//   - permission.denied: fs.read policy denies the resolved
//     file (we self-gate AFTER the index lookup; see category
//     note below).
//
// Category note: `misc` instead of `fs.read` because the actual
// file the tool reads is resolved from the index, not from any
// model-supplied `path` argument. The fs.read engine gate
// expects `args.path` and would deny `read_symbol` calls
// outright (no path → resolveFsTarget returns null → deny).
// Self-gating with `ctx.permissionCheck` against the resolved
// path matches the wait_for / monitor pattern documented on
// `ToolContext.permissionCheck`. Plan-mode safety is unchanged
// because `writes: false`.
//
// Doc extraction (`include_doc`) is OUT of scope v1
// (CODE_INDEX.md §1.2): the index doesn't store docstrings, so
// the tool would always return empty `doc`. Drop the field
// rather than ship it permanently empty.

import { isAbsolute, relative, resolve } from 'node:path';
import type { IndexSymbol } from '../../code-index/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ReadSymbolInput {
  symbol: string;
  // Disambiguator when `symbol` exists in multiple files. Path
  // is project-relative (matches the `files.path` PK) — the
  // tool also accepts absolute paths and converts them.
  file?: string;
}

export interface ReadSymbolOutput {
  symbol: {
    name: string;
    kind: string;
    fqn: string | null;
    file: string;
    line_range: { start: number; end: number };
  };
  source: string;
  signature: string | null;
}

const sliceSource = (fullSource: string, startLine: number, endLine: number): string => {
  // tree-sitter line numbers are 0-indexed; convert to 1-indexed
  // semantically for the output (matches how editors display
  // lines), but slice from 0-indexed for the array.
  const lines = fullSource.split('\n');
  // Clamp defensively — the file on disk may have changed since
  // the index was last refreshed.
  const start = Math.max(0, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine + 1, lines.length));
  return lines.slice(start, end).join('\n');
};

export const readSymbolTool: Tool<ReadSymbolInput, ReadSymbolOutput> = {
  name: 'read_symbol',
  description:
    'Read a single symbol (function/class/method/etc.) from the code index — typically 5-20× smaller token footprint than read_file. Pass `file` to disambiguate when the symbol name appears in multiple files.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Symbol name or fully-qualified name.' },
      file: {
        type: 'string',
        description:
          'Project-relative file path used to disambiguate when `symbol` appears in multiple files.',
      },
    },
    required: ['symbol'],
  },
  metadata: {
    // Misc + self-gate against the resolved file. The fs.read
    // engine gate requires `args.path`; this tool resolves the
    // path from the index after lookup (see header).
    category: 'misc',
    writes: false,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 10 },
  },
  async execute(args, ctx): Promise<ToolResult<ReadSymbolOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before lookup', { retryable: true });
    }
    if (typeof args.symbol !== 'string' || args.symbol.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'symbol must be a non-empty string');
    }
    if (args.file !== undefined && typeof args.file !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'file must be a string when provided');
    }
    if (ctx.codeIndex === undefined) {
      return toolError(
        ERROR_CODES.indexUnavailable,
        'code index unavailable — run `agent --code-index scan` and retry',
        { retryable: false },
      );
    }

    // Convert absolute file paths to project-relative when
    // possible (the index keys files by relative path).
    // path.relative + ".." rejection is more robust than a
    // string-prefix check (handles trailing slashes, separator
    // normalization, ".." escapes).
    let fileFilter = args.file;
    if (fileFilter !== undefined && isAbsolute(fileFilter)) {
      const rel = relative(ctx.codeIndex.projectRoot, resolve(fileFilter));
      // Out-of-tree paths can't match any row; leave the filter
      // as-is so getSymbol returns empty (→ symbol.not_found).
      // Up-tree (`..`) paths likewise don't match.
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        fileFilter = rel;
      }
    }

    let matches: IndexSymbol[] = ctx.codeIndex.getSymbol(
      args.symbol,
      fileFilter !== undefined ? { file: fileFilter } : {},
    );

    // TS function overloads emit one IndexSymbol per signature
    // (`function foo(x:A):A; function foo(x:B):B; function foo(x){...}`
    // produces 3 rows in the same file). Without a dedup, the
    // ambiguous branch fires even with `file:` set. Pick the
    // candidate with the largest line span (the implementation
    // body; signatures are 1-line declarations) when all
    // candidates share name + file + kind.
    if (matches.length > 1) {
      const sameFileKind = matches.every(
        (m) =>
          m.filePath === matches[0]?.filePath &&
          m.kind === matches[0]?.kind &&
          m.name === matches[0]?.name,
      );
      if (sameFileKind) {
        matches = [
          matches.reduce((largest, m) =>
            m.endLine - m.startLine > largest.endLine - largest.startLine ? m : largest,
          ),
        ];
      }
    }

    if (matches.length === 0) {
      return toolError(ERROR_CODES.symbolNotFound, `symbol not found: ${args.symbol}`, {
        retryable: false,
        ...(fileFilter !== undefined ? { details: { file: fileFilter } } : {}),
      });
    }
    if (matches.length > 1) {
      return toolError(
        ERROR_CODES.symbolAmbiguous,
        `symbol '${args.symbol}' is ambiguous — pass \`file\` to disambiguate`,
        {
          retryable: false,
          details: {
            candidates: matches.map((m) => ({
              file: m.filePath,
              kind: m.kind,
              line: m.startLine + 1,
            })),
          },
        },
      );
    }

    const sym = matches[0];
    if (sym === undefined) {
      // Defensive: matches.length === 1 implies sym is set, but
      // narrow for the type checker.
      return toolError(ERROR_CODES.symbolNotFound, 'unexpected: empty match');
    }

    const projectRoot = ctx.codeIndex.projectRoot;
    const absPath = resolve(projectRoot, sym.filePath);

    // Self-gate against the resolved file. We're category=misc
    // by necessity (see header), but the file the tool actually
    // reads must still pass fs.read policy.
    //
    // - Tool name `'read_file'` (not 'read_symbol') so existing
    //   read_file policy sections apply unchanged. Operators
    //   typically gate "what may be read" once via read_file
    //   rules; forcing them to mirror those rules under a
    //   separate read_symbol section would invite drift. Mirrors
    //   the pattern in monitor / wait_for.
    // - Treat any non-allow decision as a block (`!== 'allow'`).
    //   The harness owns the confirm flow (confirmFn); a tool's
    //   self-gate has no UI to prompt, so a `confirm` here is
    //   effectively a deny — same shape as monitor / wait_for.
    const decision = ctx.permissionCheck('read_file', 'fs.read', { path: absPath });
    if (decision.kind !== 'allow') {
      const reason =
        decision.kind === 'deny'
          ? decision.reason
          : (decision.reason ?? 'confirm required, none available in self-gate');
      return toolError(ERROR_CODES.permissionDenied, reason, {
        retryable: false,
        details: { resolved: absPath, decision: decision.kind },
      });
    }

    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      // Index is stale — file row exists but disk is gone.
      // Surface as fs.read_failed (not symbol.not_found) so the
      // model can distinguish "rebuild index" from "wrong name".
      return toolError(
        ERROR_CODES.readFailed,
        `index references ${sym.filePath}, but file is missing on disk — run \`agent --code-index scan\``,
        { retryable: false, details: { resolved: absPath } },
      );
    }
    const fullSource = await file.text();
    const source = sliceSource(fullSource, sym.startLine, sym.endLine);

    return {
      symbol: {
        name: sym.name,
        kind: sym.kind,
        fqn: sym.fqn,
        file: sym.filePath,
        // 1-indexed line numbers in the output — matches what
        // editors / `read_file` report. tree-sitter stores
        // 0-indexed internally.
        line_range: { start: sym.startLine + 1, end: sym.endLine + 1 },
      },
      source,
      signature: sym.signature,
    };
  },
};
