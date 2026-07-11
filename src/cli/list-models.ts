// `forja --list-models` handler. Independent of bootstrap (no provider,
// no permissions, no DB — only the operator catalog file) so inspecting
// the installed models needs no API key and no session. Mirrors the
// structure of `runMemoryCli` / `runListSessions`.
//
// Prints every entry in `~/.config/forja/model_providers.json` with its
// capabilities (context window, max output, price per-1M) and whether it
// is READY to use (its `api_key_env` is set, or it needs no key). The
// built-in default model is starred. `--json` emits NDJSON: one object
// per model, then a `{ count, ready_count }` summary line.
//
// Two deliberate honesty rules:
//   - Readiness is key-PRESENCE only, and it does NOT probe a local Ollama
//     daemon — that stays a reactive error at generate time (a listing
//     shouldn't hang on a network/daemon check). A missing `api_key_env`
//     counts as "ready" ONLY for a local keyless family (ollama / llama_cpp);
//     an SDK-backed family without one still needs a key from an
//     adapter-default env we can't name or verify here, so it shows
//     `needs key` rather than a false `ready`.
//   - Pricing values are dollars-per-MILLION tokens despite the
//     `cost_per_1k_*` field names (see `<family>/capabilities.ts`), so the
//     display and the JSON label them `/1M` (`cost_per_1m_*`).

// Import from the SDK-free catalog modules directly, NOT the `../providers`
// barrel — that barrel statically re-exports the provider adapters
// (`createAnthropicProvider` → `@anthropic-ai/sdk`, …), which would drag the
// SDK graph into this catalog-only command and defeat its point. catalog-io
// is deliberately SDK-free; cost-format / default-model / slash-format carry
// no runtime deps. This is what lets the command dispatch from index.ts
// (before run.ts's harness/storage graph) and survive a partial install.
import { loadModelProvidersFile } from '../providers/catalog-io.ts';
import { isUnmetered, UNMETERED_LABEL } from '../providers/cost-format.ts';
import { DEFAULT_MODEL } from '../providers/default-model.ts';
import type { ModelProviderEntry } from '../providers/types.ts';
import { formatCost } from './slash/format.ts';

export interface ListModelsCliInput {
  json: boolean;
  // Test seam; defaults to process.env. Threads FORJA_PROFILE / XDG for
  // the catalog path AND the api_key_env readiness lookup, so both read
  // the same environment.
  env?: NodeJS.ProcessEnv;
  // Output sinks. Same stdout-pure / stderr-for-logs split spec §2.6
  // mandates: the model table/NDJSON goes to `out`, diagnostics to `err`.
  out: (s: string) => void;
  err: (s: string) => void;
}

interface ModelRow {
  id: string;
  family: string;
  modelName: string;
  contextWindow: number;
  outputMaxTokens: number;
  unmetered: boolean;
  costInPer1m: number;
  costOutPer1m: number;
  apiKeyEnv: string | undefined;
  baseUrl: string | undefined;
  ready: boolean;
  isDefault: boolean;
}

// Families that run locally with NO API key. A missing `api_key_env` means
// "no key needed" only for these; for an SDK-backed family the adapter falls
// back to its own default env (types.ts §ModelProviderEntry) — a key this
// catalog-only view can neither name nor verify — so a keyless SDK-backed
// entry must NOT be reported ready (selecting it would fail at boot/generate).
const KEYLESS_FAMILIES: ReadonlySet<string> = new Set(['ollama', 'llama_cpp']);

const isReady = (entry: ModelProviderEntry, env: NodeJS.ProcessEnv): boolean => {
  if (entry.api_key_env === undefined) {
    // Keyless: genuinely ready only for a local keyless family. We do not
    // probe the daemon — reachability surfaces reactively at generate time.
    return KEYLESS_FAMILIES.has(entry.family);
  }
  const value = env[entry.api_key_env];
  return value !== undefined && value.length > 0;
};

const toRow = (entry: ModelProviderEntry, env: NodeJS.ProcessEnv): ModelRow => ({
  id: entry.id,
  family: entry.family,
  modelName: entry.model_name,
  contextWindow: entry.capabilities.context_window,
  outputMaxTokens: entry.capabilities.output_max_tokens,
  unmetered: isUnmetered(entry),
  costInPer1m: entry.capabilities.cost_per_1k_input,
  costOutPer1m: entry.capabilities.cost_per_1k_output,
  apiKeyEnv: entry.api_key_env,
  baseUrl: entry.base_url,
  ready: isReady(entry, env),
  isDefault: entry.id === DEFAULT_MODEL,
});

