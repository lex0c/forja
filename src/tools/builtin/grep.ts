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

const parseRipgrepJson = (stdout: string): GrepMatch[] => {
  const out: GrepMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    let event: RipgrepEvent;
    try {
      event = JSON.parse(line) as RipgrepEvent;
    } catch {
      continue; // skip malformed lines
    }
    if (event.type === 'match') {
      const m = (event as RipgrepMatchEvent).data;
      out.push({
        file: m.path.text,
        line: m.line_number,
        text: m.lines.text.replace(/\n$/, ''),
      });
    }
  }
  return out;
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

    const max = args.max_results ?? DEFAULT_MAX;
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

    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const exit = await proc.exited;

    // ripgrep returns 0 on matches, 1 on no matches, 2+ on errors.
    if (exit !== 0 && exit !== 1) {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      return toolError(
        ERROR_CODES.ripgrepFailed,
        `ripgrep exited ${exit}: ${stderr.trim() || '(no stderr)'}`,
        { details: { exit_code: exit, command: cmd } },
      );
    }

    const matches = parseRipgrepJson(stdout);
    const truncated = matches.length >= max;
    return {
      pattern: args.pattern,
      matches: matches.slice(0, max),
      count: matches.length,
      truncated,
    };
  },
};
