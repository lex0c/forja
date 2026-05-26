// Live output-pass chip. Spec: UI.md §4.10.5 (operation chip,
// active state) — the assistant turn shows up as an operation chip
// alongside tool cards while text streams in.
//
// Format:
//   ▸ Forging…  [8s · ↑ 14k cache 78% · ↓ 234 · 29 t/s]   ← steady-state turn
//   ▸ Forging…  [8s · ↑ 1.2k · ↓ ~58 · 7.3 t/s]            ← output estimated
//   ▸ Forging…  [8s · ↑ 1.2k]                              ← only input (no deltas yet)
//   ▸ Tempering…  [8s]                                     ← no usage yet
//
// Arrow convention (operator mental model):
//   ↑  sent     = input + cache creation (what we shipped to the model)
//   ↓  received = output (what the model sent back)
//
// 3-layer token accounting (TOKEN_TUNING.md §8):
//   1. Local estimate  → chars/4 of streamed `assistant:delta` text.
//                        Prefixed `~` to flag "this is a guess, ~5-25%
//                        drift on English, worse on code".
//   2. Stream-time     → Anthropic's `message_start` carries input
//      official           immediately; `message_stop` carries output.
//                        OpenAI carries both only at the final chunk.
//   3. Official        → the canonical numbers used for billing /
//                        compaction triggers.
// The chip prefers official; falls back to estimated. The `~` flips
// off the moment `assistant:usage` lands at message close — observable
// as a brief one-frame transition.
//
// Verb is picked from the OUTPUT pool by `pickOutputVerb`, hashed
// off the assistant message id. Stable for the duration of the
// turn (no flicker between consecutive frames), varies across
// turns — see `spinner-verbs.ts` for the rationale and the cluster
// composition (Forging / Tempering / Hardening / Smelting /
// Shaping). The flat "Generating…" label was the prior baseline;
// rotating verbs match Forja's industrial framing without
// sacrificing per-turn coherence.
//
// The token counter only appears once an `assistant:usage` UIEvent
// has merged onto pendingAssistant. Estimating from char count
// would mislead the operator (chars/4 drifts hard on code-heavy
// turns), and the project's measure-twice-cut-once stance is to
// show no number when we don't have one.

import type { PendingAssistant } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { formatChipDuration } from './duration.ts';
import { renderShimmer } from './shimmer.ts';
import { pickOutputVerb } from './spinner-verbs.ts';
import { spinnerGlyph } from './tool-card.ts';

// Compact token count: 1234 → "1.2k", 1234567 → "1.2M". Keeps the
// chip narrow under terminals where the right-anchored cost segment
// is also fighting for columns. Sub-1k numbers stay literal so
// short turns still read precisely.
const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
};

// Throughput formatter — tokens per second of the model's output
// pass. Format mirrors the token formatter (k/M suffix) so a wide
// chip reads consistently across `↓ 1.2k · 91 t/s` etc. Sub-1
// suppressed: a 600ms turn that produced 3 tokens would compute 5 t/s
// which is precise but uninformative; we treat any reading where
// elapsedMs < 1000 as "not enough data" and return null.
const formatThroughput = (tokens: number, elapsedMs: number): string | null => {
  if (elapsedMs < 1000) return null;
  const tps = tokens / (elapsedMs / 1000);
  if (tps < 1) return null;
  if (tps < 100) return `${tps.toFixed(1)} t/s`;
  if (tps < 1000) return `${Math.round(tps)} t/s`;
  return `${(tps / 1000).toFixed(1)}k t/s`;
};

