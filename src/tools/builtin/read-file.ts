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

// Per-line cap. Files in the wild can have lines that are MBs long
// (minified JSON, single-line logs, generated code, binary disguised
// as text). The model never benefits from megabyte-sized lines, and
// downstream consumers (TUI, audit, recap) all assume "lines fit a
// screen". Truncate per-line at this cap; callers see the `…`
// suffix and know the line was clipped.
const MAX_LINE_LENGTH = 2000;

// File-size cap applied BEFORE `file.text()`. The whole file lands
// in memory (`text()` doesn't honor offset/limit), so an unbounded
// read of a multi-GB log would either OOM the process or pin the
// JS thread for seconds — operator perceives "frozen UI" even
// though the tool is just reading. 10 MiB covers any realistic
// source-code workload (large lockfiles, generated bindings) with
// margin; anything past it should be processed by purpose-built
// tools (grep with line ranges, head/tail via bash) instead of
// loaded into the model context wholesale.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
    const abs = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);

    const file = Bun.file(abs);
    if (!(await file.exists())) {
      return toolError(ERROR_CODES.notFound, `file not found: ${args.path}`, {
        details: { resolved: abs },
      });
    }

    // File-size gate. `file.text()` below loads the entire file into
    // memory regardless of offset/limit — a defensive cap here
    // refuses absurd reads upfront with a clear error rather than
    // letting the JS thread pin (or OOM) on a multi-GB log. The
    // gate doubles as the abort path for `B`-axis interruptibility:
    // since `text()` itself is a native single-syscall read with no
    // checkpoint, we can't honor a mid-read abort the way the old
    // streaming impl could; capping the input bounds the worst-case
    // wall-clock so an aborted operator at most waits text() out.
    const size = file.size;
    if (size > MAX_FILE_BYTES) {
      return toolError(
        ERROR_CODES.readFailed,
        `file too large: ${size} bytes (cap ${MAX_FILE_BYTES})`,
        { details: { resolved: abs, size } },
      );
    }

    // Read the whole file in one shot. Streaming via
    // `file.stream().getReader()` to keep memory proportional to
    // the requested window is defensible in theory, but it freezes
    // on real .gitignore / package.json reads — the stream loop
    // never satisfies its `done` condition under specific Bun +
    // raw-mode-stdio combinations. reader.read() suspends forever,
    // the tool never returns, and the operator sees "input frozen"
    // while the harness awaits our promise.
    //
    // `file.text()` is a single native read(2) loop, no JS-level
    // async loop, no `done` handshake, no possibility of the stream
    // library getting wedged. Trade-off: it loads the whole file
    // even when offset/limit would only need a window — bounded by
    // MAX_FILE_BYTES above so the worst case is predictable rather
    // than open-ended.
    let raw: string;
    try {
      raw = await file.text();
    } catch (e) {
      return toolError(
        ERROR_CODES.readFailed,
        `failed to read ${args.path}: ${(e as Error).message}`,
        { details: { resolved: abs } },
      );
    }
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted during read', { retryable: true });
    }

    const truncateLine = (line: string): string =>
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;

    const allLines = raw.split('\n');
    const total_lines = allLines.length;
    const selected = allLines.slice(offset, offset + limit).map(truncateLine);
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
