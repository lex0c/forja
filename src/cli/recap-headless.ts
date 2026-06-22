// `forja recap [args]` — RECAP §9 headless surface. Lets a CI
// pipeline / shell script run `/recap` without entering the REPL.
// When the global `--json` flag is set, emits the four-event
// NDJSON stream the spec defines:
//
//   {"type":"recap_start","scope":{...},"ts":...}
//   {"type":"recap_intermediate","data":{...}}
//   {"type":"recap_render","renderer":"...","output":"..."}
//   {"type":"recap_end","duration_ms":...,"used_llm":...,"cost_usd":...}
//
// Without `--json`, the rendered text is written to stdout
// verbatim (or to `--out PATH` if the recap-side flag is set).
//
// `forja recap list ...` is a special case — `/recap list` already
// emits NDJSON of `recap_mini` rows when `--json` is in its args,
// so the headless handler forwards the operator's `--json` to the
// list-side parser instead of building the four-event envelope
// (the multi-row shape doesn't match the §9 schema).

import type { HarnessConfig } from '../harness/index.ts';
import { createDefaultRegistry } from '../providers/catalog-file.ts';
import type { ModelRegistry } from '../providers/registry.ts';
import type { Provider } from '../providers/types.ts';
import { redactSecretsInIntermediate } from '../recap/format.ts';
import type { DB } from '../storage/db.ts';
import { closeDb, openDb } from '../storage/db.ts';
import { migrate } from '../storage/migrate.ts';
import { defaultDbPath } from '../storage/paths.ts';
import { createBus } from '../tui/bus.ts';
import { createFocusStack } from '../tui/focus-stack.ts';
import { createModalManager } from '../tui/modal-manager.ts';
import { runRecapList, runRecapSession } from './slash/commands/recap.ts';
import type { SlashContext } from './slash/types.ts';

// Headless render-model precedence (RECAP §8.2: `--model` > config >
// session). On `forja recap`, `--model` is consumed top-level and
// folded into the SESSION provider by bootstrap, so it already IS the
// render model — threading `[recap].render_model` on top would
// override the operator's explicit CLI choice. Suppress the config
// value when `--model` was passed; the render then falls back to the
// session provider (= the `--model` model). Pure + exported so the
// precedence rule is unit-tested in one place rather than buried in
// run.ts wiring.
export const headlessRecapRenderModel = (
  argsModel: string | undefined,
  configRenderModel: string | undefined,
): string | undefined => (argsModel !== undefined ? undefined : configRenderModel);

export interface RunRecapHeadlessOptions {
  // Args after `recap` in the CLI, e.g. ['pr', '--no-llm-render'].
  args: string[];
  // Global `--json` toggle (consumed at the subcommand boundary in
  // `args.ts`). Drives whether the four-event NDJSON envelope or
  // plain rendered text goes to stdout.
  json: boolean;
  // Test seams: a custom DB path / preopened handle.
  dbPath?: string;
  dbOverride?: DB;
  // Provider for the LLM render path. Operators with an API key
  // get the LLM-rendered surface; without one, the capability gate
  // (`provider.capabilities.constrained === false`) trips fallback
  // and renders deterministically. The CLI bootstrap supplies the
  // active provider; tests pass stubs.
  provider: Provider;
  // Registry to resolve a `[recap].render_model` override. The caller
  // (run.ts) can inject the catalog-backed registry from a successful
  // bootstrap; absent, this headless/fallback path uses the seed-backed
  // registry — enough to resolve any BUILT-IN render_model. A
  // render_model that is a CUSTOM catalog entry only resolves when the
  // file-backed registry is injected here.
  modelRegistry?: ModelRegistry;
  // Output sinks. Keep separate from process.stdout/stderr so tests
  // can capture without touching globals; the entry-point in
  // `cli/run.ts` wires the real fds.
  out: (s: string) => void;
  err: (s: string) => void;
  // Wall-clock for `recap_start` / `recap_end` events. Defaults to
  // `Date.now`; tests inject a counter to assert the duration math.
  now?: () => number;
  // Optional override for `currentSessionId`. Headless operation
  // has no live REPL, so the default is `() => null` and bare
  // `forja recap` (no `session <id>`) errors with "no active
  // session". Tests can override to drive `session_current`.
  currentSessionId?: () => string | null;
  // Operator's cwd at invocation time. Used by `day` / `range`
  // scopes to filter same-cwd sessions when `--all-projects` is
  // absent (RECAP §6.1 cross-project opt-in). Defaults to
  // `process.cwd()` when not supplied; tests pin a fixture path.
  // Without this, the headless stub HarnessConfig has no `cwd`
  // and the projection silently drops the cwd filter — fanning
  // out cross-project even though the operator did not pass
  // `--all-projects`.
  cwd?: string;
  // Recap master switch (RECAP §3.2/§3.3) and render-model default
  // (§8.2), threaded from the bootstrap-resolved HarnessConfig.
  // Without these the headless surface would ignore
  // `[recap].enabled=false` / `--no-recap` (still LLM-render) and
  // `[recap].render_model` — the REPL honors them, headless must too.
  recapEnabled?: boolean;
  recapRenderModel?: string;
}

