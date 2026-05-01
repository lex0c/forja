// `dependents_of` — list files that import a given file. Spec
// CODE_INDEX.md §5.4: the reverse-graph counterpart of
// `imports_of`. Canonical use case: refactor playbook —
// "before changing the API of `auth.ts`, who needs to be
// reviewed?"
//
// Lookup uses `imports.target_path`, which the resolver fills
// at scan time (slice 4.3.3.a). Pre-resolver target_path was
// always null and this query was empty; post-resolver, every
// local import edge can be traversed in reverse.
//
// `hops` (default 1, cap 3) walks transitively: the direct
// importers, then their importers, etc. The pipeline runs
// resolveImports after every scan so multi-hop is meaningful
// (unlike imports_of, which still degenerated when target_path
// was null).
//
// Each result row carries the imported names (e.g.,
// `['login', 'logout']`) so the operator can see WHAT the
// downstream depends on, not just THAT it depends.

import type { Import } from '../../code-index/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface DependentsOfInput {
  path: string;
  hops?: number;
}

export interface DependentEdge {
  // The importing file's project-relative path.
  path: string;
  // Names imported from the target. Same shape as imports_of's
  // `names`: `['default']`, `['*']`, or specific names.
  imported_names: string[];
  // Hop distance from the original target. 1 = direct
  // dependent; 2 = imported by a direct dependent; etc.
  hops: number;
}

export interface DependentsOfOutput {
  dependents: DependentEdge[];
  truncated: boolean;
}

const DEFAULT_HOPS = 1;
const MAX_HOPS = 3;
// Cap result size to keep the response model-window-friendly.
// A hot file in a monorepo can have hundreds of dependents.
const MAX_DEPENDENTS = 500;

const renderEdge = (imp: Import, hops: number): DependentEdge => ({
  path: imp.sourceFile,
  imported_names: imp.importedNames,
  hops,
});

export const dependentsOfTool: Tool<DependentsOfInput, DependentsOfOutput> = {
  name: 'dependents_of',
  description:
    'List files that import a given file. Reverse-graph counterpart of imports_of. `hops` walks transitively (default 1, cap 3) — direct importers at hops=1, their importers at hops=2, etc. Useful for refactor impact analysis: who needs review when this file changes?',
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
  async execute(args, ctx): Promise<ToolResult<DependentsOfOutput>> {
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
    const queue: { target: string; depth: number }[] = [{ target: args.path, depth: 0 }];
    const edges: DependentEdge[] = [];
    let truncated = false;

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      if (next.depth >= hops) continue;
      const direct = ctx.codeIndex.dependentsOfDetailed(next.target);
      for (const imp of direct) {
        // Cycle guard: if a transitive dependency loops back to
        // the original target, the target appears as a
        // "dependent of itself", which is meaningless for the
        // refactor-impact use case. Skip those edges entirely.
        // The visited check below still prevents infinite walks
        // for non-target cycles.
        if (imp.sourceFile === args.path) continue;
        if (edges.length >= MAX_DEPENDENTS) {
          truncated = true;
          break;
        }
        const newDepth = next.depth + 1;
        edges.push(renderEdge(imp, newDepth));
        if (!visited.has(imp.sourceFile) && newDepth < hops) {
          visited.add(imp.sourceFile);
          queue.push({ target: imp.sourceFile, depth: newDepth });
        }
      }
      if (truncated) break;
    }

    return { dependents: edges, truncated };
  },
};
