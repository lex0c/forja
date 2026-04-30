import { describe, expect, test } from 'bun:test';
import type { SubagentDefinition } from '../../src/subagents/types.ts';
import { validateSubagentSet, validateSubagentTools } from '../../src/subagents/validate.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name: 'explore',
  description: 'd',
  tools: [],
  budget: { maxSteps: 1, maxCostUsd: 0 },
  systemPrompt: 'p',
  scope: 'user',
  sourcePath: '/u/explore.md',
  sourceSha256: 'a'.repeat(64),
  meta: {},
  ...overrides,
});

const tool = (name: string, writes: boolean): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes, idempotent: false },
  async execute() {
    return { ok: true };
  },
});

const buildRegistry = (...tools: Tool[]) => {
  const r = createToolRegistry();
  for (const t of tools) r.register(t);
  return r;
};

describe('validateSubagentTools', () => {
  test('accepts a definition whose tools[] are all writes:false', () => {
    const reg = buildRegistry(tool('read_file', false), tool('grep', false));
    const def = definition({ tools: ['read_file', 'grep'] });
    expect(() => validateSubagentTools(def, reg)).not.toThrow();
  });

  test('rejects a tool name that is not registered', () => {
    // Pull-forward of the typo error from runtime to bootstrap.
    // Same shape (programmer mistake) but with a definition-aware
    // message that names the source path.
    const reg = buildRegistry(tool('read_file', false));
    const def = definition({ tools: ['read_file', 'grepp'] });
    expect(() => validateSubagentTools(def, reg)).toThrow(
      /tool 'grepp' is not registered with the active toolset/,
    );
  });

  test('rejects a tool whose metadata.writes is true (capability gate)', () => {
    // The previous name-list approach hardcoded write_file/edit_file/
    // bash family; a newly-added writing tool would slip through.
    // Capability gate fixes that — any tool that opts into
    // metadata.writes inherits the refusal automatically.
    const reg = buildRegistry(tool('read_file', false), tool('write_file', true));
    const def = definition({ tools: ['read_file', 'write_file'] });
    expect(() => validateSubagentTools(def, reg)).toThrow(
      /tool 'write_file' declares metadata.writes=true and cannot appear in subagent.tools\[\] in Step 4\.1/,
    );
  });

  test('rejects a NEW writing tool the old name-list would have missed', () => {
    // Regression for the exact issue the review surfaced: a tool
    // not in the historical name list (write_file, edit_file, bash,
    // bash_background, bash_kill) but with writes:true MUST still
    // be refused. Earlier behavior would have silently allowed
    // `db_write` or any future writing tool.
    const reg = buildRegistry(tool('db_write', true));
    const def = definition({ tools: ['db_write'] });
    expect(() => validateSubagentTools(def, reg)).toThrow(
      /tool 'db_write' declares metadata.writes=true/,
    );
  });

  test('error messages name the offending source path for diagnostics', () => {
    const reg = buildRegistry(tool('write_file', true));
    const def = definition({
      tools: ['write_file'],
      sourcePath: '/home/user/.config/agent/agents/refactor.md',
    });
    expect(() => validateSubagentTools(def, reg)).toThrow(
      /\(\/home\/user\/\.config\/agent\/agents\/refactor\.md\)/,
    );
  });

  test('empty tools[] is valid (subagent without tools is unusual but legal)', () => {
    const reg = buildRegistry(tool('read_file', false));
    const def = definition({ tools: [] });
    expect(() => validateSubagentTools(def, reg)).not.toThrow();
  });
});

describe('validateSubagentSet', () => {
  test('iterates and validates every definition; throws on first violation', () => {
    const reg = buildRegistry(tool('read_file', false), tool('write_file', true));
    const ok = definition({ name: 'explore', tools: ['read_file'] });
    const bad = definition({
      name: 'refactor',
      tools: ['write_file'],
      sourcePath: '/p/refactor.md',
    });
    expect(() => validateSubagentSet([ok, bad], reg)).toThrow(
      /'refactor' \(\/p\/refactor\.md\): tool 'write_file'/,
    );
  });

  test('passes when every definition is clean', () => {
    const reg = buildRegistry(tool('read_file', false));
    const a = definition({ name: 'explore', tools: ['read_file'] });
    const b = definition({ name: 'audit', tools: [] });
    expect(() => validateSubagentSet([a, b], reg)).not.toThrow();
  });
});
