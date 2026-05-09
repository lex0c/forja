// /recap — projected view over the audit log. Spec: RECAP.md.
//
// M4.1 (slice c) shipped: /recap, /recap last <N>, /recap session <id>,
// /recap json [session <id>] — all deterministic.
//
// M4.2 slice (a) added `/recap pr` with the LLM render pipeline.
// M4.2 slice (b) extends the pipeline to three more renderers:
//
//   /recap pr        — PR description (RECAP §4.2)
//   /recap changelog — Keep a Changelog entry (RECAP §4.3)
//   /recap slack     — Slack-friendly status post (RECAP §4.4)
//   /recap terse     — single-sentence summary (RECAP §4.6)
//
// All four route through the same flow: cache lookup → forced-tool
// constrained call → schema + fidelity + concision validation →
// markdown via the deterministic template. Any failure (provider
// down, schema violation, hallucinated value, exceeded line cap)
// falls back to the renderer-specific deterministic path and
// surfaces a single `warn` event.
//
// `--no-llm-render` skips the LLM path entirely (and the cache
// lookup with it), forcing the deterministic template. Providers
// without `capabilities.constrained` (Google, OpenAI today)
// silently degrade to the deterministic path with no warn.
//
// `--out <path>`: writes the rendered output to the given file
// path. Recorded in `recap_runs.output_path` for audit.
//
// Audit (RECAP §6.3): every successful invocation writes a
// `recap_runs` row with cost / tokens / cache_hit / prompt_version
// populated. Parse errors and projection failures deliberately do
// NOT write a row — those never consumed audit-worthy resources,
// and recording them would inflate the anomaly-detection signal
// with operator typos.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider } from '../../../providers/types.ts';
import { renderChangelogDeterministic } from '../../../recap/changelog/index.ts';
import { renderChangelogViaLlm } from '../../../recap/changelog/llm.ts';
import type { RenderViaLlmResult } from '../../../recap/llm-shared.ts';
import { renderPrDeterministic } from '../../../recap/pr/index.ts';
import { renderPrViaLlm } from '../../../recap/pr/llm.ts';
import { type RecapScopeOption, projectRecap } from '../../../recap/projection.ts';
import { CHANGELOG_PROMPT_VERSION } from '../../../recap/prompts/changelog-v1.ts';
import { PR_PROMPT_VERSION } from '../../../recap/prompts/pr-v1.ts';
import { SLACK_PROMPT_VERSION } from '../../../recap/prompts/slack-v1.ts';
import { TERSE_PROMPT_VERSION } from '../../../recap/prompts/terse-v1.ts';
import { renderHuman, renderJson } from '../../../recap/render.ts';
import { renderSlackDeterministic } from '../../../recap/slack/index.ts';
import { renderSlackViaLlm } from '../../../recap/slack/llm.ts';
import { renderTerseDeterministic } from '../../../recap/terse/index.ts';
import { renderTerseViaLlm } from '../../../recap/terse/llm.ts';
import type { RecapIntermediate } from '../../../recap/types.ts';
import {
  canonicalScopeHash,
  readRecapCache,
  writeRecapCache,
} from '../../../storage/repos/recap-cache.ts';
import { recordRecapRun } from '../../../storage/repos/recap-runs.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const DEFAULT_STEP_LIMIT = 10;

type RecapFormat = 'human' | 'json' | 'pr' | 'changelog' | 'slack' | 'terse';

type LlmRendererName = 'pr' | 'changelog' | 'slack' | 'terse';

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

// Subcommands that the parser recognizes as renderer / scope
// labels. `pr`, `changelog`, `slack`, `terse` route through the
// LLM pipeline; `json` is always deterministic.
const RENDERER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'json',
  'pr',
  'changelog',
  'slack',
  'terse',
]);

const FUTURE_SUBCOMMANDS: ReadonlySet<string> = new Set(['day', 'range', 'pre-compact', 'list']);

const futureSubcommandMessage = (sub: string): string => {
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
  const head0 = positional[0];
  if (head0 !== undefined && RENDERER_SUBCOMMANDS.has(head0)) {
    format = head0 as RecapFormat;
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
    error: `/recap: unknown subcommand '${head ?? ''}' (try /recap, /recap last <N>, /recap session <id>, /recap json|pr|changelog|slack|terse)`,
  };
};

const renderToNotes = (text: string): string[] => {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
};

// Write recap output to the requested path. Creates parent
// directories as needed. Awaits Bun.write so a slow disk does not
// let the slash return "wrote ..." before the file is flushed;
// awaiting also surfaces write errors (EACCES, ENOSPC, etc.)
// instead of dropping them in an unobserved Promise rejection.
const writeOutFile = async (outPath: string, content: string): Promise<void> => {
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, content);
};

