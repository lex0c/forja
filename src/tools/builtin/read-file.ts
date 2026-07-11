import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { pathArgOf } from './_path-arg.ts';

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

// Per-line cap. Files in the wild can have lines that are MBs long
// (minified JSON, single-line logs, generated code, binary disguised
// as text). The model never benefits from megabyte-sized lines, and
// downstream consumers (TUI, audit, recap) all assume "lines fit a
// screen". Truncate per-line at this cap; callers see the `…`
// suffix and know the line was clipped.
const MAX_LINE_LENGTH = 2000;

// File-size cap applied BEFORE the read. The whole file lands in
// memory (the read doesn't honor offset/limit), so an unbounded
// read of a multi-GB log would either OOM the process or pin the
// JS thread for seconds — operator perceives "frozen UI" even
// though the tool is just reading. 10 MiB covers any realistic
// source-code workload (large lockfiles, generated bindings) with
// margin; anything past it should be processed by purpose-built
// tools (grep with line ranges, head/tail via bash) instead of
// loaded into the model context wholesale.
// Exported so a producer that writes a file for the model to read back
// (fetch_url's oversized-page spill) can cap its output to stay under this
// limit — otherwise it would hand the model a saved_path read_file refuses.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Binary-detection scan window. We look for a NUL byte (0x00) in the
// first N bytes to classify a file as binary — git uses the same
// FIRST_FEW_BYTES = 8000 cutoff. A NUL never occurs in valid UTF-8
// text, so scanning only the head still catches every real binary
// (images, object files, archives all carry NULs early) while
// keeping the check cheap on large files. See the scan site for the
// UTF-16 trade-off.
const BINARY_SCAN_BYTES = 8000;

