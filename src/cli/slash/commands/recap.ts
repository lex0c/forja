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
import { isRecapEnabled } from '../../../harness/types.ts';
import { resolveProviderFromId } from '../../../providers/resolve.ts';
import type { Provider } from '../../../providers/types.ts';
import { renderChangelogDeterministic } from '../../../recap/changelog/index.ts';
import { renderChangelogViaLlm } from '../../../recap/changelog/llm.ts';
import {
  type RenderOptions,
  anonymize,
  anonymizeText,
  formatDuration,
  redactSecrets,
  resolveHome,
} from '../../../recap/format.ts';
import { renderHumanDeterministic } from '../../../recap/human/index.ts';
import { renderHumanViaLlm } from '../../../recap/human/llm.ts';
import type { RenderViaLlmResult } from '../../../recap/llm-shared.ts';
import {
  RECAP_MINI_SCHEMA_VERSION,
  type RecapMini,
  projectRecapMini,
  validateRecapMini,
} from '../../../recap/mini/index.ts';
import { renderPrDeterministic } from '../../../recap/pr/index.ts';
import { renderPrViaLlm } from '../../../recap/pr/llm.ts';
import { type RecapScopeOption, projectRecap } from '../../../recap/projection.ts';
import { CHANGELOG_PROMPT_VERSION } from '../../../recap/prompts/changelog-v1.ts';
import { HUMAN_PROMPT_VERSION } from '../../../recap/prompts/human-v1.ts';
import { PR_PROMPT_VERSION } from '../../../recap/prompts/pr-v1.ts';
import { SLACK_PROMPT_VERSION } from '../../../recap/prompts/slack-v1.ts';
import { TERSE_PROMPT_VERSION } from '../../../recap/prompts/terse-v1.ts';
import { renderJson } from '../../../recap/render.ts';
import { renderSlackDeterministic } from '../../../recap/slack/index.ts';
import { renderSlackViaLlm } from '../../../recap/slack/llm.ts';
import { renderTerseDeterministic } from '../../../recap/terse/index.ts';
import { renderTerseViaLlm } from '../../../recap/terse/llm.ts';
import type { RecapIntermediate } from '../../../recap/types.ts';
import {
  canonicalScopeHash,
  readRecapCache,
  recapMiniCacheKey,
  writeRecapCache,
} from '../../../storage/repos/recap-cache.ts';
import { recordRecapRun } from '../../../storage/repos/recap-runs.ts';
import { listSessions } from '../../../storage/repos/sessions.ts';
import type { Session, SessionStatus } from '../../../storage/repos/sessions.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const DEFAULT_STEP_LIMIT = 10;

type RecapFormat = 'human' | 'json' | 'pr' | 'changelog' | 'slack' | 'terse';

type LlmRendererName = 'human' | 'pr' | 'changelog' | 'slack' | 'terse';

