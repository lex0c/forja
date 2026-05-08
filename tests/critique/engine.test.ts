import { describe, expect, test } from 'bun:test';
import {
  CRITIQUE_MARKER_CLOSE,
  CRITIQUE_MARKER_OPEN,
  CRITIQUE_SYSTEM_PROMPT_V1,
  runCritique,
} from '../../src/critique/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';

const baseCaps: Provider['capabilities'] = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4096,
  // Non-zero pricing so cost math is exercised in at least one test.
  cost_per_1k_input: 1,
  cost_per_1k_output: 2,
  notes: [],
};

interface MockHandle {
  provider: Provider;
  generateCalls: GenerateRequest[];
}

const wrapPayload = (json: string): string =>
  `Sure, here:\n${CRITIQUE_MARKER_OPEN}\n${json}\n${CRITIQUE_MARKER_CLOSE}\nDone.`;

const replyText = function* (text: string): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'm' };
  yield { kind: 'text_delta', text };
  yield {
    kind: 'usage',
    usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
  };
  yield { kind: 'stop', reason: 'end_turn' };
};

const replyTextNoUsage = function* (text: string): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'm' };
  yield { kind: 'text_delta', text };
  yield { kind: 'stop', reason: 'end_turn' };
};

const replyStreamError = function* (): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'm' };
  yield { kind: 'error', code: 'malformed_args', message: 'tool args broken', retryable: false };
  yield { kind: 'stop', reason: 'end_turn' };
};

