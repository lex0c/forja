// /recap — projected view over the audit log. Spec: RECAP.md.
//
// M4.1 (slice c) shipped: /recap, /recap last <N>, /recap session <id>,
// /recap json [session <id>] — all deterministic.
//
// M4.2 slice (a) adds:
//   /recap pr [--no-llm-render] [--out <path>]   — PR description
//
// `pr` defaults to the LLM render path: cache lookup → forced-tool
// constrained call → schema + fidelity + concision validation →
// markdown via the deterministic template. Any failure (provider
// down, schema violation, hallucinated path, exceeded line cap)
// falls back to `renderPrDeterministic` and surfaces a single
// `warn` event so the operator knows the LLM hiccupped without
// losing the recap. `--no-llm-render` skips the LLM path entirely
// (and the cache lookup with it), forcing the deterministic
// template. Providers without `capabilities.constrained` (Google,
// OpenAI today) silently degrade to the deterministic path with
// no warn — the operator did not opt into the LLM path explicitly.
//
// `--out <path>`: writes the rendered output to the given file
// path. Recorded in `recap_runs.output_path` for audit.
//
// Audit (RECAP.md §6.3): every successful invocation writes a
// `recap_runs` row with cost / tokens / cache_hit / prompt_version
// populated. Parse errors and projection failures deliberately do
// NOT write a row — those never consumed audit-worthy resources,
// and recording them would inflate the anomaly-detection signal
// with operator typos.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderPrDeterministic } from '../../../recap/pr/index.ts';
import { renderPrViaLlm } from '../../../recap/pr/llm.ts';
import { type RecapScopeOption, projectRecap } from '../../../recap/projection.ts';
import { PR_PROMPT_VERSION } from '../../../recap/prompts/pr-v1.ts';
import { renderHuman, renderJson } from '../../../recap/render.ts';
import type { RecapIntermediate } from '../../../recap/types.ts';
import {
  canonicalScopeHash,
  readRecapCache,
  writeRecapCache,
} from '../../../storage/repos/recap-cache.ts';
import { recordRecapRun } from '../../../storage/repos/recap-runs.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const DEFAULT_STEP_LIMIT = 10;

type RecapFormat = 'human' | 'json' | 'pr';

interface ParsedRecap {
  format: RecapFormat;
  scope:
    | { kind: 'session_current'; limit: number }
    | { kind: 'session_specific'; sessionId: string };
  noLlmRender: boolean;
  outPath: string | null;
}

const positiveInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const FUTURE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'day',
  'range',
  'pre-compact',
  'changelog',
  'slack',
  'terse',
  'list',
]);

const futureSubcommandMessage = (sub: string): string => {
  if (sub === 'changelog' || sub === 'slack' || sub === 'terse') {
    return `/recap: '${sub}' renderer needs the LLM render path (M4.2 slice b); not yet available`;
  }
  if (sub === 'day' || sub === 'range') {
    return `/recap: '${sub}' is cross-session scope (M4.3); not yet available`;
  }
  if (sub === 'pre-compact') {
    return `/recap: 'pre-compact' needs Context Engine wiring (M4.3); not yet available`;
  }
  // 'list'
  return `/recap: 'list' needs recap_mini cache (M4.2 slice c); not yet available`;
};

interface FlagSplit {
  positional: string[];
  noLlmRender: boolean;
  outPath: string | null;
  flagError: string | null;
}

// Pull recognized flags out of the raw arg list before subcommand
// parsing. Keeps the subcommand parsers (which were already shipped
// in M4.1) ignorant of M4.2's render-mode toggles.
const splitFlags = (args: string[]): FlagSplit => {
  const positional: string[] = [];
  let noLlmRender = false;
  let outPath: string | null = null;
  let flagError: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-llm-render') {
      noLlmRender = true;
      continue;
    }
    if (arg === '--out') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        flagError = '/recap: --out requires a file path';
        return { positional, noLlmRender, outPath, flagError };
      }
      outPath = next;
      i += 1;
      continue;
    }
    // `--out=path` form — single-token convenience. Mirrors
    // the long-flag convention used elsewhere in the slash surface.
    if (arg?.startsWith('--out=') === true) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) {
        flagError = '/recap: --out= requires a file path';
        return { positional, noLlmRender, outPath, flagError };
      }
      outPath = value;
      continue;
    }
    if (arg?.startsWith('--') === true) {
      flagError = `/recap: unknown flag '${arg}'`;
      return { positional, noLlmRender, outPath, flagError };
    }
    if (arg !== undefined) positional.push(arg);
  }
  return { positional, noLlmRender, outPath, flagError };
};