interface ParsedRecap {
  format: RecapFormat;
  scope:
    | { kind: 'session_current'; limit: number }
    | { kind: 'session_specific'; sessionId: string }
    // `cwd: null` carries `--all-projects`; the slash exec
    // resolves the literal cwd from `ctx.baseConfig.cwd` only
    // when the operator did NOT opt into the cross-project
    // surface (RECAP §6.1: cross-project recap is opt-in).
    | { kind: 'day'; cwd: string | null; date: string }
    | { kind: 'range'; cwd: string | null; start: number; end: number }
    // Pre-compact preview (RECAP §1, §8.1, §10). The scope shape
    // carries no sessionId — `runRecapSession` resolves it from
    // `ctx.currentSessionId()` like `session_current` does. The
    // intent of `/recap pre-compact` is "show me what would be
    // folded if compaction triggered NOW", so the active session
    // is the only meaningful target; the spec example takes no
    // explicit session argument.
    | { kind: 'pre_compact' };
  noLlmRender: boolean;
  outPath: string | null;
  // Set when `--all-projects` was passed. Honored only by `day` /
  // `range` scopes; emitted as a parse error on every other form
  // (single-session recaps have nothing to fan out across).
  allProjects: boolean;
  // `--model <id>` override for the LLM render (RECAP §8.2).
  // undefined → render uses `[recap].render_model` config, else the
  // session provider. Ignored on deterministic / `--no-llm-render`.
  renderModel: string | undefined;
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

// Reserved subcommands that the parser recognizes but does not
// yet route. Empty today — kept as a stub so future hand-offs
// (e.g., a follow-up that lifts `pre-compact` out of the slash
// path into a Context Engine hook) have a place to land an
// "M4.x; not yet available" message without rewriting the parser.
const FUTURE_SUBCOMMANDS: ReadonlySet<string> = new Set();

const futureSubcommandMessage = (sub: string): string =>
  `/recap: '${sub}' is reserved but not yet wired`;

interface FlagSplit {
  positional: string[];
  noLlmRender: boolean;
  outPath: string | null;
  allProjects: boolean;
  renderModel: string | undefined;
  flagError: string | null;
}

// Pull recognized flags out of the raw arg list before subcommand
// parsing. Keeps the subcommand parsers (which were already shipped
// in M4.1) ignorant of M4.2's render-mode toggles.
const splitFlags = (args: string[]): FlagSplit => {
  const positional: string[] = [];
  let noLlmRender = false;
  let outPath: string | null = null;
  let allProjects = false;
  let renderModel: string | undefined;
  const flagError: string | null = null;
  const fail = (msg: string): FlagSplit => ({
    positional,
    noLlmRender,
    outPath,
    allProjects,
    renderModel,
    flagError: msg,
  });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-llm-render') {
      noLlmRender = true;
      continue;
    }
    if (arg === '--all-projects') {
      // Cross-project opt-in (RECAP §6.1). Only meaningful for
      // `day` / `range` scopes; the parser surfaces an error
      // when paired with any other form so an operator typing
      // `/recap pr --all-projects` learns the flag has no effect
      // there instead of silently being ignored.
      allProjects = true;
      continue;
    }
    if (arg === '--out') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return fail('/recap: --out requires a file path');
      }
      // Refuse a flag-shaped next token (`--something` or `-x`).
      // Without this gate, `/recap pr --out --no-llm-render` would
      // treat `--no-llm-render` as the filename, write to a file
      // literally named that, AND silently drop the operator's
      // intended `--no-llm-render` toggle. Operators with paths
      // that legitimately start with `-` can use the `--out=` form
      // to disambiguate.
      if (next.startsWith('-')) {
        return fail(
          `/recap: --out received a flag-shaped value '${next}'; pass a file path or use --out=<path> to disambiguate`,
        );
      }
      outPath = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--out=') === true) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) return fail('/recap: --out= requires a file path');
      outPath = value;
      continue;
    }
    if (arg === '--model') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0 || next.startsWith('-')) {
        return fail('/recap: --model requires a model id (e.g. anthropic/claude-haiku-4-5)');
      }
      renderModel = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--model=') === true) {
      const value = arg.slice('--model='.length);
      if (value.length === 0) return fail('/recap: --model= requires a model id');
      renderModel = value;
      continue;
    }
    if (arg?.startsWith('--') === true) {
      return fail(`/recap: unknown flag '${arg}'`);
    }
    if (arg !== undefined) positional.push(arg);
  }
  return { positional, noLlmRender, outPath, allProjects, renderModel, flagError };
};

// YYYY-MM-DD strict parse → epoch ms at UTC midnight. Mirrors the
// shape `dayBoundsUtc` (in `recap/projection.ts`) parses; a
// permissive `Date.UTC` accepts month=13 as "next year", so we
// round-trip through `Date` to reject those.
const parseYyyyMmDdToMs = (raw: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ts = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const back = new Date(ts);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ts;
};