export const renderAssistantChip = (
  pending: PendingAssistant,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatChipDuration(now - pending.startedAt);
  // Arrow glyphs Unicode-first with ASCII fallback (`^` up, `v` down)
  // so capability-limited terminals still see direction info instead
  // of dropping the count entirely.
  const up = caps.unicode ? '↑' : '^';
  const down = caps.unicode ? '↓' : 'v';
  // Sent = input + cache_creation. We sum because both are
  // tokens-we-pushed-up-the-wire from the operator's perspective:
  // input is fresh prompt material, cache_creation is fresh material
  // that ALSO got written into the cache. cache_read is NOT included
  // here — the operator paid for those tokens previously and the
  // cache hit just replays them; surfacing them under `↑` would
  // double-count across turns.
  // Sent cell prefers OFFICIAL numbers (input + cache_creation); when
  // those are absent (provider's `usage` hasn't landed yet), falls
  // back to the pre-flight `inputEstimated` from
  // `step_start.promptTokensEstimate`. The estimate stamp is marked
  // with `isSentEstimate` so the renderer can prefix `~` — matching
  // the `↓ ~N` convention on the received side. cache_creation is
  // only known from the provider, so the estimate path can't include
  // it; that's accurate because cache_creation is itself a
  // provider-side classification of the bytes we shipped.
  let sentRaw: number | null = null;
  let isSentEstimate = false;
  if (pending.inputTokens !== null || pending.cacheCreation !== null) {
    sentRaw = (pending.inputTokens ?? 0) + (pending.cacheCreation ?? 0);
  } else if (pending.inputEstimated !== null && pending.inputEstimated > 0) {
    sentRaw = pending.inputEstimated;
    isSentEstimate = true;
  }
  // Cache hit ratio. cache_read are tokens served from Anthropic's
  // prompt cache (CONTEXT_TUNING.md §5) — they cost ~10% of fresh
  // input tokens but count toward context the same way. The ratio is:
  //
  //   cache_read / (input + cache_read + cache_creation)
  //
  // where the denominator is the FULL up-the-wire payload (every
  // token Anthropic billed us for, cached or not). A high ratio
  // (>70%) is the desired steady state for any session past the
  // first turn — `CONTEXT_TUNING.md §5.5` calls out cache breakpoint
  // invalidation as one of the biggest hidden costs in agentic
  // loops. Surfacing this in the live chip gives the operator
  // immediate feedback when a tool / memory write busted the cache.
  //
  // Null when no cache data has landed; suppressed when the
  // denominator is zero (defensive — would imply no input either).
  const cacheReadVal = pending.cacheRead ?? 0;
  const inputVal = pending.inputTokens ?? 0;
  const cacheCreateVal = pending.cacheCreation ?? 0;
  const wireTotal = inputVal + cacheReadVal + cacheCreateVal;
  const cacheRatio = wireTotal > 0 && cacheReadVal > 0 ? cacheReadVal / wireTotal : null;
  // Resolve the received-tokens cell across the 3-layer hierarchy:
  // a POSITIVE official `outputTokens` wins; otherwise fall back to
  // the local `outputEstimated` accumulator with a `~` prefix. The
  // `> 0` filter (not `!== null`) is load-bearing: Anthropic now emits
  // a `usage` event at `message_start` that carries `output_tokens=0`
  // — without the positivity gate, the reducer's `Math.max` merge
  // sets `outputTokens=0` (non-null) on frame 1 and the chip would
  // render `↓ 0` for the entire streaming turn, shadowing the
  // accumulating estimate. The live chip is only rendered while the
  // message is in flight (`pendingAssistant !== null`); a "tool-only
  // turn whose final output_tokens is genuinely 0" can't reach the
  // chip — that case lives in the post-message scrollback path,
  // which is governed by `formatPermanent`, not here.
  let recvCell: string | null = null;
  if (pending.outputTokens !== null && pending.outputTokens > 0) {
    recvCell = `${down} ${formatTokens(pending.outputTokens)}`;
  } else if (pending.outputEstimated > 0) {
    recvCell = `${down} ~${formatTokens(pending.outputEstimated)}`;
  }
  // Throughput cell: model-output tokens per second since the chip
  // anchored. Uses POSITIVE official `outputTokens` when present,
  // falls back to `outputEstimated`. Same `> 0` rationale as the
  // recvCell branch above — `outputTokens=0` from the Anthropic
  // early-emit must NOT shadow the estimate (the `??` operator
  // doesn't coalesce on 0, only on null/undefined).
  const tputBasis =
    pending.outputTokens !== null && pending.outputTokens > 0
      ? pending.outputTokens
      : pending.outputEstimated;
  const tput = tputBasis > 0 ? formatThroughput(tputBasis, now - pending.startedAt) : null;
  // Drop on null (no usage event yet), keep on 0 — `↓ 0` is the
  // honest rendering for "provider said zero output", distinct from
  // "no measurement at all". Matches the assistant-chip's pre-existing
  // null-vs-zero convention.
  const parts: string[] = [elapsed];
  if (sentRaw !== null) {
    // Cache hit pct attaches to the `↑` cell (sent side) — it
    // qualifies the same number. Format: `↑ 14k cache 78%` (Unicode)
    // / `↑ 14k cache 78%` (ASCII, no glyph difference). We keep the
    // word `cache` (not a glyph) because the inverse signal — "no
    // cache" — is also operator-relevant; a missing word reads as
    // a regression more clearly than a missing glyph. The cache tail
    // is suppressed on the estimate path (chars/4 has no notion of
    // cache hits) — operator sees plain `↑ ~N` until the official
    // numbers land.
    const prefix = isSentEstimate ? '~' : '';
    const cacheTail =
      !isSentEstimate && cacheRatio !== null ? ` cache ${Math.round(cacheRatio * 100)}%` : '';
    parts.push(`${up} ${prefix}${formatTokens(sentRaw)}${cacheTail}`);
  }
  if (recvCell !== null) parts.push(recvCell);
  if (tput !== null) parts.push(tput);
  const counter = `[${parts.join(' · ')}]`;
  const verb = renderShimmer(`${pickOutputVerb(pending.messageId)}…`, caps, now, 'secondary');
  const head = paint(caps, 'secondary', `${spinner} `);
  return [`${head}${verb}${paint(caps, 'secondary', `  ${counter}`)}`];
};