// Parse the subcommand vocabulary into a tagged union or a SlashResult
// error. Pure: no DB access, no ctx — ctx-dependent decisions
// (resolving the current session id) happen in the executor below.
const parseRecapArgs = (args: string[]): ParsedRecap | { error: string } => {
  const split = splitFlags(args);
  if (split.flagError !== null) return { error: split.flagError };
  const positional = split.positional;
  const baseExtras = { noLlmRender: split.noLlmRender, outPath: split.outPath };
  if (positional.length === 0) {
    return {
      format: 'human',
      scope: { kind: 'session_current', limit: DEFAULT_STEP_LIMIT },
      ...baseExtras,
    };
  }
  let format: RecapFormat = 'human';
  let i = 0;
  if (positional[0] === 'json') {
    format = 'json';
    i = 1;
  } else if (positional[0] === 'pr') {
    format = 'pr';
    i = 1;
  }
  if (i === positional.length) {
    return {
      format,
      scope: { kind: 'session_current', limit: DEFAULT_STEP_LIMIT },
      ...baseExtras,
    };
  }
  const head = positional[i];
  if (head === 'last') {
    const next = positional[i + 1];
    if (next === undefined) {
      return { error: '/recap last: missing step count (e.g. /recap last 5)' };
    }
    const n = positiveInt(next);
    if (n === null) {
      return {
        error: `/recap last: invalid step count '${next}' (must be a positive integer)`,
      };
    }
    if (i + 2 < positional.length) {
      return { error: '/recap last: takes exactly one argument' };
    }
    return { format, scope: { kind: 'session_current', limit: n }, ...baseExtras };
  }
  if (head === 'session') {
    const next = positional[i + 1];
    if (next === undefined || next.length === 0) {
      return { error: '/recap session: missing session id' };
    }
    if (i + 2 < positional.length) {
      return { error: '/recap session: takes exactly one argument (the session id)' };
    }
    return { format, scope: { kind: 'session_specific', sessionId: next }, ...baseExtras };
  }
  if (head !== undefined && FUTURE_SUBCOMMANDS.has(head)) {
    return { error: futureSubcommandMessage(head) };
  }
  return {
    error: `/recap: unknown subcommand '${head ?? ''}' (try /recap, /recap last <N>, /recap session <id>, /recap json, /recap pr)`,
  };
};

const renderToNotes = (text: string): string[] => {
  // Both the human and pr renderers append a trailing newline;
  // renderJson returns the bare JSON.stringify output with no
  // trailing LF. Drop the trailing LF when present so the last
  // "note" isn't an empty line that the bus would surface as a
  // phantom blank info entry.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
};

// Write recap output to the requested path. Creates parent
// directories as needed (mirrors `agent worktree` and the bg
// process log dir creation pattern). Awaits Bun.write so a slow
// disk does not let the slash return "wrote ..." before the file
// is actually flushed; awaiting also surfaces write errors
// (EACCES, ENOSPC, etc.) instead of silently dropping them in an
// unobserved Promise rejection.
const writeOutFile = async (outPath: string, content: string): Promise<void> => {
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, content);
};

const renderForFormat = (format: RecapFormat, intermediate: RecapIntermediate): string => {
  if (format === 'json') return renderJson(intermediate);
  if (format === 'pr') return renderPrDeterministic(intermediate);
  return renderHuman(intermediate);
};

