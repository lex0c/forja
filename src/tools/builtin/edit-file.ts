import { isAbsolute, resolve } from 'node:path';
import { atomicWrite } from '../../fs/atomic-write.ts';
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
  // Present (true) only when the exact old_string did NOT match but a
  // whitespace-tolerant fallback did (a unique near-match with one
  // uniform indent shift; new_string re-indented to the file). Signals
  // the model that its old_string drifted from the file's exact text —
  // it should copy text verbatim next time, not lean on the fallback.
  whitespace_tolerant?: boolean;
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

// --- Whitespace-tolerant fallback + actionable-error helpers ---------------
//
// The dominant edit failure is `old_string` drifting from the file by
// whitespace (indentation typed from memory, trailing spaces, a stray
// blank line) — and each miss costs the model a re-read + retry. These
// helpers (1) recover the safe case automatically and (2) make the rest
// fixable in one shot by telling the model exactly where the near-match
// is, instead of a generic "read the file" nudge.

// 1-based line number of a character offset.
const lineAt = (text: string, charIndex: number): number =>
  text.slice(0, charIndex).split('\n').length;

// 1-based start lines of up to `limit` exact occurrences of `needle`.
// Stops early — callers only display a handful, and a pathological
// many-occurrence ambiguous match shouldn't pay O(N·len) to list all.
const occurrenceLines = (haystack: string, needle: string, limit: number): number[] => {
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && out.length < limit) {
    out.push(lineAt(haystack, idx));
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
};

// Leading-whitespace (indentation) prefix of a line.
const leadingWhitespace = (line: string): string =>
  line.slice(0, line.length - line.trimStart().length);

// Trim ONLY spaces and tabs from both ends — deliberately NOT `\r`/`\n`.
// The fallback matches lines modulo indentation/trailing spaces, but a
// CRLF file's `\r` must stay significant: otherwise an LF old_string
// would trim-match a CRLF line and the re-applied lines would silently
// drop the `\r`, rewriting (or mixing) the file's line endings — a
// corruption the exact-match path safely declined.
const trimSpacesTabs = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === ' ' || s[start] === '\t')) start++;
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(start, end);
};

// A single uniform indentation transform between two aligned line sets.
type IndentShift =
  | { type: 'none' }
  | { type: 'add'; prefix: string }
  | { type: 'strip'; prefix: string };

const sameShift = (a: IndentShift, b: IndentShift): boolean => {
  if (a.type === 'add' && b.type === 'add') return a.prefix === b.prefix;
  if (a.type === 'strip' && b.type === 'strip') return a.prefix === b.prefix;
  return a.type === 'none' && b.type === 'none';
};

// The ONE indentation shift that maps every needle line's indent onto the
// corresponding file line's, or null if there isn't a single consistent
// one (mixed tabs/spaces, per-line drift). Only a clean uniform shift is
// safe to re-apply to new_string; null means "do not auto-apply". Blank
// lines carry no indentation and are skipped.
const uniformShift = (fileLines: string[], needleLines: string[]): IndentShift | null => {
  let shift: IndentShift | null = null;
  for (let i = 0; i < fileLines.length; i++) {
    const nLine = needleLines[i] ?? '';
    if (nLine.trim() === '') continue;
    const f = leadingWhitespace(fileLines[i] ?? '');
    const ndl = leadingWhitespace(nLine);
    let here: IndentShift;
    if (f === ndl) here = { type: 'none' };
    else if (f.length > ndl.length && f.endsWith(ndl))
      here = { type: 'add', prefix: f.slice(0, f.length - ndl.length) };
    else if (ndl.length > f.length && ndl.endsWith(f))
      here = { type: 'strip', prefix: ndl.slice(0, ndl.length - f.length) };
    else return null; // incompatible indentation (e.g. tabs vs spaces)
    if (shift === null) shift = here;
    else if (!sameShift(shift, here)) return null;
  }
  return shift ?? { type: 'none' };
};

// Re-indent one new_string line by the shift. Blank lines normalize to
// empty (no stray indentation); a 'strip' that wouldn't apply cleanly
// leaves the line untouched rather than guessing.
const applyShift = (line: string, shift: IndentShift): string => {
  if (line.trim() === '') return '';
  if (shift.type === 'none') return line;
  if (shift.type === 'add') return shift.prefix + line;
  return line.startsWith(shift.prefix) ? line.slice(shift.prefix.length) : line;
};

// Cap on near-match text echoed back in an error — keep the failure
// payload bounded (a huge old_string shouldn't produce a huge error).
const NEAR_MATCH_TEXT_CAP = 1600;

interface NearMatch {
  start_line: number;
  end_line: number;
  text?: string;
}

type FallbackResult =
  | { kind: 'applied'; content: string }
  | { kind: 'unsafe'; near: NearMatch }
  | { kind: 'multiple'; lines: number[] }
  | { kind: 'none' };

