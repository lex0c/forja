import { isAbsolute, resolve } from 'node:path';
import { Glob } from 'bun';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface GlobInput {
  pattern: string;
  cwd?: string;
}

export interface GlobOutput {
  pattern: string;
  matches: string[];
  count: number;
  truncated: boolean;
}

const MAX_MATCHES = 1000;

// Reject patterns that can read outside the search root. The permission
// engine only authorizes glob based on the search root (`cwd`), so a
// pattern like `../secret/*.txt` with `cwd: 'src'` would be authorized
// against `src/**` but enumerate files in a sibling directory — a
// straight policy bypass. Forbid:
//   - absolute patterns (`/etc/*`)
//   - any path segment that is exactly `..`
// Bun.Glob uses `/` as the segment separator on every platform; we also
// split on `\` defensively in case a Windows-style path slips through.
const SEGMENT_SEPARATORS = /[/\\]/;

const patternEscapesRoot = (pattern: string): boolean => {
  if (isAbsolute(pattern)) return true;
  for (const seg of pattern.split(SEGMENT_SEPARATORS)) {
    if (seg === '..') return true;
  }
  return false;
};

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: 'glob',
  description: 'List files matching a glob pattern. Returns paths relative to the search root.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. `src/**/*.ts`.' },
      cwd: {
        type: 'string',
        description: 'Search root (absolute or relative). Defaults to the session cwd.',
      },
    },
    required: ['pattern'],
  },
  metadata: {
    category: 'fs.read',
    writes: false,
    idempotent: true,
    display: 'list',
    cost: { latency_ms_typical: 25 },
  },
  async execute(args, ctx): Promise<ToolResult<GlobOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before glob', { retryable: true });
    }
    if (patternEscapesRoot(args.pattern)) {
      return toolError(
        ERROR_CODES.globPatternEscapes,
        `glob pattern may not escape the search root: ${args.pattern}`,
        {
          hint: 'Use a relative pattern with no `..` segments, e.g., `src/**/*.ts`. To search a different directory, set `cwd` and re-check policy.',
        },
      );
    }
    const root =
      args.cwd === undefined
        ? ctx.cwd
        : isAbsolute(args.cwd)
          ? args.cwd
          : resolve(ctx.cwd, args.cwd);
    const matches: string[] = [];
    let truncated = false;
    try {
      const glob = new Glob(args.pattern);
      for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
        // Defense in depth: even with the upfront pattern check, refuse
        // any yielded path that resolves outside the search root. Cheap
        // belt-and-suspenders against future Bun.Glob behavior changes.
        if (path.startsWith('..') || isAbsolute(path)) continue;
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push(path);
      }
    } catch (e) {
      return toolError(ERROR_CODES.readFailed, `glob failed: ${(e as Error).message}`, {
        details: { pattern: args.pattern, root },
      });
    }
    matches.sort();
    return { pattern: args.pattern, matches, count: matches.length, truncated };
  },
};
