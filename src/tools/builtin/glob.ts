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
