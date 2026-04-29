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
export const computeCost = (caps: ProviderCapabilities, usage: UsageInfo): number => {
  const inputRate = caps.cost_per_1k_input;
  const outputRate = caps.cost_per_1k_output;
  const cacheReadRate = caps.cost_per_1k_cached_input ?? inputRate;
  const cacheWriteRate = caps.cost_per_1k_cache_write ?? inputRate;
  return (
    (usage.input * inputRate +
      usage.output * outputRate +
      usage.cache_read * cacheReadRate +
      usage.cache_creation * cacheWriteRate) /
    1_000_000
  );
};

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
