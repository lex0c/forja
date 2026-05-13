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

// Slice 129 (R5 P1 disk-fill): mirror read_file's 10 MiB cap on the
// write side. Without it, the model can issue a single tool call
// that writes hundreds of megabytes — exhausting disk, blowing
// past quota on shared CI runners, or just pinning the UI on a
// slow disk for seconds. The cap is on the UTF-16 character source
// (args.content.length) AND on the encoded byte count, so a
// surrogate-pair-heavy input that's small in JS chars but big in
// UTF-8 still gets blocked. Anything beyond this should be streamed
// via shell tools (`cat <<EOF`, `dd`), which the operator can scope
// independently — write_file is for source-code-sized payloads.
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

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
    // Slice 129: bound the write before touching disk. Bun.write
    // returns the byte count; we want to refuse BEFORE allocating
    // a several-hundred-MiB buffer in the kernel. Both length-axis
    // checks are cheap: `.length` is a slot read, encoded byte
    // length uses TextEncoder over a Blob-less path that doesn't
    // allocate the full encoded array.
    const charLen = args.content.length;
    const byteLen = Buffer.byteLength(args.content, 'utf8');
    if (charLen > MAX_CONTENT_BYTES || byteLen > MAX_CONTENT_BYTES) {
      return toolError(
        ERROR_CODES.writeFailed,
        `content too large: ${byteLen} bytes (cap ${MAX_CONTENT_BYTES})`,
        {
          retryable: false,
          details: { bytes: byteLen, chars: charLen, cap: MAX_CONTENT_BYTES },
        },
      );
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
