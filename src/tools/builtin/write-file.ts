import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface WriteFileOutput {
  path: string;
  bytes_written: number;
  created: boolean;
}

export const writeFileTool: Tool<WriteFileInput, WriteFileOutput> = {
  name: 'write_file',
  description:
    'Write text content to a file, creating it (and parent directories) if needed. Overwrites existing content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
      content: { type: 'string', description: 'Full file content. The file is overwritten.' },
    },
    required: ['path', 'content'],
  },
  metadata: {
    category: 'fs.write',
    writes: true,
    idempotent: false, // overwrites
    display: 'auto',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<WriteFileOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before write', { retryable: true });
    }
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    const file = Bun.file(abs);
    const created = !(await file.exists());

    try {
      mkdirSync(dirname(abs), { recursive: true });
      const bytes = await Bun.write(abs, args.content);
      return { path: args.path, bytes_written: bytes, created };
    } catch (e) {
      return toolError(
        ERROR_CODES.writeFailed,
        `failed to write ${args.path}: ${(e as Error).message}`,
        {
          details: { resolved: abs },
        },
      );
    }
  },
};
