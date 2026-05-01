// `imports_of` — list the imports out of a file. Spec
// CODE_INDEX.md §5.4: surface the dependency graph edges
// originating at `path`. Canonical use case: "what does this
// module reach for?" — pair with `dependents_of` (4.3.3+) for
// the reverse direction.
//
// `hops` (default 1, cap 3) does a transitive walk via
// `target_path`. Until the reference resolver runs (slice
// 4.3.3), `target_path` is null on every row, so multi-hop
// degenerates to the direct edges. The hop logic stays so the
// API doesn't change shape later.
//
// External vs local: `is_external` reflects the spec heuristic
// from `extract.ts` — relative paths are local, bare specifiers
// are external. The full resolution into a concrete file path
// lands in 4.3.3.

import type { Import } from '../../code-index/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ImportsOfInput {
  path: string;
  hops?: number;
}

export interface ImportEdge {
  from_path: string;
  target_path: string | null;
  target_module: string | null;
  names: string[];
  is_external: boolean;
}

export interface ImportsOfOutput {
  imports: ImportEdge[];
  truncated: boolean;
}

const DEFAULT_HOPS = 1;
const MAX_HOPS = 3;
// Cap result size — graph queries can fan out aggressively in
// monorepos; a 5000-edge response would blow the model's window
// without adding signal.
const MAX_EDGES = 500;

const renderEdge = (imp: Import): ImportEdge => ({
  from_path: imp.sourceFile,
  target_path: imp.targetPath,
  target_module: imp.targetModule,
  names: imp.importedNames,
  is_external: imp.isExternal,
});

export const importsOfTool: Tool<ImportsOfInput, ImportsOfOutput> = {
  name: 'imports_of',
  description:
    'List the imports out of a file (the dependency edges originating there). `hops` walks transitively via resolved target paths (default 1, cap 3); until the resolver lands, multi-hop returns the direct edges only.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file path.' },
      hops: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_HOPS,
        description: `Transitive walk depth (default ${DEFAULT_HOPS}, cap ${MAX_HOPS}).`,
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
  async execute(args, ctx): Promise<ToolResult<ImportsOfOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before lookup', { retryable: true });
    }
    if (typeof args.path !== 'string' || args.path.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'path must be a non-empty string');
    }
    if (args.hops !== undefined) {
      if (
        typeof args.hops !== 'number' ||
        !Number.isFinite(args.hops) ||
        !Number.isInteger(args.hops) ||
        args.hops < 1 ||
        args.hops > MAX_HOPS
      ) {
        return toolError(ERROR_CODES.invalidArg, `hops must be an integer in [1, ${MAX_HOPS}]`);
      }
    }
    if (ctx.codeIndex === undefined) {
      return toolError(
        ERROR_CODES.indexUnavailable,
        'code index unavailable — run `agent --code-index scan` and retry',
        { retryable: false },
      );
    }

    const hops = args.hops ?? DEFAULT_HOPS;
    const visited = new Set<string>([args.path]);
    const queue: { path: string; depth: number }[] = [{ path: args.path, depth: 0 }];
    const edges: ImportEdge[] = [];
    let truncated = false;

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      if (next.depth >= hops) continue;
      const direct = ctx.codeIndex.importsOf(next.path);
      for (const imp of direct) {
        if (edges.length >= MAX_EDGES) {
          truncated = true;
          break;
        }
        edges.push(renderEdge(imp));
        // Only walk into local targets (external packages can't
        // be enumerated by the index). `target_path` is null
        // until the resolver runs in slice 4.3.3 — the BFS
        // degenerates to depth=1 in practice, but the structure
        // is correct.
        if (
          !imp.isExternal &&
          imp.targetPath !== null &&
          !visited.has(imp.targetPath) &&
          next.depth + 1 < hops
        ) {
          visited.add(imp.targetPath);
          queue.push({ path: imp.targetPath, depth: next.depth + 1 });
        }
      }
      if (truncated) break;
    }

    return { imports: edges, truncated };
  },
};
