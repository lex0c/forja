import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditFileOutput {
  path: string;
  replacements: number;
  bytes_written: number;
}

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    count += 1;
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  return count;
};

export const editFileTool: Tool<EditFileInput, EditFileOutput> = {
  name: 'edit_file',
  description:
    'Replace `old_string` with `new_string` in a file. `old_string` must be unique in the file unless `replace_all` is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
      old_string: {
        type: 'string',
        description: 'Exact substring to replace. Include enough context to be unique.',
      },
      new_string: { type: 'string', description: 'Replacement text. May be empty to delete.' },
      replace_all: {
        type: 'boolean',
        description: 'When true, replace every occurrence instead of failing on ambiguity.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  metadata: {
    category: 'fs.write',
    writes: true,
    idempotent: false,
    display: 'diff',
    cost: { latency_ms_typical: 10 },
  },
  async execute(args, ctx): Promise<ToolResult<EditFileOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before edit', { retryable: true });
    }
    if (args.old_string.length === 0) {
      return toolError(ERROR_CODES.oldStringEmpty, 'old_string must not be empty', {
        hint: 'Use write_file to create or overwrite a file from scratch.',
      });
    }
    if (args.old_string === args.new_string) {
      return toolError(ERROR_CODES.oldEqualsNew, 'old_string and new_string are identical');
    }
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return toolError(ERROR_CODES.notFound, `file not found: ${args.path}`, {
        details: { resolved: abs },
      });
    }

    let current: string;
    try {
      current = await file.text();
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${args.path}: ${(e as Error).message}`,
        {
          details: { resolved: abs },
        },
      );
    }

    const occurrences = countOccurrences(current, args.old_string);
    if (occurrences === 0) {
      return toolError(ERROR_CODES.oldStringNotFound, `old_string not found in ${args.path}`, {
        hint: 'Read the file first to confirm the exact text and indentation.',
      });
    }
    if (occurrences > 1 && args.replace_all !== true) {
      return toolError(
        ERROR_CODES.ambiguousMatch,
        `old_string appears ${occurrences} times in ${args.path}`,
        {
          hint: 'Add surrounding context to make it unique, or pass replace_all=true.',
          details: { occurrences },
        },
      );
    }

    const updated =
      args.replace_all === true
        ? current.split(args.old_string).join(args.new_string)
        : current.replace(args.old_string, args.new_string);

    try {
      const bytes = await Bun.write(abs, updated);
      return {
        path: args.path,
        replacements: args.replace_all === true ? occurrences : 1,
        bytes_written: bytes,
      };
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
