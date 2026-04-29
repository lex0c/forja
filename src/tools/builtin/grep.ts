import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  max_results?: number;
  case_insensitive?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  pattern: string;
  matches: GrepMatch[];
  count: number;
  truncated: boolean;
}

const DEFAULT_MAX = 200;

interface RipgrepBeginEvent {
  type: 'begin';
  data: { path: { text: string } };
}
interface RipgrepMatchEvent {
  type: 'match';
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

type RipgrepEvent = RipgrepBeginEvent | RipgrepMatchEvent | { type: string };

// Parse a single NDJSON line. Returns the GrepMatch if the line is a
// `match` event, or null for begin/end/summary lines and malformed JSON.
const parseRipgrepLine = (line: string): GrepMatch | null => {
  if (line.length === 0) return null;
  let event: RipgrepEvent;
  try {
    event = JSON.parse(line) as RipgrepEvent;
  } catch {
    return null; // skip malformed lines
  }
  if (event.type !== 'match') return null;
  const m = (event as RipgrepMatchEvent).data;
  return {
    file: m.path.text,
    line: m.line_number,
    text: m.lines.text.replace(/\n$/, ''),
  };
};

export const grepTool: Tool<GrepInput, GrepOutput> = {
  name: 'grep',
  description:
    'Search files for a pattern using ripgrep. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (ripgrep regex).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to cwd.' },
      glob: { type: 'string', description: 'Glob filter for filenames, e.g. `*.ts`.' },
      type: { type: 'string', description: 'File type filter, e.g. `ts`, `py`.' },
      max_results: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum match lines to return.',
      },
      case_insensitive: { type: 'boolean', description: 'Match case-insensitively.' },
    },
    required: ['pattern'],
  },
  metadata: {
    category: 'fs.read',
    writes: false,
    idempotent: true,
    display: 'list',
    cost: { latency_ms_typical: 100 },
  },
  async execute(args, ctx): Promise<ToolResult<GrepOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before grep', { retryable: true });
    }

    // Schema declares max_results minimum: 1 but providers don't
    // enforce schema constraints — model JSON arrives unvalidated.
    // Without this check, the value flows into String() and into
    // ripgrep's --max-count flag, surfacing as a messy CLI parse
    // error ("invalid value 'abc' for '--max-count'") instead of
    // a clean tool.invalid_arg.
    if (args.max_results !== undefined) {
      if (
        typeof args.max_results !== 'number' ||
        !Number.isFinite(args.max_results) ||
        !Number.isInteger(args.max_results) ||
        args.max_results < 1
      ) {
        return toolError(ERROR_CODES.invalidArg, 'max_results must be a positive integer (>=1)');
      }
    }

    const max = args.max_results ?? DEFAULT_MAX;
    // Pass --max-count as a per-file safety so a single huge file can't
    // dominate the budget. The global cap is enforced below by counting
    // matches as we stream and killing rg when we hit `max`.
    const cmd: string[] = ['rg', '--json', '--max-count', String(max)];
    if (args.case_insensitive === true) cmd.push('-i');
    if (args.glob !== undefined) cmd.push('--glob', args.glob);
    if (args.type !== undefined) cmd.push('--type', args.type);
    cmd.push('--', args.pattern);
    if (args.path !== undefined) {
      const target = isAbsolute(args.path) ? args.path : resolve(ctx.cwd, args.path);
      cmd.push(target);
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(cmd, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: ctx.cwd,
        // biome-ignore lint/suspicious/noExplicitAny: Bun's spawn typing for `signal` is too narrow
        ...({ signal: ctx.signal } as any),
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ENOENT')) {
        return toolError(ERROR_CODES.ripgrepMissing, 'ripgrep (rg) not found in PATH', {
          hint: 'Install ripgrep: https://github.com/BurntSushi/ripgrep#installation',
        });
      }
      return toolError(ERROR_CODES.ripgrepFailed, `failed to spawn ripgrep: ${msg}`);
    }

    // Stream stdout line-by-line, parsing as we go. The earlier
    // implementation buffered the whole output into memory before
    // slicing, so a large repo could blow up memory even when `max`
    // was small. With streaming we stop as soon as we hit `max` matches
    // and kill rg so it stops walking the tree.
    const matches: GrepMatch[] = [];
    let truncated = false;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const m = parseRipgrepLine(line);
          if (m !== null) {
            matches.push(m);
            if (matches.length >= max) {
              truncated = true;
              break;
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }

        if (truncated) {
          try {
            proc.kill('SIGTERM');
          } catch {
            // already exited
          }
          break;
        }
      }
      // Flush any trailing line in the buffer that didn't end with `\n`.
      if (!truncated && buffer.length > 0) {
        const m = parseRipgrepLine(buffer);
        if (m !== null) matches.push(m);
      }
    } catch (e) {
      // for-await on an aborted stream throws; surface as a clean error.
      return toolError(ERROR_CODES.ripgrepFailed, `ripgrep stream failed: ${(e as Error).message}`);
    }

    const exit = await proc.exited;

    // If we killed rg because of truncation, ignore the exit code (it
    // reflects SIGTERM, not an error). Otherwise: rg returns 0 on
    // matches, 1 on no matches, 2+ on real errors.
    if (!truncated && exit !== 0 && exit !== 1) {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      return toolError(
        ERROR_CODES.ripgrepFailed,
        `ripgrep exited ${exit}: ${stderr.trim() || '(no stderr)'}`,
        { details: { exit_code: exit, command: cmd } },
      );
    }

    return {
      pattern: args.pattern,
      matches,
      count: matches.length,
      truncated,
    };
  },
};
