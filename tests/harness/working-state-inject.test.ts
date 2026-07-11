import { describe, expect, test } from 'bun:test';
import { injectWorkingStateBlock } from '../../src/harness/working-state-inject.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';
import { emptyWorkingState, type WorkingState } from '../../src/working-state/index.ts';

const panel: WorkingState = {
  focus: { text: 'investigate glob', atStep: 4 },
  next: ['gate each path'],
  log: [],
  hypotheses: [],
};

describe('injectWorkingStateBlock', () => {
  test('empty panel is a no-op', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hello' }];
    injectWorkingStateBlock(messages, emptyWorkingState(), 5);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('appends to a string user message at the bottom', () => {
    const messages: ProviderMessage[] = [
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'do the thing' },
    ];
    injectWorkingStateBlock(messages, panel, 6);
    const last = messages[1];
    expect(typeof last?.content).toBe('string');
    const text = last?.content as string;
    expect(text.startsWith('do the thing\n\n[working_state]')).toBe(true);
    expect(text).toContain('focus: investigate glob');
  });

  test('appends a text block to a tool_result user message', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    ];
    injectWorkingStateBlock(messages, panel, 6);
    const content = messages[1]?.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe('tool_result');
    expect(content[1]?.type).toBe('text');
    expect(content[1]?.text?.startsWith('[working_state]')).toBe(true);
  });

  test('does not touch the shared message instances (replaces the element)', () => {
    const original: ProviderMessage = { role: 'user', content: 'orig' };
    const messages: ProviderMessage[] = [original];
    injectWorkingStateBlock(messages, panel, 6);
    // the array element was replaced with a new object; the original is intact
    expect(original.content).toBe('orig');
    expect(messages[0]).not.toBe(original);
  });

  test('no-op when the last message is an assistant turn', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: 'thinking' }];
    injectWorkingStateBlock(messages, panel, 6);
    expect(messages).toEqual([{ role: 'assistant', content: 'thinking' }]);
  });

  test('empty messages array is a no-op', () => {
    const messages: ProviderMessage[] = [];
    injectWorkingStateBlock(messages, panel, 6);
    expect(messages).toEqual([]);
  });
});