// Total-output byte cap. The per-line (MAX_LINE_LENGTH) and per-call
// (DEFAULT_LIMIT) caps each bound one dimension, not their product: a
// 2000-line window of long lines is multiple MB, which would blow the
// model's context budget in one tool result — exactly what
// OUTPUT_POLICY's "read_file is paginated/small" classification assumes
// away. Cap the assembled content; when the cap trims the window the
// result still reports `truncated` with a reduced `lines_returned`, so
// the caller pages on via offset. 256 KiB clears any normal source read
// (2000 lines at ~40-80 chars is 80-160 KiB) and only bites
// verbose/generated files, bounding a result to ~64k tokens vs ~1M.
const MAX_OUTPUT_BYTES = 256 * 1024;

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  description:
    'Read a text file. Returns its content (raw, no line-number prefixes) with total_lines and a truncated flag. Returns lines from offset (0-based) up to a default cap; if truncated is true, read again with offset advanced by lines_returned to continue, or raise limit. Binary files are refused — use bash (file/xxd/hexdump) for raw bytes. Parallel-safe: emit multiple read_file calls in a single turn to batch reads concurrently.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
      offset: { type: 'integer', minimum: 0, description: 'Line offset (0-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Max lines to return (default 2000).' },
    },
    required: ['path'],
  },
  metadata: {
    category: 'fs.read',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<ReadFileOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before read', { retryable: true });
    }
    // Schema declares offset (minimum: 0) and limit (minimum: 1) but
    // providers don't enforce schema constraints — model JSON arrives
    // unvalidated. Without these checks: negative offset reads from
    // a negative line index (slice misbehavior); fractional values
    // land in line-slice math producing off-by-fractional reads;
    // limit=0 returns empty content despite a valid file with a
    // confusing pending=true. Reject runtime-side.
    if (args.offset !== undefined) {
      if (
        typeof args.offset !== 'number' ||
        !Number.isFinite(args.offset) ||
        !Number.isInteger(args.offset) ||
        args.offset < 0
      ) {
        return toolError(ERROR_CODES.invalidArg, 'offset must be a non-negative integer');
      }
    }
    if (args.limit !== undefined) {
      if (
        typeof args.limit !== 'number' ||
        !Number.isFinite(args.limit) ||
        !Number.isInteger(args.limit) ||
        args.limit < 1
      ) {
        return toolError(ERROR_CODES.invalidArg, 'limit must be a positive integer (>=1)');
      }
    }
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_LIMIT;
    // Resolve the path with the SAME `file_path > path` precedence the
    // permission engine used to gate this call (see `_path-arg.ts`), so the
    // tool reads exactly the file the engine authorized — not a divergent
    // arg. Null ⇒ neither field is a usable string: clean invalid-arg error
    // instead of an `isAbsolute(undefined)` TypeError crash.
    const pathArg = pathArgOf(args);
    if (pathArg === null) {
      return toolError(ERROR_CODES.invalidArg, "missing or non-string 'path' argument");
    }
    const abs = isAbsolute(pathArg) ? pathArg : resolve(ctx.cwd, pathArg);

    // Classify the path before reading. `Bun.file(...).exists()` returns
    // false for a directory, so the previous single check reported a
    // real directory as `fs.not_found` — misleading the model into
    // thinking the path is absent (a common slip: `read_file src/`).
    // Stat first: a directory gets the dedicated `fs.is_directory` with a
    // pointer to the listing tools; a genuine ENOENT still maps to
    // `fs.not_found`. `stat` (not `lstat`) follows symlinks, matching how
    // the read below resolves a symlinked file.
    let info: Stats;
    try {
      info = await stat(abs);
    } catch {
      return toolError(ERROR_CODES.notFound, `file not found: ${pathArg}`, {
        details: { resolved: abs },
      });
    }
    if (info.isDirectory()) {
      return toolError(ERROR_CODES.isDirectory, `path is a directory, not a file: ${pathArg}`, {
        hint: 'List a directory with glob (pattern like "<dir>/**") or bash `ls`.',
        details: { resolved: abs },
      });
    }
    const file = Bun.file(abs);

    // File-size gate. The `arrayBuffer()` read below loads the entire
    // file into memory regardless of offset/limit — a defensive cap
    // here refuses absurd reads upfront with a clear error rather than
    // letting the JS thread pin (or OOM) on a multi-GB log. The gate
    // doubles as the abort path for `B`-axis interruptibility: since
    // the read itself is a native single-syscall read with no
    // checkpoint, we can't honor a mid-read abort the way the old
    // streaming impl could; capping the input bounds the worst-case
    // wall-clock so an aborted operator at most waits the read out.
    const size = info.size; // reuse the stat above — no second metadata syscall
    if (size > MAX_FILE_BYTES) {
      return toolError(
        ERROR_CODES.readFailed,
        `file too large: ${size} bytes (cap ${MAX_FILE_BYTES})`,
        { details: { resolved: abs, size } },
      );
    }

    // Read the whole file in one shot, as bytes. Streaming via
    // `file.stream().getReader()` to keep memory proportional to
    // the requested window is defensible in theory, but it freezes
    // on real .gitignore / package.json reads — the stream loop
    // never satisfies its `done` condition under specific Bun +
    // raw-mode-stdio combinations. reader.read() suspends forever,
    // the tool never returns, and the operator sees "input frozen"
    // while the harness awaits our promise.
    //
    // `file.arrayBuffer()` is a single native read(2) loop, no
    // JS-level async loop, no `done` handshake, no possibility of
    // the stream library getting wedged — the same property the old
    // `file.text()` path relied on. We take the raw bytes (not the
    // decoded string) so the binary scan below can see NULs; the
    // decode then runs once over the bytes already in hand. Trade-
    // off: it loads the whole file even when offset/limit would only
    // need a window — bounded by MAX_FILE_BYTES above so the worst
    // case is predictable rather than open-ended.
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${pathArg}: ${(e as Error).message}`,
        { details: { resolved: abs } },
      );
    }
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted during read', { retryable: true });
    }

    // Binary detection — the spec's "Read tool detecta automaticamente"
    // (TOOL_ERGONOMICS §3). Scan the leading window for a NUL (0x00):
    // git's is-binary heuristic. A NUL never appears in valid UTF-8
    // text, so its presence marks an image / object file / archive,
    // which would otherwise decode to mojibake + U+FFFD noise that
    // burns context budget and tells the model nothing. Refuse with a
    // dedicated code and point at bash for the rare raw-bytes need.
    // Known trade-off: UTF-16 text carries interleaved NULs in the
    // ASCII range and is flagged binary — but the prior `text()` path
    // already mis-decoded it to garbage, so this is an honest refusal,
    // not a regression.
    const scanLen = Math.min(bytes.length, BINARY_SCAN_BYTES);
    for (let i = 0; i < scanLen; i++) {
      if (bytes[i] === 0) {
        return toolError(ERROR_CODES.binaryFile, `refusing to read binary file: ${pathArg}`, {
          hint: 'NUL byte detected. To inspect raw bytes, use bash (`file`, `xxd`, `hexdump`).',
          details: { resolved: abs, size, nul_offset: i },
        });
      }
    }

    // Decode the bytes we already hold — TextDecoder decodes the view
    // with no copy (vs. `Buffer.from(bytes)`, which would copy up to
    // MAX_FILE_BYTES first). Its default strips a leading UTF-8 BOM,
    // matching both the `file.text()` this replaced and the sibling
    // `edit_file` (which still reads via `file.text()`): the two tools
    // must decode a given file identically, or content read here would
    // not line up with the bytes edit_file matches against.
    const raw = new TextDecoder('utf-8').decode(bytes);

    const truncateLine = (line: string): string =>
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;

    const allLines = raw.split('\n');
    const total_lines = allLines.length;
    const windowEnd = Math.min(offset + limit, total_lines);

    // Assemble the requested window, stopping early if the UTF-8 size of
    // the content would cross MAX_OUTPUT_BYTES (see the constant). At
    // least one line is always emitted — a single per-line-capped line
    // is ~8 KiB at most, well under the cap — so a giant first line
    // can't produce an empty read.
    const selected: string[] = [];
    let outBytes = 0;
    let byteCapped = false;
    for (let i = offset; i < windowEnd; i++) {
      const line = truncateLine(allLines[i] ?? '');
      // +1 accounts for the '\n' that join inserts before every line but
      // the first; an upper bound is all a byte cap needs.
      const add = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
      if (selected.length > 0 && outBytes + add > MAX_OUTPUT_BYTES) {
        byteCapped = true;
        break;
      }
      selected.push(line);
      outBytes += add;
    }
    const truncated = byteCapped || offset + selected.length < total_lines;
    return {
      content: selected.join('\n'),
      total_lines,
      offset,
      lines_returned: selected.length,
      truncated,
    };
  },
};
