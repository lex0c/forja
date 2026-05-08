import { describe, expect, test } from 'bun:test';
import { fixture as f01 } from '../../evals/critique/fixtures/01-clean-output.ts';
import { fixture as f02 } from '../../evals/critique/fixtures/02-flagged-bug.ts';
import { fixture as f03 } from '../../evals/critique/fixtures/03-tool-plan-writes.ts';
import { fixture as f04 } from '../../evals/critique/fixtures/04-malformed-output.ts';
import { fixture as f05 } from '../../evals/critique/fixtures/05-low-confidence.ts';
import { fixture as f06 } from '../../evals/critique/fixtures/06-mixed-severities.ts';
import type { CritiqueFixture } from '../../evals/critique/fixtures/types.ts';
import { runCritique } from '../../src/critique/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';

const FIXTURES: readonly CritiqueFixture[] = [f01, f02, f03, f04, f05, f06];

const baseCaps: Provider['capabilities'] = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4096,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  notes: [],
};

const fixtureProvider = (response: string): Provider => ({
  id: 'mock/eval-critic',
  family: 'anthropic',
  capabilities: baseCaps,
  async *generate() {
    yield { kind: 'start', message_id: 'm' };
    yield { kind: 'text_delta', text: response };
    yield {
      kind: 'usage',
      usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
    };
    yield { kind: 'stop', reason: 'end_turn' } satisfies StreamEvent;
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

describe('critique eval — fixture suite (evals/critique/)', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: ${fx.description}`, async () => {
      const provider = fixtureProvider(fx.criticResponse);
      const result = await runCritique(provider, fx.input, {
        threshold: fx.options?.threshold ?? 0.7,
        maxOverheadMs: fx.options?.maxOverheadMs ?? 0,
        ...(fx.options?.maxTokens !== undefined ? { maxTokens: fx.options.maxTokens } : {}),
        ...(fx.options?.promptVersion !== undefined
          ? { promptVersion: fx.options.promptVersion }
          : {}),
      });

      expect(result.strategy).toBe(fx.expected.strategy);
      if (fx.expected.rawCount !== undefined) {
        expect(result.rawIssues).toHaveLength(fx.expected.rawCount);
      }
      if (fx.expected.filteredCount !== undefined) {
        expect(result.filteredIssues).toHaveLength(fx.expected.filteredCount);
      }
      if (fx.expected.minOverallConfidence !== undefined) {
        expect(result.overallConfidence).toBeGreaterThanOrEqual(fx.expected.minOverallConfidence);
      }
      if (fx.expected.maxOverallConfidence !== undefined) {
        expect(result.overallConfidence).toBeLessThanOrEqual(fx.expected.maxOverallConfidence);
      }
      if (fx.expected.reasonContains !== undefined) {
        expect(result.reason).toBeDefined();
        expect(result.reason ?? '').toContain(fx.expected.reasonContains);
      }
    });
  }
});
