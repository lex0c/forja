import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileOutput {
  content: string;
  total_lines: number;
  offset: number;
  lines_returned: number;
  truncated: boolean;
}

const DEFAULT_LIMIT = 2000;

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  description:
    'Read a file from the filesystem. Use offset/limit to read specific line ranges of large files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
      offset: { type: 'integer', minimum: 0, description: 'Line offset (0-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Max lines to return.' },
    },
    required: ['path'],
  },
  metadata: {
    category: 'fs.read',
    writes: false,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<ReadFileOutput>> {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);

    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before read', { retryable: true });
    }

    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return toolError(ERROR_CODES.notFound, `file not found: ${args.path}`, {
        details: { resolved: abs },
      });
    }

    let content: string;
    try {
      content = await file.text();
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${args.path}: ${(e as Error).message}`,
        {
          details: { resolved: abs },
        },
      );
    }

    const lines = content.split('\n');
    const total_lines = lines.length;
    const selected = lines.slice(offset, offset + limit);
    const truncated = offset + selected.length < total_lines;
    return {
      content: selected.join('\n'),
      total_lines,
      offset,
      lines_returned: selected.length,
      truncated,
    };
  },
};