const statusText = (r: ModelRow): string => {
  // Keyless local family → ready (local); keyless SDK-backed family → its
  // key comes from an adapter-default env we can't confirm, so `needs key`.
  if (r.apiKeyEnv === undefined) return r.ready ? 'ready (local)' : 'needs key';
  return r.ready ? 'ready' : `needs ${r.apiKeyEnv}`;
};

// `unmetered` (e.g. Ollama Cloud) renders the honest label rather than a
// misleading `$0` — the values are 0 because cost is untracked, not free.
const priceText = (r: ModelRow): string =>
  r.unmetered ? UNMETERED_LABEL : `${formatCost(r.costInPer1m)} / ${formatCost(r.costOutPer1m)}`;

const writeTable = (rows: ModelRow[], out: (s: string) => void): void => {
  if (rows.length === 0) {
    // Unreachable in practice — loadModelProvidersFile hard-errors on an
    // empty catalog — but keep the branch so the renderer is total.
    out('no models in catalog.\n');
    return;
  }
  const header = ['MODEL', 'CTX', 'MAX-OUT', 'PRICE/1M (in/out)', 'STATUS'];
  const cells = rows.map((r) => [
    `${r.id}${r.isDefault ? ' *' : ''}`,
    r.contextWindow.toLocaleString('en-US'),
    r.outputMaxTokens.toLocaleString('en-US'),
    priceText(r),
    statusText(r),
  ]);
  // No shared table helper exists (raw-ANSI house style); compute column
  // widths locally and padEnd, like the other CLI tables (list-sessions,
  // checkpoints). Unlike those fixed-width tables, widths here are derived
  // from the data so long ids / prices don't clip.
  const widths = new Array<number>(header.length).fill(0);
  for (let i = 0; i < header.length; i++) {
    let w = header[i]?.length ?? 0;
    for (const c of cells) w = Math.max(w, c[i]?.length ?? 0);
    widths[i] = w;
  }
  const fmt = (row: string[]): string =>
    row
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  out(`${fmt(header)}\n`);
  for (const c of cells) out(`${fmt(c)}\n`);
  if (rows.some((r) => r.isDefault)) {
    out('\n* default model (used when no --model flag or config override is set)\n');
  }
};

interface ModelJson {
  id: string;
  family: string;
  model_name: string;
  context_window: number;
  output_max_tokens: number;
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  unmetered: boolean;
  api_key_env?: string;
  base_url?: string;
  ready: boolean;
  default: boolean;
}

const toJson = (r: ModelRow): ModelJson => {
  const o: ModelJson = {
    id: r.id,
    family: r.family,
    model_name: r.modelName,
    context_window: r.contextWindow,
    output_max_tokens: r.outputMaxTokens,
    cost_per_1m_input: r.costInPer1m,
    cost_per_1m_output: r.costOutPer1m,
    unmetered: r.unmetered,
    ready: r.ready,
    default: r.isDefault,
  };
  // Additive optional fields, omitted when absent (exactOptionalPropertyTypes).
  if (r.apiKeyEnv !== undefined) o.api_key_env = r.apiKeyEnv;
  if (r.baseUrl !== undefined) o.base_url = r.baseUrl;
  return o;
};

export const runListModelsCli = (input: ListModelsCliInput): number => {
  const env = input.env ?? process.env;
  const res = loadModelProvidersFile(env);
  if (!res.ok) {
    // The loader's message already names the file + `forja init` remedy.
    input.err(`forja: ${res.error}\n`);
    return 1;
  }
  for (const w of res.warnings) input.err(`forja: ${w}\n`);
  const rows = res.entries
    .map((e) => toRow(e, env))
    // Cluster by family, then by id, so a family's models read together
    // and the same catalog always lists in the same order.
    .sort((a, b) =>
      a.family === b.family
        ? a.id.localeCompare(b.id, 'en-US')
        : a.family.localeCompare(b.family, 'en-US'),
    );
  if (input.json) {
    for (const r of rows) input.out(`${JSON.stringify(toJson(r))}\n`);
    const readyCount = rows.filter((r) => r.ready).length;
    input.out(`${JSON.stringify({ count: rows.length, ready_count: readyCount })}\n`);
  } else {
    writeTable(rows, input.out);
  }
  return 0;
};
