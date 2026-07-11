import { describe, expect, test } from 'bun:test';
import {
  injectStaticGuidance,
  STATIC_GUIDANCE_BLOCK,
  STATIC_GUIDANCE_BLOCK_LEAN,
} from '../../src/harness/static-guidance.ts';
import { injectWorkingStateBlock } from '../../src/harness/working-state-inject.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';
import { emptyWorkingState, type WorkingState } from '../../src/working-state/index.ts';

const panel: WorkingState = {
  focus: { text: 'investigate glob', atStep: 4 },
  next: ['gate each path'],
  log: [],
  hypotheses: [],
};

describe('injectStaticGuidance', () => {
  test('appends the loop-control guidance to a string user message', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'do the thing' }];
    injectStaticGuidance(messages);
    const text = messages[0]?.content as string;
    expect(text.startsWith('do the thing\n\nStanding operating context')).toBe(true);
    expect(text).toContain('\n\n[workflow_discipline]');
    expect(text).toContain('verify its blast radius');
    expect(text).toContain('Keep the working state accurate');
    // Scope is loop-control ONLY. Stable craft constraints (smallest diff,
    // fix-the-cause, match-conventions) live in the cached `# Constraints` prefix
    // — paid once, not re-paid uncached at the tail every step. They must NOT
    // reappear here, or the per-step duplication this split removed comes back.
    expect(text).not.toContain('[engineering_principles]');
    expect(text).not.toContain('Smallest correct diff');
    expect(text).not.toContain('Fix the cause, not the symptom');
  });

  test('appends a text block to a tool_result user message', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    ];
    injectStaticGuidance(messages);
    const content = messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe('tool_result');
    expect(content[1]?.type).toBe('text');
    expect(content[1]?.text).toBe(STATIC_GUIDANCE_BLOCK);
  });

  test('merges into one text block (separated) on a tool_result message', () => {
    // Both injectors run, same order as the loop. The OpenAI adapter flattens
    // text blocks with join(''), so the two must collapse into ONE block with a
    // blank-line separator — never two blocks that would glue end-to-start.
    const messages: ProviderMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    ];
    injectWorkingStateBlock(messages, panel, 6);
    injectStaticGuidance(messages);
    const content = messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe('tool_result');
    expect(content[1]?.type).toBe('text');
    const text = content[1]?.text as string;
    expect(text).toContain('[working_state]');
    expect(text).toContain('\n\n[workflow_discipline]');
  });

  test('lands BELOW the working-state panel when injected in loop order', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'do the thing' }];
    // Same order as the harness loop: working-state first, guidance after.
    injectWorkingStateBlock(messages, panel, 6);
    injectStaticGuidance(messages);
    const text = messages[0]?.content as string;
    const wsAt = text.indexOf('[working_state]');
    const wdAt = text.indexOf('[workflow_discipline]');
    expect(wsAt).toBeGreaterThanOrEqual(0);
    expect(wdAt).toBeGreaterThan(wsAt);
  });

  test('still injects when the working-state panel is empty (no-op panel)', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'do the thing' }];
    injectWorkingStateBlock(messages, emptyWorkingState(), 6);
    injectStaticGuidance(messages);
    const text = messages[0]?.content as string;
    expect(text).not.toContain('[working_state]');
    expect(text).toContain('[workflow_discipline]');
  });

  test('does not touch the shared message instance (replaces the element)', () => {
    const original: ProviderMessage = { role: 'user', content: 'orig' };
    const messages: ProviderMessage[] = [original];
    injectStaticGuidance(messages);
    expect(original.content).toBe('orig');
    expect(messages[0]).not.toBe(original);
  });

  test('no-op when the last message is an assistant turn', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: 'thinking' }];
    injectStaticGuidance(messages);
    expect(messages).toEqual([{ role: 'assistant', content: 'thinking' }]);
  });

  test('no-op on an empty messages array', () => {
    const messages: ProviderMessage[] = [];
    injectStaticGuidance(messages);
    expect(messages).toEqual([]);
  });

  test('lean=true injects the tight-window variant — framing + 2 bullets, rest dropped', () => {
    // CONTEXT_TUNING §2.2: the per-step block rides the uncached tail, so on a
    // small window it leans to the two highest-value items (blast-radius safety,
    // evidence-before-done) and keeps the derail-fix framing line.
    const messages: ProviderMessage[] = [{ role: 'user', content: 'do the thing' }];
    injectStaticGuidance(messages, true);
    const text = messages[0]?.content as string;
    expect(text.startsWith('do the thing\n\nStanding operating context')).toBe(true);
    expect(text).toContain('[workflow_discipline]');
    expect(text).toContain('verify its blast radius');
    expect(text).toContain('Claim done only with evidence');
    // Full-tier-only bullets must NOT appear on the lean path.
    expect(text).not.toContain('return to understand or plan');
    expect(text).not.toContain('Keep the working state accurate');
  });

  test('lean block is smaller than the full block', () => {
    expect(STATIC_GUIDANCE_BLOCK_LEAN.length).toBeLessThan(STATIC_GUIDANCE_BLOCK.length);
  });
});