// Today UTC, midnight. Default for `/recap day` with no argument.
const todayUtcDate = (now: number): string => {
  const d = new Date(now);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const parseRecapArgs = (
  args: string[],
  options: { now: number },
): ParsedRecap | { error: string } => {
  const split = splitFlags(args);
  if (split.flagError !== null) return { error: split.flagError };
  const positional = split.positional;
  const baseExtras = {
    noLlmRender: split.noLlmRender,
    outPath: split.outPath,
    allProjects: split.allProjects,
    renderModel: split.renderModel,
  };
  if (positional.length === 0) {
    if (split.allProjects) {
      return {
        error: '/recap: --all-projects only applies to `day` / `range` scopes',
      };
    }
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
    if (split.allProjects) {
      return {
        error: '/recap: --all-projects only applies to `day` / `range` scopes',
      };
    }
    return {
      format,
      scope: { kind: 'session_current', limit: DEFAULT_STEP_LIMIT },
      ...baseExtras,
    };
  }
  const head = positional[i];
  if (head === 'last') {
    if (split.allProjects) {
      return {
        error: '/recap: --all-projects only applies to `day` / `range` scopes',
      };
    }
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
    if (split.allProjects) {
      return {
        error: '/recap: --all-projects only applies to `day` / `range` scopes',
      };
    }
    const next = positional[i + 1];
    if (next === undefined || next.length === 0) {
      return { error: '/recap session: missing session id' };
    }
    if (i + 2 < positional.length) {
      return { error: '/recap session: takes exactly one argument (the session id)' };
    }
    return { format, scope: { kind: 'session_specific', sessionId: next }, ...baseExtras };
  }
  if (head === 'day') {
    // Optional date arg; defaults to today UTC. Validation
    // (round-trip check) catches `2026-02-31` and similar.
    const next = positional[i + 1];
    const date = next === undefined ? todayUtcDate(options.now) : next;
    if (parseYyyyMmDdToMs(date) === null) {
      return {
        error: `/recap day: invalid date '${date}' (expected YYYY-MM-DD)`,
      };
    }
    if (next !== undefined && i + 2 < positional.length) {
      return { error: '/recap day: takes at most one argument (YYYY-MM-DD)' };
    }
    return {
      format,
      scope: { kind: 'day', cwd: null, date },
      ...baseExtras,
    };
  }
  if (head === 'pre-compact') {
    if (split.allProjects) {
      return {
        error: '/recap: --all-projects only applies to `day` / `range` scopes',
      };
    }
    if (i + 1 < positional.length) {
      return { error: '/recap pre-compact: takes no arguments' };
    }
    // Force the deterministic path. RECAP §10 anti-pattern: the
    // pre-compact view sits on the critical path in front of the
    // compaction call, and the §8.1 latency target is < 200ms —
    // a Haiku call would blow that. Override `--no-llm-render` to
    // true regardless of what the operator passed; the spec is
    // unambiguous (§10) and ignoring the override would let a
    // future `--no-llm-render=false` flag shape leak the LLM into
    // the path.
    return {
      format,
      scope: { kind: 'pre_compact' },
      ...baseExtras,
      noLlmRender: true,
    };
  }
  if (head === 'range') {
    const fromArg = positional[i + 1];
    const toArg = positional[i + 2];
    if (fromArg === undefined || toArg === undefined) {
      return {
        error: '/recap range: requires <from> <to> in YYYY-MM-DD form',
      };
    }
    const fromMs = parseYyyyMmDdToMs(fromArg);
    const toMs = parseYyyyMmDdToMs(toArg);
    if (fromMs === null) {
      return { error: `/recap range: invalid <from> '${fromArg}' (expected YYYY-MM-DD)` };
    }
    if (toMs === null) {
      return { error: `/recap range: invalid <to> '${toArg}' (expected YYYY-MM-DD)` };
    }
    // Right-open interval: <to> is the day-bound day's end. Bumping
    // by 24h converts the operator's inclusive-day input into the
    // half-open `[start, end)` shape `listSessionsInRange` expects.
    const endMs = toMs + 24 * 60 * 60 * 1000;
    if (endMs <= fromMs) {
      return { error: '/recap range: <to> must be on or after <from>' };
    }
    if (i + 3 < positional.length) {
      return { error: '/recap range: takes exactly two arguments' };
    }
    return {
      format,
      scope: { kind: 'range', cwd: null, start: fromMs, end: endMs },
      ...baseExtras,
    };
  }
  if (head !== undefined && FUTURE_SUBCOMMANDS.has(head)) {
    return { error: futureSubcommandMessage(head) };
  }
  return {
    error: `/recap: unknown subcommand '${head ?? ''}' (try /recap, /recap last <N>, /recap session <id>, /recap day, /recap range, /recap json|pr|changelog|slack|terse)`,
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
  deterministic: (intermediate: RecapIntermediate, options: RenderOptions) => string;
  llm: (input: {
    intermediate: RecapIntermediate;
    provider: Provider;
    promptVersion: string;
    templateOptions: RenderOptions;
  }) => Promise<RenderViaLlmResult<unknown>>;
}

const LLM_RENDERER_DISPATCH: Record<LlmRendererName, LlmRendererSpec> = {
  human: {
    promptVersion: HUMAN_PROMPT_VERSION,
    deterministic: (i, opts) => renderHumanDeterministic(i, opts),
    llm: (input) =>
      renderHumanViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
        templateOptions: input.templateOptions,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  pr: {
    promptVersion: PR_PROMPT_VERSION,
    deterministic: (i, opts) => renderPrDeterministic(i, opts),
    llm: (input) =>
      renderPrViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
        templateOptions: input.templateOptions,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  changelog: {
    promptVersion: CHANGELOG_PROMPT_VERSION,
    deterministic: (i, opts) => renderChangelogDeterministic(i, opts),
    llm: (input) =>
      renderChangelogViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
        templateOptions: input.templateOptions,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  slack: {
    promptVersion: SLACK_PROMPT_VERSION,
    deterministic: (i, opts) => renderSlackDeterministic(i, opts),
    llm: (input) =>
      renderSlackViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
        templateOptions: input.templateOptions,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
  terse: {
    promptVersion: TERSE_PROMPT_VERSION,
    deterministic: (i, opts) => renderTerseDeterministic(i, opts),
    llm: (input) =>
      renderTerseViaLlm({
        intermediate: input.intermediate,
        provider: input.provider,
        promptVersion: input.promptVersion,
        templateOptions: input.templateOptions,
      }) as Promise<RenderViaLlmResult<unknown>>,
  },
};

const isLlmRenderer = (format: RecapFormat): format is LlmRendererName =>
  format === 'human' ||
  format === 'pr' ||
  format === 'changelog' ||
  format === 'slack' ||
  format === 'terse';

// Build the render options from the projected intermediate. Threads
// `incomplete` so every renderer prepends the §10 callout when the
// projected session is non-terminal. JSON renderer does not consume
// `RenderOptions` (it emits raw structure); but `incomplete` is
// already inside `intermediate.completeness` and surfaces in the
// JSON output by virtue of the schema itself.
const buildRenderOptions = (intermediate: RecapIntermediate): RenderOptions => {
  const completeness = intermediate.completeness;
  if (!completeness.incomplete) return {};
  return {
    incomplete: {
      reason: completeness.incompleteReason,
      sessionIds: completeness.incompleteSessions,
    },
  };
};

const renderForFormat = (
  format: RecapFormat,
  intermediate: RecapIntermediate,
  options: RenderOptions,
): string => {
  if (format === 'json') return renderJson(intermediate);
  // Every other format (human / pr / changelog / slack / terse)
  // routes through the dispatch — `deterministic` per renderer
  // is the canonical "no-LLM" output.
  return LLM_RENDERER_DISPATCH[format].deterministic(intermediate, options);
};

// Result of the session-recap pipeline — exposed for headless
// callers (RECAP §9 NDJSON) that need both the intermediate
// (emit `recap_intermediate`) and the rendered output (emit
// `recap_render`) without re-projecting. The slash command's
// `exec` wraps this in a `SlashResult`; the headless handler
// translates each field into a separate NDJSON event.
export type RunRecapSessionResult =
  | {
      kind: 'ok';
      format: RecapFormat;
      scope: RecapScopeOption;
      intermediate: RecapIntermediate;
      output: string;
      usedLlm: boolean;
      cacheHit: boolean;
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
      promptVersion: string | null;
      outPath: string | null;
    }
  | { kind: 'error'; message: string };

// Session-recap pipeline as a reusable function. Takes the raw
// args (NOT including a leading `list`), runs the same flow the
// slash exec ran before this refactor, and returns a structured
// result. Side effects (`recap_runs` audit row, optional `--out`
// write, bus warns on cache/audit failure) happen inside.
export const runRecapSession = async (
  args: string[],
  ctx: SlashContext,
): Promise<RunRecapSessionResult> => {
  const parsed = parseRecapArgs(args, { now: ctx.now() });
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
  } else if (parsed.scope.kind === 'session_specific') {
    scope = { kind: 'session_specific', sessionId: parsed.scope.sessionId };
  } else if (parsed.scope.kind === 'pre_compact') {
    // `/recap pre-compact` previews the active session before a
    // compaction trigger. The operator hasn't typed an explicit
    // session id; resolve from the REPL's current session.
    const sessionId = ctx.currentSessionId();
    if (sessionId === null) {
      return {
        kind: 'error',
        message:
          '/recap pre-compact: no active session yet (run a turn first to populate the audit log)',
      };
    }
    scope = { kind: 'pre_compact', sessionId };
  } else if (parsed.scope.kind === 'day' || parsed.scope.kind === 'range') {
    // Cross-session scope. The parser left `cwd: null`; resolve
    // it from the harness baseConfig unless the operator explicitly
    // opted into the cross-project surface via `--all-projects`.
    // This is the privacy guard from RECAP §6.1: cross-project
    // recap is opt-in, never automatic.
    const cwdFilter = parsed.allProjects ? null : ctx.baseConfig.cwd;
    if (parsed.scope.kind === 'day') {
      scope = { kind: 'day', cwd: cwdFilter, date: parsed.scope.date };
    } else {
      scope = {
        kind: 'range',
        cwd: cwdFilter,
        start: parsed.scope.start,
        end: parsed.scope.end,
      };
    }
  } else {
    // Exhaustive — `scope.kind` is a union the parser closes over.
    return { kind: 'error', message: '/recap: unreachable scope kind' };
  }

  let intermediate: RecapIntermediate;
  try {
    intermediate = projectRecap(ctx.db, { scope, now: ctx.now() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'error', message: `/recap: ${message}` };
  }

  const renderResult = await renderWithLlmOrFallback(parsed, intermediate, ctx);

  // Attempt the `--out` write first, but DEFER surfacing its
  // failure until after the audit row is recorded. The render has
  // already executed and — on a cache-miss LLM path — already
  // billed tokens; returning early on an `--out` write error
  // without recording would drop that spend from `recap_runs`,
  // the exact under-reporting the audit table exists to prevent.
  let outWriteError: string | null = null;
  if (parsed.outPath !== null) {
    try {
      await writeOutFile(parsed.outPath, renderResult.output);
    } catch (e) {
      outWriteError = e instanceof Error ? e.message : String(e);
    }
  }

  try {
    recordRecapRun(ctx.db, {
      scopeKind: scope.kind,
      sessionIds: intermediate.scope.sessionIds,
      renderer: parsed.format,
      usedLlm: renderResult.usedLlm,
      // Record the path only when the bytes actually landed. A
      // failed `--out` produced no file, so reporting it under
      // `output_path` (RECAP §6.3: "preenchido quando --out")
      // would make the audit row claim an artifact that does not
      // exist.
      outputPath: outWriteError === null ? parsed.outPath : null,
      createdAt: ctx.now(),
      costUsd: renderResult.costUsd,
      tokensIn: renderResult.tokensIn,
      tokensOut: renderResult.tokensOut,
      promptVersion: renderResult.promptVersion,
      cacheHit: renderResult.cacheHit,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    ctx.bus.emit({
      type: 'warn',
      ts: ctx.now(),
      message: `/recap: audit row not written (${reason}); output is intact`,
    });
  }

  // Now that spend is recorded, surface the `--out` failure.
  if (outWriteError !== null) {
    return {
      kind: 'error',
      message: `/recap: failed to write --out '${parsed.outPath}': ${outWriteError}`,
    };
  }

  return {
    kind: 'ok',
    format: parsed.format,
    scope,
    intermediate,
    output: renderResult.output,
    usedLlm: renderResult.usedLlm,
    cacheHit: renderResult.cacheHit,
    costUsd: renderResult.costUsd,
    tokensIn: renderResult.tokensIn,
    tokensOut: renderResult.tokensOut,
    promptVersion: renderResult.promptVersion,
    outPath: parsed.outPath,
  };
};

export const recapCommand: SlashCommand = {
  name: 'recap',
  description: 'projected view over this session (or another by id)',
  argHint: '[list | <session-id>]',
  exec: async (args, ctx: SlashContext): Promise<SlashResult> => {
    // `/recap list` is a different shape entirely — multi-session
    // listing instead of a per-session render. Routed early so the
    // shared `splitFlags` / `parseRecapArgs` pipeline does not have
    // to learn the list-specific filter set.
    if (args[0] === 'list') {
      return await runRecapList(args.slice(1), ctx);
    }
    const result = await runRecapSession(args, ctx);
    if (result.kind === 'error') {
      return { kind: 'error', message: result.message };
    }
    if (result.outPath !== null) {
      return {
        kind: 'ok',
        notes: [`/recap: wrote ${result.format} render to ${result.outPath}`],
      };
    }
    return { kind: 'ok', notes: renderToNotes(result.output) };
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
  const renderOptions = buildRenderOptions(intermediate);
  // Non-LLM renderers (human, json), explicit opt-out, and the
  // `[recap].enabled=false` / `--no-recap` master switch all take
  // the deterministic template path. The master switch makes every
  // `/recap` deterministic (no Haiku/model cost) while keeping the
  // command usable (RECAP §3.2/§3.3 disable contract).
  if (!isLlmRenderer(parsed.format) || parsed.noLlmRender || !isRecapEnabled(ctx.baseConfig)) {
    return deterministicOutcome(renderForFormat(parsed.format, intermediate, renderOptions));
  }

  // Render model: `--model` flag > `[recap].render_model` config >
  // the session's own provider. An unknown id or a factory failure
  // (e.g. missing API key for the override's family) warns and
  // falls back to the session provider — recap never breaks on a
  // bad model id.
  let provider = ctx.baseConfig.provider;
  const overrideId = parsed.renderModel ?? ctx.baseConfig.recapRenderModel;
  if (overrideId !== undefined && overrideId !== provider.id) {
    const resolved = resolveProviderFromId(ctx.modelRegistry, overrideId);
    if (resolved.ok) {
      provider = resolved.provider;
    } else {
      // Unknown id or factory failure (e.g. missing API key for the
      // override's family) → warn and keep the session provider.
      // recap never breaks on a bad model id.
      const why =
        resolved.kind === 'unknown'
          ? 'unknown model'
          : `could not be initialized (${resolved.message})`;
      ctx.bus.emit({
        type: 'warn',
        ts: ctx.now(),
        message: `/recap: --model '${overrideId}' ${why}; rendering with the session model ${provider.id}`,
      });
    }
  }

  // Provider can't constrain output natively → straight to the
  // renderer's deterministic fallback. No warn — the operator did
  // not opt into the LLM path explicitly; they just chose
  // `/recap <renderer>` and we silently degrade.
  if (provider.capabilities.constrained === false) {
    return deterministicOutcome(
      LLM_RENDERER_DISPATCH[parsed.format].deterministic(intermediate, renderOptions),
    );
  }

  const dispatch = LLM_RENDERER_DISPATCH[parsed.format];
  const scopeHash = canonicalScopeHash({
    scopeKind: intermediate.scope.kind,
    sessionIds: intermediate.scope.sessionIds,
    renderer: parsed.format,
    promptVersion: dispatch.promptVersion,
    intermediate,
    // The resolved render model is part of the cache identity —
    // a render produced by model A must not be served to a
    // model-B request.
    modelId: provider.id,
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
    templateOptions: renderOptions,
  });
  if (!result.ok) {
    ctx.bus.emit({
      type: 'warn',
      ts: ctx.now(),
      message: `/recap ${parsed.format}: LLM render failed (${result.reason}: ${result.detail}); using deterministic fallback`,
    });
    const fallbackOutput = dispatch.deterministic(intermediate, renderOptions);
    // Post-call failures (parse / schema / fidelity / concision)
    // billed real tokens before the rejection — the orchestrator
    // surfaces `usage` + `costUsd` on those reasons. Pre-call
    // failures (`capability-missing`, `provider-error`) leave both
    // undefined. Either way the operator sees the deterministic
    // markdown; the audit row records the spend that actually
    // happened so `recap_runs` doesn't under-report.
    if (result.usage !== undefined && result.costUsd !== undefined) {
      return {
        output: fallbackOutput,
        usedLlm: true,
        cacheHit: false,
        costUsd: result.costUsd,
        tokensIn: result.usage.input + result.usage.cache_read + result.usage.cache_creation,
        tokensOut: result.usage.output,
        promptVersion: dispatch.promptVersion,
      };
    }
    return deterministicOutcome(fallbackOutput);
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

// ─── /recap list ─────────────────────────────────────────────────
//
// Multi-session listing surface (RECAP §1, §3.1). Reads top-level
// sessions filtered by --project / --since / --status, projects a
// `RecapMini` per session (cache lookup → deterministic on miss),
// optionally filters in-memory by --search on the goal text, and
// renders either a fixed-width table or NDJSON.
//
// LLM `one_line_summary` (RECAP §3.1: Haiku-rendered) and the
// Stop-hook pre-render (populates `recap_cache` at session-end so
// list reads are <50ms) are pending follow-ups; this slice ships
// the deterministic surface so `/recap list` is functional today.

const VALID_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'running',
  'done',
  'interrupted',
  'exhausted',
  'error',
]);

interface RecapListFilters {
  limit: number;
  project: string | null;
  sinceMs: number | null;
  status: SessionStatus | null;
  search: string | null;
  json: boolean;
  outPath: string | null;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

const parseDateToMs = (raw: string): number | null => {
  // YYYY-MM-DD only — same surface as `/recap day`. Local
  // calendar interpretation would surprise operators in
  // non-UTC zones; UTC midnight is the documented anchor.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ts = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Round-trip check: Date.UTC is permissive (month=13 → next
  // year). Reject inputs that don't survive the round-trip.
  const back = new Date(ts);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ts;
};

const parseRecapListArgs = (args: readonly string[]): RecapListFilters | { error: string } => {
  let limit = DEFAULT_LIST_LIMIT;
  let project: string | null = null;
  let sinceMs: number | null = null;
  let status: SessionStatus | null = null;
  let search: string | null = null;
  let json = false;
  let outPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--limit') {
      const next = args[i + 1];
      const n = next !== undefined ? positiveInt(next) : null;
      if (n === null) return { error: '/recap list: --limit requires a positive integer' };
      if (n > MAX_LIST_LIMIT) {
        return { error: `/recap list: --limit cannot exceed ${MAX_LIST_LIMIT}` };
      }
      limit = n;
      i += 1;
      continue;
    }
    if (arg === '--project') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/recap list: --project requires a path' };
      }
      // Refuse flag-shaped value — see `--out` for the canonical
      // rationale; same defense against silently swallowing the
      // following option. A path that legitimately starts with
      // `-` should be shell-quoted or prefixed (`./--weird-dir`).
      if (next.startsWith('-')) {
        return {
          error: `/recap list: --project received a flag-shaped value '${next}'; pass a path (prefix with './' if it legitimately starts with '-')`,
        };
      }
      project = next;
      i += 1;
      continue;
    }
    if (arg === '--since') {
      const next = args[i + 1];
      if (next === undefined) return { error: '/recap list: --since requires YYYY-MM-DD' };
      const ts = parseDateToMs(next);
      if (ts === null) {
        return {
          error: `/recap list: --since received invalid date '${next}' (expected YYYY-MM-DD)`,
        };
      }
      sinceMs = ts;
      i += 1;
      continue;
    }
    if (arg === '--status') {
      const next = args[i + 1];
      if (next === undefined || !VALID_STATUSES.has(next as SessionStatus)) {
        return {
          error: `/recap list: --status must be one of ${[...VALID_STATUSES].join('|')}`,
        };
      }
      status = next as SessionStatus;
      i += 1;
      continue;
    }
    if (arg === '--search') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/recap list: --search requires a query' };
      }
      // Refuse flag-shaped value (see `--out`). A query that
      // legitimately starts with `-` can be shell-quoted to
      // disambiguate.
      if (next.startsWith('-')) {
        return {
          error: `/recap list: --search received a flag-shaped value '${next}'; quote the query if it legitimately starts with '-'`,
        };
      }
      search = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      const next = args[i + 1];
      if (next === undefined || next.length === 0) {
        return { error: '/recap list: --out requires a file path' };
      }
      // Refuse flag-shaped value — see the session-render parser's
      // `--out` for canonical rationale.
      if (next.startsWith('-')) {
        return {
          error: `/recap list: --out received a flag-shaped value '${next}'; pass a file path or use --out=<path>`,
        };
      }
      outPath = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--out=') === true) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) return { error: '/recap list: --out= requires a file path' };
      outPath = value;
      continue;
    }
    if (arg?.startsWith('--') === true) {
      return { error: `/recap list: unknown flag '${arg}'` };
    }
    return { error: `/recap list: unexpected positional argument '${arg ?? ''}'` };
  }

  return { limit, project, sinceMs, status, search, json, outPath };
};

// Cache lookup → deterministic on miss. Cache writes happen on
// miss so the next call (this run or another) is a hit. A read
// failure (corrupt JSON in the row) falls through to a fresh
// projection — the cache is an optimization, not a correctness
// path.
const projectRecapMiniCached = (ctx: SlashContext, session: Session): RecapMini => {
  const key = recapMiniCacheKey({
    sessionId: session.id,
    status: session.status,
    endedAt: session.endedAt,
    costUsd: session.totalCostUsd,
    promptVersion: RECAP_MINI_SCHEMA_VERSION,
  });
  const cached = readRecapCache(ctx.db, { scopeHash: key, now: ctx.now() });
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached.output) as unknown;
      if (validateRecapMini(parsed).ok) {
        return parsed as RecapMini;
      }
    } catch {
      // fall through to fresh projection
    }
  }
  const fresh = projectRecapMini(ctx.db, { sessionId: session.id, now: ctx.now() });
  // Best-effort write — a cache write failure must not break
  // list. Running sessions don't get cached (the key changes
  // every call as duration ticks); skip the write to avoid
  // hot-row churn.
  if (session.status !== 'running') {
    try {
      writeRecapCache(ctx.db, {
        scopeHash: key,
        renderer: 'mini' as const,
        output: JSON.stringify(fresh),
        promptVersion: RECAP_MINI_SCHEMA_VERSION,
        generatedAt: ctx.now(),
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      });
    } catch {
      // ignore
    }
  }
  return fresh;
};

// `agent --list-sessions` shape: `YYYY-MM-DD HH:MM:SSZ`. ISO 8601
// with explicit Z so operators in non-UTC zones don't misread the
// listing as local time.
const formatListTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.toISOString().replace('T', ' ').slice(0, 19)}Z`;
};

// Apply the same anonymize+redact pass the markdown renderers run
// on free-text fields (RECAP §6.2). The cached `RecapMini` keeps
// the literal bytes (audit consumers reading the cache row need
// the raw cwd / goal); redaction happens only on the rendering
// boundary so the operator never sees `/home/lex/...` paths or
// `sk-ant-...` tokens in the listing.
const redactMiniForOutput = (r: RecapMini): RecapMini => {
  const home = resolveHome(undefined);
  const path = (p: string): string => anonymize(p, home);
  const text = (s: string): string => redactSecrets(anonymizeText(s, home));
  return {
    ...r,
    cwd: path(r.cwd),
    cwdLabel: text(r.cwdLabel),
    goal: text(r.goal),
    oneLineSummary: text(r.oneLineSummary),
  };
};

const renderListTable = (rows: readonly RecapMini[]): string => {
  if (rows.length === 0) return 'no sessions found.\n';
  const lines: string[] = [];
  lines.push(
    'STARTED               STATUS       COST       DURATION  ID                                      SUMMARY',
  );
  for (const raw of rows) {
    const r = redactMiniForOutput(raw);
    const started = formatListTime(r.startedAt);
    const status = r.status.padEnd(12);
    const cost = `$${r.costUsd.toFixed(4)}`.padEnd(10);
    const duration = formatDuration(r.durationMs).padEnd(9);
    const id = r.sessionId.padEnd(40);
    lines.push(`${started}  ${status} ${cost} ${duration} ${id} ${r.oneLineSummary}`);
  }
  lines.push('');
  return lines.join('\n');
};

const renderListJson = (rows: readonly RecapMini[]): string => {
  // NDJSON: one row per line, matching `agent --list-sessions
  // --json` convention. Headless consumers can stream-parse.
  if (rows.length === 0) return '';
  return `${rows.map((r) => JSON.stringify(redactMiniForOutput(r))).join('\n')}\n`;
};