// Dispatch table for LLM-capable renderers. Each entry pairs a
// deterministic fallback with the LLM render function and the
// prompt version label that audit / cache rows record. Adding a
// new renderer is one entry here plus its module under
// `src/recap/<name>/` and its 5 goldens; the slash plumbing
// generalizes over the table.
interface LlmRendererSpec {
  promptVersion: string;
  deterministic: (intermediate: RecapIntermediate) => string;
  llm: (input: {
    intermediate: RecapIntermediate;
    provider: Provider;
    promptVersion: string;
  }) => Promise<RenderViaLlmResult<unknown>>;
}

const LLM_RENDERER_DISPATCH: Record<LlmRendererName, LlmRendererSpec> = {
  pr: {
    promptVersion: PR_PROMPT_VERSION,
    deterministic: (i) => renderPrDeterministic(i),
    llm: (input) =>
      renderPrViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  changelog: {
    promptVersion: CHANGELOG_PROMPT_VERSION,
    deterministic: (i) => renderChangelogDeterministic(i),
    llm: (input) =>
      renderChangelogViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  slack: {
    promptVersion: SLACK_PROMPT_VERSION,
    deterministic: (i) => renderSlackDeterministic(i),
    llm: (input) =>
      renderSlackViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  terse: {
    promptVersion: TERSE_PROMPT_VERSION,
    deterministic: (i) => renderTerseDeterministic(i),
    llm: (input) =>
      renderTerseViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
};

const isLlmRenderer = (format: RecapFormat): format is LlmRendererName =>
  format === 'pr' || format === 'changelog' || format === 'slack' || format === 'terse';

const renderForFormat = (format: RecapFormat, intermediate: RecapIntermediate): string => {
  if (format === 'json') return renderJson(intermediate);
  if (isLlmRenderer(format)) return LLM_RENDERER_DISPATCH[format].deterministic(intermediate);
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

const deterministicOutcome = (output: string): RenderOutcome => ({
  output,
  usedLlm: false,
  cacheHit: false,
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  promptVersion: null,
});

const renderWithLlmOrFallback = async (
  parsed: ParsedRecap,
  intermediate: RecapIntermediate,
  ctx: SlashContext,
): Promise<RenderOutcome> => {
  // Non-LLM renderers (human, json) and explicit opt-out always
  // take the deterministic template path.
  if (!isLlmRenderer(parsed.format) || parsed.noLlmRender) {
    return deterministicOutcome(renderForFormat(parsed.format, intermediate));
  }

  const provider = ctx.baseConfig.provider;
  // Provider can't constrain output natively → straight to the
  // renderer's deterministic fallback. No warn — the operator did
  // not opt into the LLM path explicitly; they just chose
  // `/recap <renderer>` and we silently degrade.
  if (provider.capabilities.constrained === false) {
    return deterministicOutcome(LLM_RENDERER_DISPATCH[parsed.format].deterministic(intermediate));
  }

  const dispatch = LLM_RENDERER_DISPATCH[parsed.format];
  const scopeHash = canonicalScopeHash({
    scopeKind: intermediate.scope.kind,
    sessionIds: intermediate.scope.sessionIds,
    renderer: parsed.format,
    promptVersion: dispatch.promptVersion,
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
      promptVersion: dispatch.promptVersion,
    };
  }

  const result = await dispatch.llm({
    intermediate,
    provider,
    promptVersion: dispatch.promptVersion,
  });
  if (!result.ok) {
    ctx.bus.emit({
      type: 'warn',
      ts: ctx.now(),
      message: `/recap ${parsed.format}: LLM render failed (${result.reason}: ${result.detail}); using deterministic fallback`,
    });
    return deterministicOutcome(dispatch.deterministic(intermediate));
  }

  // Successful LLM render — write to cache for the next caller.
  // A cache write failure must not destroy the render the operator
  // is about to receive; warn and continue.
  try {
    writeRecapCache(ctx.db, {
      scopeHash,
      renderer: parsed.format,
      output: result.output,
      promptVersion: dispatch.promptVersion,
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
      message: `/recap ${parsed.format}: cache write failed (${reason}); render was returned`,
    });
  }

  return {
    output: result.output,
    usedLlm: true,
    cacheHit: false,
    costUsd: result.costUsd,
    tokensIn: result.usage.input + result.usage.cache_read + result.usage.cache_creation,
    tokensOut: result.usage.output,
    promptVersion: dispatch.promptVersion,
  };
};