// Try to recover an exact-match miss by aligning lines modulo
// leading/trailing whitespace. Only a UNIQUE near-match with a single
// uniform indent shift is auto-applied (new_string re-indented to the
// file); ambiguity or non-uniform indentation returns location info so
// the caller can fail with an actionable error instead of guessing.
const whitespaceFallback = (current: string, oldStr: string, newStr: string): FallbackResult => {
  const needleLines = oldStr.split('\n');
  const hayLines = current.split('\n');
  const n = needleLines.length;
  if (n === 0 || n > hayLines.length) return { kind: 'none' };
  // A whitespace-only old_string would otherwise match the first blank
  // line in the file — refuse to fall back on it.
  if (needleLines.every((l) => l.trim() === '')) return { kind: 'none' };
  const needleTrim = needleLines.map((l) => trimSpacesTabs(l));
  const starts: number[] = [];
  for (let s = 0; s + n <= hayLines.length; s++) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (trimSpacesTabs(hayLines[s + k] ?? '') !== needleTrim[k]) {
        match = false;
        break;
      }
    }
    if (match) starts.push(s);
  }
  if (starts.length === 0) return { kind: 'none' };
  if (starts.length > 1) return { kind: 'multiple', lines: starts.slice(0, 8).map((s) => s + 1) };
  const s = starts[0] ?? 0;
  const span = hayLines.slice(s, s + n);
  const shift = uniformShift(span, needleLines);
  if (shift === null) {
    const text = span.join('\n');
    return {
      kind: 'unsafe',
      near: {
        start_line: s + 1,
        end_line: s + n,
        ...(text.length <= NEAR_MATCH_TEXT_CAP ? { text } : {}),
      },
    };
  }
  const newLines = newStr.split('\n').map((l) => applyShift(l, shift));
  const content = [...hayLines.slice(0, s), ...newLines, ...hayLines.slice(s + n)].join('\n');
  return { kind: 'applied', content };
};

// Apply one edit to `current`. Returns the post-edit content + the
// replacement count (and whether a whitespace-tolerant fallback was
// used), or a tool error. Pure — no I/O, no mutation of arguments beyond
// what String.replace produces. Sequential batch semantics rely on this:
// each edit's `current` is the result of the previous edit, NOT the
// original file.
const applyEdit = (
  current: string,
  edit: EditOperation,
  pathLabel: string,
  index: number,
):
  | { ok: true; content: string; replacements: number; whitespace_tolerant?: boolean }
  | { ok: false; error: ToolError } => {
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
    // Exact miss. For a single (non-replace_all) edit, try to recover via
    // a whitespace-tolerant fallback before failing: a unique near-match
    // with one uniform indent shift is re-indented to the file and
    // applied; anything less certain returns location info so the error
    // is actionable in one shot instead of triggering a blind retry.
    if (edit.replace_all !== true) {
      const fb = whitespaceFallback(current, edit.old_string, edit.new_string);
      if (fb.kind === 'applied') {
        return { ok: true, content: fb.content, replacements: 1, whitespace_tolerant: true };
      }
      if (fb.kind === 'unsafe') {
        return {
          ok: false,
          error: toolError(
            ERROR_CODES.oldStringNotFound,
            `edits[${index}].old_string not found in ${pathLabel}`,
            {
              hint: `A near-match (differs only in whitespace, but not by a single uniform indent shift) is at lines ${fb.near.start_line}-${fb.near.end_line}. Copy that exact text into old_string.`,
              details: { near_match: fb.near },
            },
          ),
        };
      }
      if (fb.kind === 'multiple') {
        return {
          ok: false,
          error: toolError(
            ERROR_CODES.oldStringNotFound,
            `edits[${index}].old_string not found in ${pathLabel}`,
            {
              hint: `Whitespace-insensitive near-matches start at lines ${fb.lines.join(', ')}. Add surrounding context and use the file's exact text.`,
              details: { near_match_lines: fb.lines },
            },
          ),
        };
      }
    }
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
    const lines = occurrenceLines(current, edit.old_string, 8);
    return {
      ok: false,
      error: toolError(
        ERROR_CODES.ambiguousMatch,
        `edits[${index}].old_string appears ${occurrences} times in ${pathLabel}`,
        {
          hint: `Matches start at lines ${lines.join(', ')}${occurrences > lines.length ? ', …' : ''}. Add surrounding context to target one, or pass replace_all=true on this edit.`,
          details: { occurrences, lines },
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
    "Apply one or more substring replacements to a file. Each edit is { old_string, new_string, replace_all? }; pass them as an array even for a single change. Edits apply SEQUENTIALLY — edit N operates on the result of edits 1..N-1, so an earlier edit may add or remove text that a later edit's old_string targets. The whole batch is ALL-OR-NOTHING: if any edit fails (old_string missing, ambiguous match, etc.) the file is not modified and the error names the failing edit's index. `old_string` must be unique in the (post-previous-edits) file content unless that edit sets `replace_all: true`. The file must already exist; use write_file to create one. Cap is 50 edits per call. Returns each edit's replacement count plus the total.",
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
      results.push({
        replacements: outcome.replacements,
        ...(outcome.whitespace_tolerant ? { whitespace_tolerant: true } : {}),
      });
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
      const bytes = atomicWrite(abs, working);
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