const SEARCH_FETCH_MULTIPLIER = 5;

export const runRecapList = async (
  args: readonly string[],
  ctx: SlashContext,
): Promise<SlashResult> => {
  const filters = parseRecapListArgs(args);
  if ('error' in filters) {
    return { kind: 'error', message: filters.error };
  }

  // SQL-side filtering covers everything that maps to a column
  // predicate (cwd / status / started_at). `--search` is the only
  // filter that can't go to SQL — its needle is the projected
  // goal text, not the raw message JSON.
  //
  // Without --search, one fetch is enough. With --search, paginate
  // until we've collected `limit` matches OR the result set is
  // exhausted. A fixed-size pre-fetch (limit × multiplier) was
  // wrong: a sparse needle (1 match per N sessions) on a long
  // history would yield zero matches in the first batch even
  // though the needle existed deeper, surfacing as a false
  // negative. The pagination cursor is SQL OFFSET — the secondary
  // `(started_at DESC, seq DESC)` order is deterministic so the
  // cursor is stable across batches even with same-millisecond
  // sessions.
  let resultRows: RecapMini[];
  if (filters.search === null) {
    const sessions = listSessions(ctx.db, {
      limit: filters.limit,
      ...(filters.project !== null ? { cwd: filters.project } : {}),
      ...(filters.status !== null ? { status: filters.status } : {}),
      ...(filters.sinceMs !== null ? { startedAtMin: filters.sinceMs } : {}),
    });
    resultRows = sessions.map((s) => projectRecapMiniCached(ctx, s));
  } else {
    const needle = filters.search.toLowerCase();
    const matches: RecapMini[] = [];
    const batchSize = filters.limit * SEARCH_FETCH_MULTIPLIER;
    let offset = 0;
    while (matches.length < filters.limit) {
      const batch = listSessions(ctx.db, {
        limit: batchSize,
        offset,
        ...(filters.project !== null ? { cwd: filters.project } : {}),
        ...(filters.status !== null ? { status: filters.status } : {}),
        ...(filters.sinceMs !== null ? { startedAtMin: filters.sinceMs } : {}),
      });
      if (batch.length === 0) break;
      for (const s of batch) {
        const mini = projectRecapMiniCached(ctx, s);
        if (mini.goal.toLowerCase().includes(needle)) {
          matches.push(mini);
          if (matches.length >= filters.limit) break;
        }
      }
      // Short batch ⇒ source exhausted, no more to scan.
      if (batch.length < batchSize) break;
      offset += batch.length;
    }
    resultRows = matches;
  }

  const output = filters.json ? renderListJson(resultRows) : renderListTable(resultRows);

  if (filters.outPath !== null) {
    try {
      await writeOutFile(filters.outPath, output);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        kind: 'error',
        message: `/recap list: failed to write --out '${filters.outPath}': ${reason}`,
      };
    }
    return {
      kind: 'ok',
      notes: [`/recap list: wrote ${resultRows.length} row(s) to ${filters.outPath}`],
    };
  }

  // The notes channel emits one line per row of the output. JSON
  // mode strips the trailing newline; table mode preserves the
  // header + rows. An empty result returns a single "no sessions
  // found." line in table mode (operator-friendly note), or NO
  // notes at all in JSON mode — emitting a plain-text diagnostic
  // on the NDJSON channel breaks stream parsers (the operator
  // explicitly asked for machine-readable output, so silence on
  // empty is the correct contract; exit code 0 still signals
  // "query ran successfully"). `agent recap list --json` was
  // forwarding the diagnostic to stdout verbatim, polluting the
  // NDJSON envelope with an unparseable first line.
  if (resultRows.length === 0 && filters.json) {
    return { kind: 'ok' };
  }
  const trimmed = output.endsWith('\n') ? output.slice(0, -1) : output;
  return { kind: 'ok', notes: trimmed.split('\n') };
};