export const recapCommand: SlashCommand = {
  name: 'recap',
  description: 'projected view over this session (or another by id)',
  exec: async (args, ctx: SlashContext): Promise<SlashResult> => {
    const parsed = parseRecapArgs(args);
    if ('error' in parsed) {
      return { kind: 'error', message: parsed.error };
    }

    let scope: RecapScopeOption;
    if (parsed.scope.kind === 'session_current') {
      const sessionId = ctx.currentSessionId();
      if (sessionId === null) {
        return {
          kind: 'error',
          message: '/recap: no active session yet (run a turn first, or use /recap session <id>)',
        };
      }
      scope = { kind: 'session_current', sessionId, limit: parsed.scope.limit };
    } else {
      scope = { kind: 'session_specific', sessionId: parsed.scope.sessionId };
    }

    let intermediate: RecapIntermediate;
    try {
      intermediate = projectRecap(ctx.db, { scope, now: ctx.now() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'error', message: `/recap: ${message}` };
    }

    // Render. For `pr` with LLM enabled, route through cache →
    // LLM → fallback. For everything else (human, json, pr with
    // --no-llm-render), the deterministic template is the only
    // path.
    const renderResult = await renderWithLlmOrFallback(parsed, intermediate, ctx);
    const { output, usedLlm, cacheHit, costUsd, tokensIn, tokensOut, promptVersion } = renderResult;

    if (parsed.outPath !== null) {
      try {
        await writeOutFile(parsed.outPath, output);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          kind: 'error',
          message: `/recap: failed to write --out '${parsed.outPath}': ${reason}`,
        };
      }
    }

    // Audit the run alongside returning the recap text. Per
    // RECAP.md §6.3 the row is INFORMATIONAL — a disk-full /
    // schema-corruption failure on the audit INSERT must not
    // destroy the operator's recap output.
    try {
      recordRecapRun(ctx.db, {
        scopeKind: scope.kind,
        sessionIds: intermediate.scope.sessionIds,
        renderer: parsed.format,
        usedLlm,
        outputPath: parsed.outPath,
        createdAt: ctx.now(),
        costUsd,
        tokensIn,
        tokensOut,
        promptVersion,
        cacheHit,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      ctx.bus.emit({
        type: 'warn',
        ts: ctx.now(),
        message: `/recap: audit row not written (${reason}); output is intact`,
      });
    }

    if (parsed.outPath !== null) {
      return {
        kind: 'ok',
        notes: [`/recap: wrote ${parsed.format} render to ${parsed.outPath}`],
      };
    }
    return { kind: 'ok', notes: renderToNotes(output) };
  },
};

interface RenderOutcome {
  output: string;
  usedLlm: boolean;
  cacheHit: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  promptVersion: string | null;
}

const renderWithLlmOrFallback = async (
  parsed: ParsedRecap,
  intermediate: RecapIntermediate,
  ctx: SlashContext,
): Promise<RenderOutcome> => {
  if (parsed.format !== 'pr' || parsed.noLlmRender) {
    return {
      output: renderForFormat(parsed.format, intermediate),
      usedLlm: false,
      cacheHit: false,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      promptVersion: null,
    };
  }

  const provider = ctx.baseConfig.provider;
  // Provider can't constrain output natively → straight to fallback,
  // no warn (the operator did not opt into the LLM path explicitly;
  // they just chose `/recap pr` and we silently degrade).
  if (provider.capabilities.constrained === false) {
    return {
      output: renderPrDeterministic(intermediate),
      usedLlm: false,
      cacheHit: false,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      promptVersion: null,
    };
  }

  const scopeHash = canonicalScopeHash({
    scopeKind: intermediate.scope.kind,
    sessionIds: intermediate.scope.sessionIds,
    renderer: 'pr',
    promptVersion: PR_PROMPT_VERSION,
    intermediate,
  });

  // Cache check. A hit short-circuits the LLM call entirely.
  const cached = readRecapCache(ctx.db, { scopeHash, now: ctx.now() });
  if (cached !== null) {
    return {
      output: cached.output,
      usedLlm: true,
      cacheHit: true,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      promptVersion: PR_PROMPT_VERSION,
    };
  }

  const result = await renderPrViaLlm({
    intermediate,
    provider,
    promptVersion: PR_PROMPT_VERSION,
  });
  if (!result.ok) {
    ctx.bus.emit({
      type: 'warn',
      ts: ctx.now(),
      message: `/recap pr: LLM render failed (${result.reason}: ${result.detail}); using deterministic fallback`,
    });
    return {
      output: renderPrDeterministic(intermediate),
      usedLlm: false,
      cacheHit: false,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      promptVersion: null,
    };
  }

  // Successful LLM render — write to cache for the next caller.
  // A cache write failure must not destroy the render the operator
  // is about to receive; warn and continue.
  try {
    writeRecapCache(ctx.db, {
      scopeHash,
      renderer: 'pr',
      output: result.output,
      promptVersion: PR_PROMPT_VERSION,
      generatedAt: ctx.now(),
      costUsd: result.costUsd,
      tokensIn: result.usage.input + result.usage.cache_read + result.usage.cache_creation,
      tokensOut: result.usage.output,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    ctx.bus.emit({
      type: 'warn',
      ts: ctx.now(),
      message: `/recap pr: cache write failed (${reason}); render was returned`,
    });
  }

  return {
    output: result.output,
    usedLlm: true,
    cacheHit: false,
    costUsd: result.costUsd,
    tokensIn: result.usage.input + result.usage.cache_read + result.usage.cache_creation,
    tokensOut: result.usage.output,
    promptVersion: PR_PROMPT_VERSION,
  };
};