const buildHeadlessContext = (options: RunRecapHeadlessOptions, db: DB): SlashContext => {
  const bus = createBus();
  // Forward `warn` events to the error sink so the operator sees
  // cache-write / audit failures without losing them. `error`
  // events go the same way; everything else is dropped (the
  // headless path doesn't render TUI status).
  bus.onAny((event) => {
    if (event.type === 'warn' || event.type === 'error') {
      options.err(`forja recap: ${event.type}: ${event.message}\n`);
    }
  });
  const focusStack = createFocusStack();
  const now = options.now ?? Date.now;
  // Minimal HarnessConfig — `provider` drives the LLM render
  // path; `cwd` drives the cwd filter for `day` / `range` scopes
  // (RECAP §6.1: without an explicit cwd here, the projection
  // would silently drop the filter and fan out cross-project,
  // bypassing the `--all-projects` opt-in guard).
  const cwd = options.cwd ?? process.cwd();
  const baseConfig = {
    provider: options.provider,
    cwd,
    // Carry the recap knobs so `/recap --model` / `[recap].enabled`
    // behave identically to the REPL (omitted → loop/render apply the
    // `!== false` default-on and session-provider fallback).
    ...(options.recapEnabled !== undefined ? { recapEnabled: options.recapEnabled } : {}),
    ...(options.recapRenderModel !== undefined
      ? { recapRenderModel: options.recapRenderModel }
      : {}),
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager: createModalManager({ bus, focusStack, now }),
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now,
    requestShutdown: () => undefined,
    isRunning: () => false,
    currentSessionId: options.currentSessionId ?? (() => null),
    replSessionIds: () => [],
    // Resolve a `[recap].render_model` override headless. Use the
    // injected catalog-backed registry when present; else seed-backed
    // (auxiliary/fallback path — see the options field).
    modelRegistry: options.modelRegistry ?? createDefaultRegistry(),
  };
};

const writeNdjsonLine = (out: (s: string) => void, payload: unknown): void => {
  out(`${JSON.stringify(payload)}\n`);
};

export const runRecapHeadless = async (options: RunRecapHeadlessOptions): Promise<number> => {
  const dbPath = options.dbPath ?? defaultDbPath();
  const db = options.dbOverride ?? openDb(dbPath);
  const ownsDb = options.dbOverride === undefined;
  const now = options.now ?? Date.now;
  try {
    if (ownsDb) migrate(db);

    const ctx = buildHeadlessContext(options, db);
    const startTs = now();

    // `/recap list` is multi-row and has its own NDJSON shape (one
    // line per `recap_mini`). Forward the operator's `--json` to
    // the list parser when set; the slash already emits the right
    // envelope for that surface, distinct from the §9 four-event
    // stream which is session-scoped.
    if (options.args[0] === 'list') {
      const listArgs = options.json ? [...options.args.slice(1), '--json'] : options.args.slice(1);
      const result = await runRecapList(listArgs, ctx);
      if (result.kind === 'error') {
        options.err(`/recap: ${result.message}\n`);
        return 1;
      }
      if (result.kind === 'ok' && result.notes) {
        for (const line of result.notes) options.out(`${line}\n`);
      }
      return 0;
    }

    // Session-scope render. The slash exec wraps `runRecapSession`
    // in a SlashResult; headless calls the underlying function so
    // the intermediate is available to emit `recap_intermediate`.
    const result = await runRecapSession(options.args, ctx);
    if (result.kind === 'error') {
      options.err(`/recap: ${result.message}\n`);
      return 1;
    }

    if (options.json) {
      // §6.2 privacy guarantee: the `recap_intermediate` event
      // carries the full structured shape, which would leak raw
      // `$HOME/...` paths and secret-shaped tokens (e.g.,
      // `sk-ant-...` pasted into a goal text). The slash json
      // renderer applies the same redaction pass via
      // `renderJson`; the headless NDJSON envelope MUST do the
      // same. The rendered output (`recap_render`) is already
      // redacted by its template, so it stays untouched.
      const redactedIntermediate = redactSecretsInIntermediate(result.intermediate);
      writeNdjsonLine(options.out, {
        type: 'recap_start',
        scope: redactedIntermediate.scope,
        ts: startTs,
      });
      writeNdjsonLine(options.out, {
        type: 'recap_intermediate',
        data: redactedIntermediate,
      });
      writeNdjsonLine(options.out, {
        type: 'recap_render',
        renderer: result.format,
        output: result.output,
      });
      writeNdjsonLine(options.out, {
        type: 'recap_end',
        duration_ms: now() - startTs,
        used_llm: result.usedLlm,
        cost_usd: result.costUsd,
        // The ACTUAL render model's metering — which can differ from the session/boot
        // provider via `--model` / `[recap].render_model` — carried out of the render
        // path. Untracked-not-free when that model is unmetered (e.g. Ollama Cloud).
        unmetered: result.unmetered,
      });
      return 0;
    }

    // Plain text mode. When `--out` is set, the slash already
    // wrote the file inside `runRecapSession`; surface the same
    // confirmation line the REPL would. Otherwise stream the
    // rendered output verbatim (templates already end with a
    // single trailing newline; preserve it).
    if (result.outPath !== null) {
      options.out(`/recap: wrote ${result.format} render to ${result.outPath}\n`);
    } else {
      options.out(result.output);
      if (!result.output.endsWith('\n')) options.out('\n');
    }
    return 0;
  } finally {
    if (ownsDb) closeDb(db);
  }
};
