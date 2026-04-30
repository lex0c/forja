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
  isolation: 'none',
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
      /tool 'write_file' declares metadata.writes=true and cannot appear in subagent.tools\[\] without 'isolation: worktree'/,
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

  test("isolation: 'worktree' lifts the writes:true gate (writing tools accepted)", () => {
    // The whole point of declaring worktree isolation: the child
    // runs in a dedicated branch+tree so its writes can no longer
    // pollute the parent. Without this gate-lift, no subagent
    // could ever use write_file/edit_file/bash, defeating the
    // worktree feature.
    const reg = buildRegistry(tool('read_file', false), tool('write_file', true));
    const def = definition({
      tools: ['read_file', 'write_file'],
      isolation: 'worktree',
    });
    expect(() => validateSubagentTools(def, reg)).not.toThrow();
  });

  test("isolation: 'worktree' still rejects unregistered tool names", () => {
    // Worktree only changes the writes:true rule — the registry
    // sanity check still applies. A typo in `tools[]` is a
    // programmer error regardless of isolation strategy.
    const reg = buildRegistry(tool('read_file', false));
    const def = definition({
      tools: ['read_file', 'grepp'],
      isolation: 'worktree',
    });
    expect(() => validateSubagentTools(def, reg)).toThrow(
      /tool 'grepp' is not registered with the active toolset/,
    );
  });

  test("isolation: 'none' (default) keeps the writes:true refusal", () => {
    // The legacy contract: no isolation declared (or explicit
    // 'none') means writing tools are still refused. Locks in the
    // Step 4.1 invariant against accidental regression when the
    // worktree path expands.
    const reg = buildRegistry(tool('write_file', true));
    const defImplicit = definition({ tools: ['write_file'] });
    expect(() => validateSubagentTools(defImplicit, reg)).toThrow(
      /tool 'write_file' declares metadata\.writes=true/,
    );
    const defExplicit = definition({ tools: ['write_file'], isolation: 'none' });
    expect(() => validateSubagentTools(defExplicit, reg)).toThrow(
      /tool 'write_file' declares metadata\.writes=true/,
    );
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
