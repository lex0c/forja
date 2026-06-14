import { isAbsolute, resolve } from 'node:path';
import { maybeWrapSandboxArgv } from '../../permissions/index.ts';
import { scrubEnv } from '../../sanitize/env.ts';
import {
  ERROR_CODES,
  type SummarizedOutput,
  type Tool,
  type ToolResult,
  toolError,
} from '../types.ts';

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
  // Present (only) when the per-match policy gate dropped matches from one or
  // more files the search covered. grep gates per-match disclosure on the
  // `read_file` policy (PermissionsView.canReadPath), NOT its own `grep`
  // section — read_file.allow_paths is the single content-disclosure floor that
  // every content-emitting tool defers to. So a policy that grants
  // `tools.grep.allow_paths` but not the same paths under `tools.read_file`
  // authorizes the grep CALL yet hides every match — without this note that
  // reads as a bogus `count: 0`. The note states the coupling so the operator
  // can grant read_file (if the omission was accidental) or recognize the
  // hidden hits as a deliberate deny / sensitive-floor block.
  policy_note?: string;
}

const DEFAULT_MAX = 200;

// Env handed to the spawned ripgrep. ALWAYS scrubbed — rg needs none of the
// operator's credentials, and the scrub is the only protection in degraded /
// host mode, where there is no sandbox `--clearenv` to shape the env at the
// kernel boundary. Pre-fix this tool inherited the raw `process.env` (Bun's
// default, kept even when `sandboxTmpdir` was set: the old code spread
// `...process.env`). Inside a subagent child that env carries the provider
// API key — deliberately kept on the child's process env so it can reach the
// model it was assigned (see `PROVIDER_API_KEY_VARS` / the subagent spawn) —
// plus every other operator secret. A malicious `rg` PATH shim, or any local
// reader of `/proc/<pid>/environ`, could then recover ANTHROPIC_API_KEY /
// OPENAI_API_KEY / … from the rg subprocess even though the spawn factory's
// `scrubEnv` had stripped them from sibling tools. Passing `scrubEnv(
// process.env)` here brings grep in line with the bg manager and the bash
// broker, which already scrub. `scrubEnv` keeps PATH (rg resolves itself
// through it in degraded mode) and the locale vars rg honors. TMPDIR is
// overlaid AFTER the scrub when a per-session sandbox tmpdir is set, since
// scrubEnv only forwards allowlisted vars and TMPDIR isn't one — same pattern
// the bg manager uses. Exported pure so the credential-hygiene contract can
// be unit-tested without spawning a real ripgrep.
export const buildGrepSpawnEnv = (sandboxTmpdir: string | undefined): Record<string, string> => ({
  ...scrubEnv(process.env),
  ...(sandboxTmpdir !== undefined ? { TMPDIR: sandboxTmpdir } : {}),
});

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
    'Search files for a pattern using ripgrep. Returns matching lines with file paths and line numbers. Parallel-safe: emit multiple grep calls in a single turn to search several patterns concurrently.',
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
    parallel_safe: true,
    display: 'list',
    cost: { latency_ms_typical: 100 },
    summarize: (result) => summarizeGrepOutput(result),
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

    // §6.5 sandbox runtime wire-up via the shared helper. ENOENT
    // detection below stays scoped to ripgrep — bwrap missing is
    // filtered out by `maybeWrapSandboxArgv`'s `Bun.which('bwrap')`
    // gate, so the error path is unambiguous.
    const spawnArgv = maybeWrapSandboxArgv({
      ...(ctx.sandboxProfile !== undefined ? { profile: ctx.sandboxProfile } : {}),
      cwd: ctx.cwd,
      innerArgv: cmd,
      // Slice 157 (phase 2): per-CLI-run scoped tmpdir for darwin.
      // No-op on linux (the bwrap path ignores tmpdir) and when
      // bootstrap mkdir failed (sandboxTmpdir is undefined; falls
      // back to pre-slice-156 blanket allow).
      ...(ctx.sandboxTmpdir !== undefined ? { tmpdir: ctx.sandboxTmpdir } : {}),
      // fail-closed on mid-session loss when a tool was present at boot:
      // refuse rather than run rg unsandboxed (which would read files
      // without the credential HIDE_PATHS mask). The harness's invoke-tool
      // catch turns the throw into this tool's error (LLM + operator).
      failClosed: ctx.sandboxBootTool !== undefined,
    });

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnArgv, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: ctx.cwd,
        // Always pass a scrubbed env (never raw `process.env` inheritance) so
        // a credential — chiefly a subagent child's provider API key — can't
        // leak into the rg subprocess in degraded / host mode. The optional
        // sandbox TMPDIR (SBPL-scoped on darwin, the shared_tmp bind source
        // on linux) is overlaid inside the helper. See `buildGrepSpawnEnv`.
        env: buildGrepSpawnEnv(ctx.sandboxTmpdir),
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
    // Distinct files whose matches the policy gate dropped — surfaced as
    // `policy_note` so an all-hidden result doesn't read as a silent count: 0.
    const policyHiddenFiles = new Set<string>();
    let truncated = false;
    const decoder = new TextDecoder();
    let buffer = '';

    // Policy gate, applied DURING the scan (not after): ripgrep was
    // gated on its search ROOT, but it returns matching LINES from
    // descendant files which could include a denied secret (`.env`,
    // `secrets/…`). A denied match must NOT count toward `max` or
    // trigger the kill — otherwise a denied file owning the first
    // `max` hits would consume the whole cap and starve readable
    // matches deeper in the tree (returning 0 with truncated=true).
    // So we skip denied matches and keep scanning until `max` READABLE
    // ones accumulate. Per-file decision cached.
    const readable = new Map<string, boolean>();
    const canRead = (file: string): boolean => {
      const abs = isAbsolute(file) ? file : resolve(ctx.cwd, file);
      let ok = readable.get(abs);
      if (ok === undefined) {
        ok = ctx.permissions.canReadPath(abs);
        readable.set(abs, ok);
      }
      return ok;
    };

    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const m = parseRipgrepLine(line);
          if (m !== null) {
            if (canRead(m.file)) {
              matches.push(m);
              if (matches.length >= max) {
                truncated = true;
                break;
              }
            } else {
              policyHiddenFiles.add(m.file);
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
        if (m !== null) {
          if (canRead(m.file)) matches.push(m);
          else policyHiddenFiles.add(m.file);
        }
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

    // `matches` already holds only readable hits (gated in-loop), and
    // `truncated` means we hit `max` READABLE matches — both honest.
    return {
      pattern: args.pattern,
      matches,
      count: matches.length,
      truncated,
      ...(policyHiddenFiles.size > 0
        ? {
            policy_note: `${policyHiddenFiles.size} file(s) had matches hidden by the read_file content policy. grep gates per-match disclosure on tools.read_file.allow_paths (the shared content-disclosure floor), NOT the tools.grep section that authorized this call. If results were expected from a grep-allowed path, grant the same path under tools.read_file; otherwise the hidden hits were a deliberate deny / sensitive-floor block.`,
          }
        : {}),
    };
  },
};

