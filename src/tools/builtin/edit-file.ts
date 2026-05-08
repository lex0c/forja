import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolError, type ToolResult, toolError } from '../types.ts';

// Single replacement operation. Same shape the tool used to take at
// the top level — kept verbatim so the per-edit semantics (unique
// match unless `replace_all`, non-empty old_string, old !== new)
// are byte-identical to the prior single-edit behavior. The batch
// API is a wrapper, not a behavior shift.
export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditFileInput {
  path: string;
  edits: EditOperation[];
}

export interface EditOperationResult {
  // 1 for a single-match edit, N when `replace_all` matched N
  // occurrences. Surfaces here so the caller can verify "did edit
  // 3 actually hit anything?" without re-reading the file.
  replacements: number;
}

export interface EditFileOutput {
  path: string;
  // Per-edit replacement counts in input order. Same length as
  // `args.edits` on success.
  edits: EditOperationResult[];
  // Sum of `edits[i].replacements`. Convenience for audit / eval
  // assertions that don't care about per-edit detail.
  total_replacements: number;
  bytes_written: number;
}

// Cap on edits per call. The reasoning: a batch of >50 edits in one
// file usually indicates either (a) the model should step back and
// rewrite the file with `write_file` instead, or (b) the change is
// genuinely AST-level (rename a symbol everywhere it occurs) and a
// future symbol-aware tool would do it better than literal-substring
// substitution. Either way, blocking pathological batches keeps the
// tool's success rate honest — the model gets a clean error and
// rethinks instead of submitting a 500-edit batch that's likely to
// have a uniqueness collision somewhere.
const MAX_EDITS = 50;

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

// Apply one edit to `current`. Returns the post-edit content + the
// replacement count, or a tool error. Pure — no I/O, no mutation of
// arguments beyond what String.replace produces. Sequential batch
// semantics rely on this: each edit's `current` is the result of
// the previous edit, NOT the original file.
const applyEdit = (
  current: string,
  edit: EditOperation,
  pathLabel: string,
  index: number,
): { ok: true; content: string; replacements: number } | { ok: false; error: ToolError } => {
  if (edit.old_string.length === 0) {
    return {
      ok: false,
      error: toolError(ERROR_CODES.oldStringEmpty, `edits[${index}].old_string must not be empty`, {
        hint: 'Use write_file to create or overwrite a file from scratch.',
      }),
    };
  }
  if (edit.old_string === edit.new_string) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.oldEqualsNew,
        `edits[${index}].old_string and new_string are identical`,
      ),
    };
  }
  const occurrences = countOccurrences(current, edit.old_string);
  if (occurrences === 0) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.oldStringNotFound,
        `edits[${index}].old_string not found in ${pathLabel}`,
        {
          hint: 'Read the file first to confirm the exact text and indentation. In a batch, the search runs against the result of previous edits — an earlier edit may have removed the text you expected to find.',
        },
      ),
    };
  }
  if (occurrences > 1 && edit.replace_all !== true) {
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.ambiguousMatch,
        `edits[${index}].old_string appears ${occurrences} times in ${pathLabel}`,
        {
          hint: 'Add surrounding context to make it unique, or pass replace_all=true on this edit.',
          details: { occurrences },
        },
      ),
    };
  }
  const updated =
    edit.replace_all === true
      ? current.split(edit.old_string).join(edit.new_string)
      : current.replace(edit.old_string, edit.new_string);
  return {
    ok: true,
    content: updated,
    replacements: edit.replace_all === true ? occurrences : 1,
  };
};

export const editFileTool: Tool<EditFileInput, EditFileOutput> = {
  name: 'edit_file',
  description:
    "Apply one or more substring replacements to a file. Each edit is { old_string, new_string, replace_all? }; pass them as an array even for a single change. Edits apply SEQUENTIALLY — edit N operates on the result of edits 1..N-1, so an earlier edit may add or remove text that a later edit's old_string targets. The whole batch is ALL-OR-NOTHING: if any edit fails (old_string missing, ambiguous match, etc.) the file is not modified and the error names the failing edit's index. `old_string` must be unique in the (post-previous-edits) file content unless that edit sets `replace_all: true`. The file must already exist; use write_file to create one. Cap is 50 edits per call.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
      edits: {
        type: 'array',
        description:
          'Sequential edits to apply. Each edit operates on the result of the previous edits.',
        minItems: 1,
        maxItems: MAX_EDITS,
        items: {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              description:
                'Exact substring to replace. Include enough surrounding context to be unique unless replace_all is true.',
            },
            new_string: {
              type: 'string',
              description: 'Replacement text. May be empty to delete.',
            },
            replace_all: {
              type: 'boolean',
              description:
                'When true, replace every occurrence in the current content instead of failing on ambiguity.',
            },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
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
    if (!Array.isArray(args.edits)) {
      return toolError(ERROR_CODES.invalidArg, 'edits must be an array');
    }
    if (args.edits.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'edits must contain at least one edit');
    }
    if (args.edits.length > MAX_EDITS) {
      return toolError(
        ERROR_CODES.invalidArg,
        `edits exceeds maximum (${MAX_EDITS}, got ${args.edits.length})`,
      );
    }
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return toolError(ERROR_CODES.notFound, `file not found: ${args.path}`, {
        details: { resolved: abs },
      });
    }

    let original: string;
    try {
      original = await file.text();
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${args.path}: ${(e as Error).message}`,
        { details: { resolved: abs } },
      );
    }

    // All-or-nothing: walk the batch in memory, failing fast if any
    // edit can't apply. The original file content stays untouched
    // until every edit has succeeded — partial application would
    // leave the working tree in a state the model didn't intend
    // and the operator can't easily reason about. Checkpoint
    // semantics in the harness already give whole-call rollback;
    // batch atomicity below the call boundary is the right
    // matching granularity.
    let working = original;
    const results: EditOperationResult[] = [];
    let totalReplacements = 0;
    for (let i = 0; i < args.edits.length; i++) {
      const edit = args.edits[i];
      if (edit === undefined) {
        return toolError(ERROR_CODES.invalidArg, `edits[${i}] is missing`);
      }
      const outcome = applyEdit(working, edit, args.path, i);
      if (!outcome.ok) return outcome.error;
      working = outcome.content;
      results.push({ replacements: outcome.replacements });
      totalReplacements += outcome.replacements;
    }

    // No-op guard: skip the write when the cumulative effect of
    // the batch produces content identical to the original. The
    // per-edit `old !== new` check rejects self-replacements one
    // edit at a time, but the batch as a whole can still round-
    // trip — `foo→bar` followed by `bar→foo` leaves the file
    // textually identical to the original even though both edits
    // applied. Without the guard, that batch would still bump
    // mtime and emit a phantom write event. Cost is one string
    // equality check; benefit is honest "did this call modify
    // the file" semantics for FS watchers, audit, and the diff
    // display (which would otherwise show an empty diff).
    if (working === original) {
      return {
        path: args.path,
        edits: results,
        total_replacements: totalReplacements,
        bytes_written: 0,
      };
    }

    try {
      const bytes = await Bun.write(abs, working);
      return {
        path: args.path,
        edits: results,
        total_replacements: totalReplacements,
        bytes_written: bytes,
      };
    } catch (e) {
      return toolError(
        ERROR_CODES.writeFailed,
        `failed to write ${args.path}: ${(e as Error).message}`,
        { details: { resolved: abs } },
      );
    }
  },
};
