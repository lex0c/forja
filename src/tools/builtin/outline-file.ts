// `outline_file` — file skeleton from the code index. Spec
// CODE_INDEX.md §5.3: returns the symbols + import summary for
// a file at ~5-15% of `read_file`'s token cost. Canonical use
// case: "before editing auth.ts, what's the structure?"
//
// Visibility filter (`include_internal`): default false → only
// 'export' / 'public' surface to the model. Operators that
// need the full skeleton (audits, debugging) flip the flag.
//
// `imports_summary` is a one-line digest counting locals vs
// externals — the full edge list is `imports_of(path)`'s
// surface, not this tool's.

import type { IndexSymbol } from '../../code-index/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface OutlineFileInput {
  path: string;
  include_internal?: boolean;
}

export interface OutlineFileSymbol {
  name: string;
  kind: string;
  signature: string | null;
  line: number;
  visibility: string;
  parent: string | null;
}

export interface OutlineFileOutput {
  symbols: OutlineFileSymbol[];
  loc: number;
  imports_summary: string;
}

const PUBLIC_VISIBILITIES = new Set(['export', 'public']);

const formatImportsSummary = (total: number, external: number): string => {
  const local = total - external;
  if (total === 0) return 'no imports';
  return `imports from ${total} ${total === 1 ? 'source' : 'sources'} (${local} local, ${external} external)`;
};

// Derive the parent class name from a method's FQN. The
// extractor encodes methods as `<file>:Class.method` in
// `IndexSymbol.fqn` (see code-index/scanner/extract.ts:buildFqn).
// Non-methods carry `<file>:<name>` (no dot). When the
// reference resolver lands and starts populating
// `parent_symbol_id` we can switch to the FK lookup; until
// then, FQN parsing is the only signal available.
//
// Guard against false positives: only run this for methods.
// A future extractor change emitting dotted names elsewhere
// (e.g., namespaced consts, `mod.foo`-style identifiers)
// would otherwise mis-assign a parent. Methods are the one
// kind that legitimately encodes a parent in the FQN today.
const parentNameFromFqn = (s: IndexSymbol): string | null => {
  if (s.kind !== 'method') return null;
  if (s.fqn === null) return null;
  const colonIdx = s.fqn.indexOf(':');
  if (colonIdx < 0) return null;
  const tail = s.fqn.slice(colonIdx + 1);
  const dotIdx = tail.indexOf('.');
  return dotIdx > 0 ? tail.slice(0, dotIdx) : null;
};

const renderSymbol = (s: IndexSymbol): OutlineFileSymbol => ({
  name: s.name,
  kind: s.kind,
  signature: s.signature,
  line: s.startLine + 1, // 1-indexed for display parity
  visibility: s.visibility,
  parent: parentNameFromFqn(s),
});

export const outlineFileTool: Tool<OutlineFileInput, OutlineFileOutput> = {
  name: 'outline_file',
  description:
    'Render a structural outline of a file from the code index — symbols, signatures, line numbers, and a one-line imports summary. ~5-15% of read_file token cost; use to plan an edit before reading the body.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file path.' },
      include_internal: {
        type: 'boolean',
        description:
          'Include internal/private symbols. Default false — only exports and public methods surface.',
      },
    },
    required: ['path'],
  },
  metadata: {
    category: 'fs.read',
    writes: false,
    idempotent: true,
    display: 'list',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<OutlineFileOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before lookup', { retryable: true });
    }
    if (typeof args.path !== 'string' || args.path.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'path must be a non-empty string');
    }
    if (ctx.codeIndex === undefined) {
      return toolError(
        ERROR_CODES.indexUnavailable,
        'code index unavailable — run `agent --code-index scan` and retry',
        { retryable: false },
      );
    }

    const meta = ctx.codeIndex.fileMeta(args.path);
    if (meta === null) {
      return toolError(ERROR_CODES.notFound, `file not in index: ${args.path}`, {
        retryable: false,
        hint: 'check the path is project-relative and `agent --code-index scan` has run',
      });
    }

    const allSymbols = ctx.codeIndex.listSymbolsInFile(args.path);
    const includeInternal = args.include_internal === true;
    const filtered = includeInternal
      ? allSymbols
      : allSymbols.filter((s) => PUBLIC_VISIBILITIES.has(s.visibility));

    const imports = ctx.codeIndex.importsOf(args.path);
    const externalCount = imports.filter((i) => i.isExternal).length;

    return {
      symbols: filtered.map(renderSymbol),
      loc: meta.loc,
      imports_summary: formatImportsSummary(imports.length, externalCount),
    };
  },
};
