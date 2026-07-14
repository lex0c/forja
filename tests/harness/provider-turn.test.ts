import { describe, expect, test } from 'bun:test';
import { StepStallError } from '../../src/harness/abortable.ts';
import { CollectStepError } from '../../src/harness/collect.ts';
import { buildGenerateRequest, collectProviderStep } from '../../src/harness/provider-turn.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import type {
  Provider,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../../src/providers/index.ts';

// buildGenerateRequest only reads config.provider.id + a handful of optional
// top-level fields, so a partial cast is enough to exercise every spread.
const cfg = (overrides: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({ provider: { id: 'mock/m' }, ...overrides }) as unknown as HarnessConfig;

const msgs: ProviderMessage[] = [];
const tool = {} as ProviderToolDef;
const segs = [{ text: 'seg' }] as unknown as NonNullable<HarnessConfig['systemSegments']>;

describe('buildGenerateRequest', () => {
  test('minimal config emits only the required fields (optionals ABSENT, not undefined)', () => {
    const req = buildGenerateRequest({
      config: cfg(),
      messages: msgs,
      maxTokens: 512,
      tools: [],
      effort: undefined,
    });
    expect(req.model).toBe('mock/m');
    expect(req.messages).toBe(msgs);
    expect(req.max_tokens).toBe(512);
    // exactOptionalPropertyTypes: unset fields must not be present as keys.
    for (const k of [
      'system',
      'systemSegments',
      'tools',
      'temperature',
      'top_p',
      'thinking_budget',
      'effort',
      'seed_in_eval',
    ]) {
      expect(k in req).toBe(false);
    }
  });

  test('present config fields flow through', () => {
    const req = buildGenerateRequest({
      config: cfg({
        systemPrompt: 'sys',
        systemSegments: segs,
        temperature: 0.3,
        topP: 0.9,
        thinkingBudget: 2048,
        seedInEval: true,
      }),
      messages: msgs,
      maxTokens: 100,
      tools: [tool],
      effort: 'high',
    });
    expect(req.system).toBe('sys');
    expect(req.systemSegments).toBe(segs);
    expect(req.temperature).toBe(0.3);
    expect(req.top_p).toBe(0.9);
    expect(req.thinking_budget).toBe(2048);
    expect(req.seed_in_eval).toBe(true);
    expect(req.tools).toEqual([tool]);
    expect(req.effort).toBe('high');
  });

  test('tools omitted when empty, effort omitted when undefined', () => {
    const req = buildGenerateRequest({
      config: cfg({ systemPrompt: 'sys' }),
      messages: msgs,
      maxTokens: 100,
      tools: [],
      effort: undefined,
    });
    expect('tools' in req).toBe(false);
    expect('effort' in req).toBe(false);
    expect(req.system).toBe('sys');
  });
});

// Minimal scripted provider: yields the given events from generate(), the rest
// of the interface is unused by collectProviderStep.
const scriptedProvider = (events: StreamEvent[]): Provider =>
  ({
    id: 'mock/m',
    family: 'anthropic',
    capabilities: {},
    async *generate() {
      for (const e of events) yield e;
    },
  }) as unknown as Provider;

describe('collectProviderStep', () => {
  test('drains the stream into a CollectedStep and forwards every event', async () => {
    const events: StreamEvent[] = [
      { kind: 'start', message_id: 'm1' },
      { kind: 'text_delta', text: 'hello' },
      { kind: 'usage', usage: { input: 10, output: 3, cache_read: 0, cache_creation: 0 } },
      { kind: 'stop', reason: 'end_turn' },
    ];
    const seen: StreamEvent[] = [];
    const collected = await collectProviderStep({
      provider: scriptedProvider(events),
      req: { model: 'mock/m', messages: [], max_tokens: 100 },
      maxStepStallMs: 10_000,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e),
    });
    expect(collected.stop_reason).toBe('end_turn');
    expect(collected.usageSeen).toBe(true);
    expect(collected.usage.input).toBe(10);
    // Every raw event was forwarded to the observer.
    expect(seen.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('the load-bearing stall wrap raises StepStallError on a silent stream', async () => {
    // Pins the module's central claim: stallWatchdog is wired inside the
    // composition, so a provider that goes silent (yields nothing further)
    // trips within maxStepStallMs. collectStep wraps the iteration error, so it
    // arrives as CollectStepError whose `.cause` is the StepStallError — exactly
    // how the loop's catch unwraps it to route the `stepStalled` exit.
    const hanging = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {},
      async *generate() {
        yield { kind: 'start', message_id: 'm1' } as StreamEvent;
        await new Promise<void>(() => {}); // never yields again
      },
    } as unknown as Provider;
    let err: unknown;
    try {
      await collectProviderStep({
        provider: hanging,
        req: { model: 'mock/m', messages: [], max_tokens: 100 },
        maxStepStallMs: 50,
        signal: new AbortController().signal,
        onEvent: () => {},
      });
    } catch (e) {
      err = e;
    }
    const cause = err instanceof CollectStepError ? err.cause : err;
    expect(cause).toBeInstanceOf(StepStallError);
  });

  test('an already-aborted signal rejects (external abort beats the drain)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      collectProviderStep({
        provider: scriptedProvider([
          { kind: 'start', message_id: 'm1' },
          { kind: 'stop', reason: 'end_turn' },
        ]),
        req: { model: 'mock/m', messages: [], max_tokens: 100 },
        maxStepStallMs: 10_000,
        signal: ac.signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow();
  });
});
