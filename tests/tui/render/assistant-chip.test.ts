import { describe, expect, test } from 'bun:test';
import { renderAssistantChip } from '../../../src/tui/render/assistant-chip.ts';
import { OUTPUT_VERB_POOL } from '../../../src/tui/render/spinner-verbs.ts';
import type { PendingAssistant } from '../../../src/tui/state.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

const pending = (overrides: Partial<PendingAssistant> = {}): PendingAssistant => ({
  messageId: 'm1',
  text: '',
  startedAt: 0,
  inputTokens: null,
  outputTokens: null,
  cacheRead: null,
  cacheCreation: null,
  outputEstimated: 0,
  inputEstimated: null,
  ...overrides,
});

// Match "<word>… [..." — the chip's verb sits before the elapsed
// counter. Used by tests that don't pin a specific verb but do
// need to assert the chip rendered SOME verb from the pool.
const verbPattern = /(\w+)…\s*\[/;

describe('renderAssistantChip', () => {
  test('no usage event yet → counter is duration only, verb is from the output pool', () => {
    const out = renderAssistantChip(pending({ startedAt: 0 }), caps, 8200);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('[8.2s]');
    const match = out[0]?.match(verbPattern);
    expect(match).not.toBeNull();
    expect(OUTPUT_VERB_POOL).toContain(match?.[1] ?? '');
    // No tokens clause until assistant:usage lands.
    expect(out[0]).not.toContain('↑');
    expect(out[0]).not.toContain('↓');
  });

  // The arrow convention is operator-facing (sent / received), not
  // provider-direction (up/down byte stream). `↑` = what we shipped to
  // the model (input + cache_creation); `↓` = what came back (output).
  // The pin below is the user-visible contract — the chip mutates
  // through 3 stages on Anthropic: `[Xs]` → `[Xs · ↑ N]` (message_start)
  // → `[Xs · ↑ N · ↓ M]` (message_stop).
  test('input-only usage (Anthropic pre-stop) → counter shows ↑ for sent', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, inputTokens: 1234 }), caps, 8200);
    expect(out[0]).toContain('[8.2s · ↑ 1.2k]');
    expect(out[0]).not.toContain('↓');
  });

  test('full usage (post-stop) → counter shows both ↑ sent and ↓ received', () => {
    const out = renderAssistantChip(
      pending({ startedAt: 0, inputTokens: 1234, outputTokens: 234 }),
      caps,
      8200,
    );
    // Trailing `]` dropped from the expected substring because the
    // throughput cell (`· 28.5 t/s`) may attach after the received
    // cell — its presence is asserted by other tests.
    expect(out[0]).toContain('[8.2s · ↑ 1.2k · ↓ 234');
  });

  test('cache_creation rolls into the ↑ total (it is shipped too)', () => {
    // cache_creation are tokens that went up the wire AND got written
    // into the cache — operator's "sent" count must include them.
    // cache_read is intentionally excluded: those tokens were sent in
    // a prior turn and the cache hit just replayed them; counting
    // them under ↑ would double-charge across turns.
    const out = renderAssistantChip(
      pending({ startedAt: 0, inputTokens: 500, cacheCreation: 700, cacheRead: 9999 }),
      caps,
      8200,
    );
    expect(out[0]).toContain('↑ 1.2k');
    expect(out[0]).not.toContain('9999');
    expect(out[0]).not.toContain('9.9k');
  });

  test('output-only usage (OpenAI-shape at stop, no input field) → ↓ alone', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 234 }), caps, 8200);
    expect(out[0]).toContain('[8.2s · ↓ 234');
    expect(out[0]).not.toContain('↑');
  });

  // 3-layer token accounting (TOKEN_TUNING.md §8): the chip prefers
  // provider-official numbers but falls back to a local chars/4
  // estimate while the stream is still in flight. The estimate is
  // prefixed `~` so the operator can tell measurement from guess.
  test('estimated output: `~` prefix while official is null', () => {
    // 1234 chars ≈ 309 estimated tokens (ceil(1234/4) = 309).
    const out = renderAssistantChip(pending({ startedAt: 0, outputEstimated: 309 }), caps, 8200);
    expect(out[0]).toContain('[8.2s · ↓ ~309');
  });

  test('official output wins over estimate when both present', () => {
    // The moment `assistant:usage` lands with a POSITIVE output count,
    // the chip switches to the authoritative number — no `~` prefix,
    // no mixing of the two.
    const out = renderAssistantChip(
      pending({ startedAt: 0, outputTokens: 234, outputEstimated: 309 }),
      caps,
      8200,
    );
    expect(out[0]).toContain('[8.2s · ↓ 234');
    expect(out[0]).not.toContain('~');
    expect(out[0]).not.toContain('309');
  });

  test('Anthropic early-emit (outputTokens=0) does NOT shadow accumulating estimate', () => {
    // The bug pin: Anthropic now emits `usage` at message_start with
    // `output_tokens=0`. Reducer merges null → 0 via Math.max. The
    // chip must NOT render `↓ 0` for the rest of the streaming turn
    // — the estimate accumulator is the better signal in this window.
    // Throughput must also fall back so the `N t/s` cell ticks from
    // the first delta, not just from message_stop.
    const out = renderAssistantChip(
      pending({ startedAt: 0, outputTokens: 0, outputEstimated: 200 }),
      caps,
      8000,
    );
    expect(out[0]).toContain('↓ ~200');
    expect(out[0]).not.toContain('↓ 0');
    // Throughput from estimate: 200 / 8s = 25 t/s.
    expect(out[0]).toContain('25.0 t/s');
  });

  test('outputEstimated of 0 is suppressed (no `↓ ~0` noise)', () => {
    // Turn just started — no `assistant:delta` has landed yet. The
    // estimate accumulator is at 0; the chip omits the received cell
    // entirely. `~0` would read as visual noise without informing the
    // operator of anything useful.
    const out = renderAssistantChip(pending({ startedAt: 0, outputEstimated: 0 }), caps, 8200);
    expect(out[0]).not.toContain('↓');
    expect(out[0]).not.toContain('~');
  });

  // Throughput cell (tokens per second). Computed from the active
  // output basis: `outputTokens` (official) when present, else
  // `outputEstimated`. Suppressed when elapsed < 1s (not enough
  // signal) or when no output has flowed yet. Format adapts to
  // magnitude: `< 100` → 1 decimal, `< 1000` → integer, `>= 1000`
  // → `Xk t/s`. The cell is per-turn, NOT session-cumulative.
  test('throughput cell appears once both output > 0 and elapsed >= 1s', () => {
    // 234 tokens / 8.2s = 28.5 t/s.
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 234 }), caps, 8200);
    expect(out[0]).toContain('28.5 t/s');
  });

  test('throughput suppressed under 1s elapsed (not enough signal)', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 234 }), caps, 500);
    expect(out[0]).not.toContain('t/s');
  });

  test('throughput uses estimated output when official is null', () => {
    // The chip wants to show throughput from the first delta, not
    // wait for `assistant:usage` to land. Falling back to the local
    // estimate gives the operator early signal at the cost of the
    // same ~5-25% drift the `↓ ~N` cell already carries.
    const out = renderAssistantChip(pending({ startedAt: 0, outputEstimated: 100 }), caps, 5000);
    expect(out[0]).toContain('20.0 t/s');
  });

  test('throughput integer above 100 t/s; k-suffix past 1k t/s', () => {
    const fast = renderAssistantChip(pending({ startedAt: 0, outputTokens: 500 }), caps, 2000);
    expect(fast[0]).toContain('250 t/s');
    const veryFast = renderAssistantChip(pending({ startedAt: 0, outputTokens: 5000 }), caps, 2000);
    expect(veryFast[0]).toContain('2.5k t/s');
  });

  // Cache hit ratio (Anthropic prompt cache, CONTEXT_TUNING.md §5).
  // Surfaced as a tail on the `↑` cell: `↑ 14k cache 78%`.
  // Denominator is the FULL up-the-wire payload (input + cache_read
  // + cache_creation). Suppressed when cache_read is 0 — the
  // operator already knows there was no cache hit (and a `0%`
  // would push the operator to investigate something that's normal
  // on a first turn).
  test('cache ratio renders when cache_read > 0', () => {
    // input 4k + cache_read 14k + cache_creation 2k = 20k total.
    // ratio = 14k / 20k = 70%.
    const out = renderAssistantChip(
      pending({
        startedAt: 0,
        inputTokens: 4000,
        cacheRead: 14_000,
        cacheCreation: 2000,
      }),
      caps,
      1000,
    );
    expect(out[0]).toContain('cache 70%');
  });

  test('cache ratio omitted when cache_read is 0 (no cache hit)', () => {
    const out = renderAssistantChip(
      pending({ startedAt: 0, inputTokens: 1000, cacheRead: 0, cacheCreation: 0 }),
      caps,
      1000,
    );
    expect(out[0]).not.toContain('cache');
  });

  test("cache ratio omitted when usage hasn't arrived yet", () => {
    // null inputs / null cache fields → sent cell itself omitted,
    // so the cache tail can't attach either.
    const out = renderAssistantChip(pending({ startedAt: 0 }), caps, 1000);
    expect(out[0]).not.toContain('cache');
  });

  // Pre-flight estimate path (slice 2 of 3-layer accounting):
  // `inputEstimated` is stamped on `assistant:start` from the
  // harness's `step_start.promptTokensEstimate`. The chip renders
  // `↑ ~N` until the provider's official `inputTokens` lands.
  test('inputEstimated renders `↑ ~N` before official input arrives', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, inputEstimated: 12_345 }), caps, 1000);
    expect(out[0]).toContain('↑ ~12k');
  });

  test('official inputTokens wins over inputEstimated', () => {
    // Once provider usage lands, the chip drops the `~` prefix and
    // switches to the canonical count. Cache tail can then attach.
    const out = renderAssistantChip(
      pending({
        startedAt: 0,
        inputTokens: 11_500,
        inputEstimated: 12_345,
        cacheRead: 30_000,
        cacheCreation: 500,
      }),
      caps,
      1000,
    );
    // Sent = inputTokens + cacheCreation = 11500 + 500 = 12000 → `12k`.
    expect(out[0]).toContain('↑ 12k');
    expect(out[0]).not.toContain('~');
    expect(out[0]).toContain('cache');
  });

  test('cache tail suppressed on estimate path', () => {
    // The estimate has no notion of cache hits — surfacing a cache %
    // alongside `~N` would mix two different sources of truth.
    const out = renderAssistantChip(pending({ startedAt: 0, inputEstimated: 5000 }), caps, 1000);
    expect(out[0]).toContain('↑ ~5.0k');
    expect(out[0]).not.toContain('cache');
  });

  test('inputEstimated of 0 suppressed (no `↑ ~0` noise)', () => {
    const out = renderAssistantChip(pending({ startedAt: 0, inputEstimated: 0 }), caps, 1000);
    expect(out[0]).not.toContain('↑');
  });

  test('compact format applies to estimates too', () => {
    // Estimate path uses the same formatTokens. A 5k-char delta
    // accumulator estimates ~1.3k tokens; the chip surfaces it as
    // `↓ ~1.3k`.
    const out = renderAssistantChip(pending({ startedAt: 0, outputEstimated: 1300 }), caps, 8200);
    expect(out[0]).toContain('↓ ~1.3k');
  });

  test('compact format kicks in past 1k / past 1M', () => {
    // 1234 → `1.2k`, 12345 → `12k`, 1500000 → `1.5M`. The split
    // boundaries match the chip's column budget on 80-col terminals
    // (right-anchored cost segment leaves limited room).
    expect(
      renderAssistantChip(pending({ startedAt: 0, inputTokens: 1234 }), caps, 1000)[0],
    ).toContain('↑ 1.2k');
    expect(
      renderAssistantChip(pending({ startedAt: 0, inputTokens: 12345 }), caps, 1000)[0],
    ).toContain('↑ 12k');
    expect(
      renderAssistantChip(pending({ startedAt: 0, inputTokens: 1_500_000 }), caps, 1000)[0],
    ).toContain('↑ 1.5M');
  });

  test('verb is stable for the same messageId across consecutive renders', () => {
    // Spinner re-renders every ~150ms; the chip must not flicker
    // between "Forging" and "Tempering" inside a single turn.
    const a = renderAssistantChip(pending({ messageId: 'msg_01ABC', startedAt: 0 }), caps, 1000);
    const b = renderAssistantChip(pending({ messageId: 'msg_01ABC', startedAt: 0 }), caps, 5000);
    const verbA = a[0]?.match(verbPattern)?.[1];
    const verbB = b[0]?.match(verbPattern)?.[1];
    expect(verbA).toBe(verbB ?? '');
  });

  test('sub-second elapsed renders in ms', () => {
    const out = renderAssistantChip(pending({ startedAt: 100 }), caps, 450);
    expect(out[0]).toContain('[350ms]');
  });

  test('ASCII fallback uses ^ for sent and v for received', () => {
    const out = renderAssistantChip(
      pending({ startedAt: 0, inputTokens: 100, outputTokens: 50 }),
      ascii,
      1200,
    );
    expect(out[0]).toContain('^ 100');
    expect(out[0]).toContain('v 50');
    expect(out[0]).not.toContain('↑');
    expect(out[0]).not.toContain('↓');
  });

  test('outputTokens of 0 is treated as `no signal` mid-stream; estimate path takes over', () => {
    // Updated semantic after the Anthropic early-emit landed: every
    // `message_start` now yields a `usage` event with `output_tokens=0`,
    // and the reducer's Math.max merge sets `pendingAssistant.outputTokens=0`
    // from frame 1 of the turn. The chip is only rendered while the
    // message is in flight, so the "final output is genuinely 0"
    // case (tool-only turn) lives in the scrollback path, not here.
    // The chip must therefore treat outputTokens=0 as no-signal and
    // prefer the estimate accumulator.
    const out = renderAssistantChip(
      pending({ startedAt: 0, outputTokens: 0, outputEstimated: 50 }),
      caps,
      1200,
    );
    expect(out[0]).toContain('↓ ~50');
    expect(out[0]).not.toContain('↓ 0');
  });

  test('outputTokens=0 + outputEstimated=0 suppresses the cell entirely (no `↓ 0` noise)', () => {
    // Defensive: when neither signal is positive, omit the recv cell
    // rather than render `↓ 0` (would read as "0 tokens" mid-stream).
    const out = renderAssistantChip(pending({ startedAt: 0, outputTokens: 0 }), caps, 1200);
    expect(out[0]).not.toContain('↓');
  });

  test('negative elapsed (clock went backwards) clamps to 0ms', () => {
    // Defensive: not expected in production, but renderer shouldn't
    // emit "(-3s · ↑ ...)" if a buggy producer sets startedAt > now.
    // Clamps to 0ms (not 0s) so the unit stays consistent with the
    // sub-second positive branch — a single skew tick shouldn't make
    // the counter visually jump units.
    const out = renderAssistantChip(pending({ startedAt: 5000 }), caps, 1000);
    expect(out[0]).toContain('[0ms]');
  });
});