const mockProvider = (
  reply: ((req: GenerateRequest) => Iterable<StreamEvent>) | (() => never),
): MockHandle => {
  const generateCalls: GenerateRequest[] = [];
  const provider: Provider = {
    id: 'mock/critique',
    family: 'anthropic',
    capabilities: baseCaps,
    async *generate(req) {
      generateCalls.push(req);
      const iter = reply(req);
      for (const ev of iter) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
  return { provider, generateCalls };
};

const baseInput = {
  userPrompt: 'Refactor authenticate() to use the new token store.',
  assistantText: 'I will rewrite the function in place.',
};

const baseOptions = {
  threshold: 0.7,
  maxOverheadMs: 0, // disable watchdog; mocks resolve synchronously
};

describe('runCritique — happy path', () => {
  test('parses well-formed marker payload and filters by threshold', async () => {
    const json = JSON.stringify({
      issues: [
        {
          severity: 'error',
          description: 'token_store import is missing',
          confidence: 0.9,
          suggestion: "Add `import { tokenStore } from '...'`.",
        },
        {
          severity: 'info',
          description: 'naming nit',
          confidence: 0.4,
          suggestion: 'rename to authUser',
        },
      ],
      overall_confidence: 0.6,
    });
    const handle = mockProvider(() => replyText(wrapPayload(json)));

    const result = await runCritique(handle.provider, baseInput, baseOptions);

    expect(result.strategy).toBe('llm');
    // Both issues land in `rawIssues`, only the high-confidence one
    // crosses the 0.7 threshold.
    expect(result.rawIssues).toHaveLength(2);
    expect(result.filteredIssues).toHaveLength(1);
    expect(result.filteredIssues[0]?.severity).toBe('error');
    expect(result.filteredIssues[0]?.confidence).toBeCloseTo(0.9);
    expect(result.overallConfidence).toBeCloseTo(0.6);
    expect(result.usageSeen).toBe(true);
    // Cost is non-zero with non-zero per-1k pricing and reported usage.
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('issues a system prompt + a single user message with the executor proposal', async () => {
    const json = '{"issues":[],"overall_confidence":1.0}';
    const handle = mockProvider(() => replyText(wrapPayload(json)));

    await runCritique(handle.provider, baseInput, baseOptions);

    expect(handle.generateCalls).toHaveLength(1);
    const req = handle.generateCalls[0];
    expect(req?.system).toBe(CRITIQUE_SYSTEM_PROMPT_V1);
    expect(req?.temperature).toBe(0);
    expect(req?.messages).toHaveLength(1);
    const userContent = req?.messages[0]?.content;
    expect(typeof userContent).toBe('string');
    if (typeof userContent === 'string') {
      expect(userContent).toContain('USER PROMPT');
      expect(userContent).toContain('Refactor authenticate');
      expect(userContent).toContain('PROPOSED ASSISTANT OUTPUT');
    }
  });

  test('renders a tool plan into the user message when supplied', async () => {
    const json = '{"issues":[],"overall_confidence":1.0}';
    const handle = mockProvider(() => replyText(wrapPayload(json)));

    await runCritique(
      handle.provider,
      {
        userPrompt: 'rm -rf node_modules and reinstall',
        assistantText: 'Running cleanup before reinstall.',
        toolPlan: [
          { name: 'bash', input: { command: 'rm -rf node_modules' }, writes: true },
          { name: 'bash', input: { command: 'bun install' }, writes: true },
        ],
      },
      baseOptions,
    );

    const userContent = handle.generateCalls[0]?.messages[0]?.content;
    if (typeof userContent === 'string') {
      expect(userContent).toContain('PROPOSED TOOL CALLS');
      expect(userContent).toContain('writes:true');
      expect(userContent).toContain('rm -rf node_modules');
      expect(userContent).toContain('bun install');
    }
  });

  test('empty issues array yields strategy=llm with zero filtered issues', async () => {
    const json = '{"issues":[],"overall_confidence":0.95}';
    const handle = mockProvider(() => replyText(wrapPayload(json)));

    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('llm');
    expect(result.rawIssues).toHaveLength(0);
    expect(result.filteredIssues).toHaveLength(0);
    expect(result.overallConfidence).toBeCloseTo(0.95);
  });

  test('drops noise issues with neither description nor suggestion', async () => {
    const json = JSON.stringify({
      issues: [
        { severity: 'warn', description: '', confidence: 0.9, suggestion: '' },
        { severity: 'error', description: 'real one', confidence: 0.9, suggestion: 'fix it' },
      ],
      overall_confidence: 0.5,
    });
    const handle = mockProvider(() => replyText(wrapPayload(json)));
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    // Only the substantive issue survives. The noise entry is silent
    // pre-filter so it doesn't pad rawIssues either.
    expect(result.rawIssues).toHaveLength(1);
    expect(result.rawIssues[0]?.description).toBe('real one');
  });
});

describe('runCritique — input coercion', () => {
  test('clamps confidence into [0,1] and coerces unknown severity to warn', async () => {
    const json = JSON.stringify({
      issues: [
        { severity: 'critical', description: 'X', confidence: 1.7, suggestion: 'Y' },
        { severity: 'info', description: 'Z', confidence: -0.3, suggestion: 'W' },
      ],
      overall_confidence: 2.0,
    });
    const handle = mockProvider(() => replyText(wrapPayload(json)));

    const result = await runCritique(handle.provider, baseInput, {
      ...baseOptions,
      threshold: 0.5,
    });

    expect(result.strategy).toBe('llm');
    expect(result.rawIssues[0]?.confidence).toBeCloseTo(1);
    expect(result.rawIssues[0]?.severity).toBe('warn'); // 'critical' coerced
    expect(result.rawIssues[1]?.confidence).toBeCloseTo(0);
    expect(result.rawIssues[1]?.severity).toBe('info');
    expect(result.overallConfidence).toBeCloseTo(1);
    // After clamping, only the first issue (confidence=1) crosses
    // threshold=0.5.
    expect(result.filteredIssues).toHaveLength(1);
  });

  test('clamps threshold itself into [0,1]', async () => {
    const json = JSON.stringify({
      issues: [{ severity: 'warn', description: 'X', confidence: 0.5, suggestion: 'Y' }],
      overall_confidence: 0.5,
    });
    const handle = mockProvider(() => replyText(wrapPayload(json)));
    // threshold=2 ⇒ clamped to 1; nothing passes.
    const high = await runCritique(handle.provider, baseInput, {
      ...baseOptions,
      threshold: 2,
    });
    expect(high.filteredIssues).toHaveLength(0);
    // threshold=-1 ⇒ clamped to 0; everything passes.
    const handle2 = mockProvider(() => replyText(wrapPayload(json)));
    const low = await runCritique(handle2.provider, baseInput, {
      ...baseOptions,
      threshold: -1,
    });
    expect(low.filteredIssues).toHaveLength(1);
  });
});

describe('runCritique — soft failure paths', () => {
  test('missing markers ⇒ strategy=failed with markers_missing reason', async () => {
    const handle = mockProvider(() => replyText('I think the code looks fine, no JSON here.'));
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('failed');
    expect(result.reason).toBe('markers_missing');
    expect(result.filteredIssues).toHaveLength(0);
    // Cost still flows through so the call's billed tokens aren't lost.
    expect(result.usageSeen).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('markers present but JSON malformed ⇒ strategy=failed with parse_failed', async () => {
    // Both braces must be inside the markers for extractMarkerPayload
    // to find a payload at all — otherwise the test exercises the
    // markers_missing branch instead of the malformed-JSON branch we
    // actually want to cover here.
    const handle = mockProvider(() =>
      replyText(`${CRITIQUE_MARKER_OPEN}\n{not: valid, json}\n${CRITIQUE_MARKER_CLOSE}`),
    );
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('failed');
    expect(result.reason).toBe('parse_failed');
  });

  test('JSON valid but issues field is not an array ⇒ parse_failed', async () => {
    const handle = mockProvider(() =>
      replyText(wrapPayload('{"issues":"oops","overall_confidence":0.5}')),
    );
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('failed');
    expect(result.reason).toBe('parse_failed');
  });

  test('empty stream response ⇒ strategy=failed with empty_response', async () => {
    const handle = mockProvider(() => replyText(''));
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('failed');
    expect(result.reason).toBe('empty_response');
  });

  test('stream-level error ⇒ strategy=failed with stream_error reason', async () => {
    const handle = mockProvider(() => replyStreamError());
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('failed');
    expect(result.reason).toMatch(/stream_error/);
    expect(result.reason).toContain('malformed_args');
  });

  test('no usage event ⇒ usageSeen=false and costUsd=0', async () => {
    const handle = mockProvider(() =>
      replyTextNoUsage(wrapPayload('{"issues":[],"overall_confidence":1.0}')),
    );
    const result = await runCritique(handle.provider, baseInput, baseOptions);
    expect(result.strategy).toBe('llm');
    expect(result.usageSeen).toBe(false);
    expect(result.costUsd).toBe(0);
  });
});

// Provider whose generate() emits `start` then awaits `holdMs` before
// any further event. Lets the watchdog tests exercise the "stream is
// alive but slow" path without relying on the mockProvider helper
// (which assumes synchronous generators).
const slowProvider = (holdMs: number): Provider => ({
  id: 'mock/critique-slow',
  family: 'anthropic',
  capabilities: baseCaps,
  async *generate() {
    yield { kind: 'start', message_id: 'm' };
    await new Promise((r) => setTimeout(r, holdMs));
    yield { kind: 'text_delta', text: 'still thinking...' };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

describe('runCritique — overhead watchdog', () => {
  test('overhead budget exceeded ⇒ strategy=skipped with overhead_exceeded reason', async () => {
    const provider = slowProvider(200);
    const start = Date.now();
    const result = await runCritique(provider, baseInput, {
      threshold: 0.7,
      maxOverheadMs: 30,
    });
    const elapsed = Date.now() - start;
    expect(result.strategy).toBe('skipped');
    expect(result.reason).toContain('overhead_exceeded');
    expect(result.filteredIssues).toHaveLength(0);
    // Watchdog actually cut the call short — total time should be
    // well under the slow stream's natural hold. Generous bound
    // (5x watchdog + scheduling jitter) so CI doesn't flake.
    expect(elapsed).toBeLessThan(150);
  });

  test('caller signal abort propagates as throw', async () => {
    const provider = slowProvider(500);
    const ctrl = new AbortController();
    const p = runCritique(provider, baseInput, {
      threshold: 0.7,
      maxOverheadMs: 0,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toBeDefined();
  });
});
