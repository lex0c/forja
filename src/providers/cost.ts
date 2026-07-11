import type { ProviderCapabilities, UsageInfo } from './types.ts';

// Compute USD cost for a single turn given the provider's per-million
// pricing. Field name says `_per_1k_` for legacy reasons (see
// follow-up note below), but every value in the registry is
// expressed in dollars-per-million tokens — the industry
// convention Anthropic, OpenAI, and Google all publish in. The
// math divides by 1_000_000 to match.
//
// Pricing fields on `ProviderCapabilities` are illustrative per spec
// (PROVIDERS.md §5); dynamic pricing config is deferred.
//
// Follow-up: the `cost_per_1k_*` fields should be renamed to
// `cost_per_1m_*` to match reality. Held back from this fix
// because it touches every provider capabilities file and
// PROVIDERS.md; tracked in docs/TODO.md.
//
// Cache semantics:
//  - `cache_read` tokens use `cost_per_1k_cached_input` when declared,
//    otherwise fall through to the regular input rate. Falling back to
//    the input rate overcounts (the read tier is cheaper) but surfaces
//    the missing capability rather than silently zeroing the line item.
//  - `cache_creation` tokens use `cost_per_1k_cache_write` when declared,
//    otherwise also fall through to the regular input rate. This direction
//    *under*counts on Anthropic (their cache writes cost 1.25× input);
//    every Anthropic model in the registry should declare the rate
//    explicitly. The fallback exists so undeclared / non-Anthropic
//    providers (whose cache writes may not have a separate tier) don't
//    crash, not as a substitute for declaring the real number.
// Per-axis cost, so a caller can see WHERE the money went — not just the
// total. Cache write (cache_creation) is the expensive axis: on Anthropic it
// bills ~1.25× input (5-min) or 2× (1-hour), and read bills ~0.1×, so a
// session with a healthy token hit-ratio can still be cost-dominated by cache
// writes. `/stats` renders this to flag a cache-write spike — the symptom of
// a prefix invalidator (reordered tools, a timestamp in the prefix, churned
// memory) silently re-writing the cache every turn.
export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  total: number;
}

export const computeCostBreakdown = (
  caps: ProviderCapabilities,
  usage: UsageInfo,
): CostBreakdown => {
  const inputRate = caps.cost_per_1k_input;
  const outputRate = caps.cost_per_1k_output;
  const cacheReadRate = caps.cost_per_1k_cached_input ?? inputRate;
  const cacheWriteRate = caps.cost_per_1k_cache_write ?? inputRate;
  const inputCost = (usage.input * inputRate) / 1_000_000;
  const outputCost = (usage.output * outputRate) / 1_000_000;
  const cacheReadCost = (usage.cache_read * cacheReadRate) / 1_000_000;
  const cacheWriteCost = (usage.cache_creation * cacheWriteRate) / 1_000_000;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
};

// Total turn cost. Delegates to the breakdown so the rate math lives in ONE
// place — the components and the total can never drift apart.
export const computeCost = (caps: ProviderCapabilities, usage: UsageInfo): number =>
  computeCostBreakdown(caps, usage).total;

export const emptyUsage = (): UsageInfo => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
});

export const addUsage = (a: UsageInfo, b: UsageInfo): UsageInfo => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_creation: a.cache_creation + b.cache_creation,
});