// Hit-count threshold for the group-by-file fold. Below this the
// matches array passes through unchanged so the model gets full
// per-line context for small result sets. At/above, hits collapse
// to one row per file with a count + the first hit as exemplar.
const GREP_GROUP_THRESHOLD = 50;

interface GroupedGrepMatch {
  file: string;
  count: number;
  firstLine: number;
  firstText: string;
}

// Grep result summarizer. When match count crosses the threshold,
// collapse to one row per file — the model usually wants to know
// WHICH files contain the pattern far more than every individual
// line, and "show me line 42 of foo.ts" can be re-asked via a
// narrower grep.
//
// Contract: invoked only on success results (harness routes
// ToolError through a separate path).
const summarizeGrepOutput = (result: unknown): SummarizedOutput => {
  const out = result as GrepOutput;
  const originalBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (out.matches.length < GREP_GROUP_THRESHOLD) {
    return { result, reduced: false, originalBytes, policy: 'noop' };
  }
  const byFile = new Map<string, GroupedGrepMatch>();
  for (const m of out.matches) {
    const existing = byFile.get(m.file);
    if (existing === undefined) {
      byFile.set(m.file, {
        file: m.file,
        count: 1,
        firstLine: m.line,
        firstText: m.text,
      });
    } else {
      existing.count += 1;
    }
  }
  return {
    result: {
      ...out,
      matches: Array.from(byFile.values()),
    },
    reduced: true,
    originalBytes,
    policy: 'group_by_file',
  };
};
