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

    // Stream the file line-by-line so memory stays proportional to
    // `limit`, not file size. The previous implementation called
    // `file.text()` and split the whole content, which loaded GB-scale
    // files into RAM even when the caller asked for a small window.
    //
    // Two phases:
    //  1. SLOW: decode UTF-8 chunks, split on `\n`, push lines that fall
    //     in [offset, offset+limit) into `selected`.
    //  2. FAST: once `selected` is full, drop the text buffer and just
    //     count `0x0a` bytes in the remaining stream. We need an
    //     accurate `total_lines` for the response, but past the window
    //     we don't need to materialize text at all.
    //
    // total_lines == (newline count) + 1, matching `String.split('\n')`
    // semantics: an empty file is "1 line" of "", a file ending in `\n`
    // gets a trailing empty line.
    let nextLineIndex = 0;
    const selected: string[] = [];
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fastMode = false;

    const tryEmit = (line: string): void => {
      if (nextLineIndex >= offset && selected.length < limit) {
        selected.push(line);
      }
      nextLineIndex += 1;
    };

    try {
      while (true) {
        if (ctx.signal.aborted) {
          return toolError(ERROR_CODES.aborted, 'tool aborted during read', { retryable: true });
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (fastMode) {
          // Count `\n` bytes; ignore everything else.
          for (let i = 0; i < value.byteLength; i++) {
            if (value[i] === 0x0a) nextLineIndex += 1;
          }
          continue;
        }
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          tryEmit(line);
        }
        if (selected.length >= limit) {
          // Switch to fast mode for the rest of the file. Account for
          // any newlines still sitting in `buffer` (decoded but not yet
          // emitted because they were the last partial line we tried to
          // process — they're not actually newlines, but defensive count
          // in case future logic changes). Then drop the buffer.
          for (let i = 0; i < buffer.length; i++) {
            if (buffer.charCodeAt(i) === 0x0a) nextLineIndex += 1;
          }
          buffer = '';
          fastMode = true;
        }
      }
      if (!fastMode) buffer += decoder.decode();
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${args.path}: ${(e as Error).message}`,
        { details: { resolved: abs } },
      );
    } finally {
      reader.releaseLock();
    }

    if (fastMode) {
      // We never saw the trailing partial line content, but we know
      // total_lines is `newlines + 1`. nextLineIndex currently equals
      // the newline count (slow-phase emits + fast-phase counts), so
      // bump by one to match `split('\n').length`.
      nextLineIndex += 1;
    } else {
      // Drain any newlines flushed by the decoder, then emit the final
      // unterminated line (always — even if it's empty, matching the
      // trailing-empty-line semantics of split).
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        tryEmit(line);
      }
      tryEmit(buffer);
    }

    const total_lines = nextLineIndex;
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
