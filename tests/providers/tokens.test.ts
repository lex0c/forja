import { describe, expect, test } from 'bun:test';
import { estimateMessagesTokens, estimatePromptTokens } from '../../src/providers/tokens.ts';
import type { ProviderMessage, ProviderToolDef } from '../../src/providers/types.ts';

const tinyTool: ProviderToolDef = {
  name: 'read_file',
  description: 'read a file from disk',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

describe('estimateMessagesTokens', () => {
  test('counts string-content messages by length / 4', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hello world' }]; // 11 chars
    expect(estimateMessagesTokens(messages)).toBe(Math.ceil(11 / 4));
  });

  test('walks block content (text + tool_use + tool_result)', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'echo', input: { msg: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', name: 'echo', content: 'ok' }],
      },
    ];
    // Lengths: 'hi'(2) + 'echo'(4) + JSON.stringify({msg:'x'})(11) + 'ok'(2) + 't1'(2) = 21
    expect(estimateMessagesTokens(messages)).toBe(Math.ceil(21 / 4));
  });
});

describe('estimatePromptTokens', () => {
  test('matches estimateMessagesTokens when no system/tools given', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    expect(estimatePromptTokens(messages)).toBe(estimateMessagesTokens(messages));
  });

  test('adds system prompt characters to the count', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }]; // 2 chars
    const system = 'You are a helpful agent.'; // 24 chars
    expect(estimatePromptTokens(messages, { system })).toBe(Math.ceil((2 + 24) / 4));
  });

  test('adds tool schema characters to the count', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }]; // 2 chars
    // 'read_file'(9) + 'read a file from disk'(21) + JSON schema length
    const schemaJson = JSON.stringify(tinyTool.input_schema);
    const expectedToolChars = 9 + 21 + schemaJson.length;
    expect(estimatePromptTokens(messages, { tools: [tinyTool] })).toBe(
      Math.ceil((2 + expectedToolChars) / 4),
    );
  });

  test('combines messages + system + tools', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'q' }]; // 1
    const system = 'sys'; // 3
    const tools = [tinyTool];
    const messagesPart = 1;
    const systemPart = 3;
    const schemaJson = JSON.stringify(tinyTool.input_schema);
    const toolsPart = 9 + 21 + schemaJson.length;
    expect(estimatePromptTokens(messages, { system, tools })).toBe(
      Math.ceil((messagesPart + systemPart + toolsPart) / 4),
    );
  });

  test('a long tool schema alone can push the estimate over a small threshold', () => {
    // Regression for the harness trigger: with a tiny messages array
    // but heavy tool schemas, the prompt-level estimate must reflect
    // the schema cost so the trigger doesn't undercount.
    const fatSchema: ProviderToolDef = {
      name: 'fat',
      description: 'x'.repeat(200),
      input_schema: { type: 'object', properties: {} },
    };
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const messagesOnly = estimateMessagesTokens(messages);
    const withTool = estimatePromptTokens(messages, { tools: [fatSchema] });
    expect(withTool).toBeGreaterThan(messagesOnly);
    expect(withTool).toBeGreaterThan(50); // ~200 chars / 4 + small extras
  });
});
