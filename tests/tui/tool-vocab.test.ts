import { describe, expect, test } from 'bun:test';
import { TOOL_VOCAB, lookupToolVocab } from '../../src/tui/tool-vocab.ts';

describe('tool-vocab', () => {
  test('every builtin tool name has a registered vocab entry', () => {
    // Add to this list when registering a new builtin tool — keeps
    // the vocab table in lockstep with `src/tools/builtin/`.
    const builtins = [
      'bash',
      'bash_background',
      'bash_kill',
      'bash_output',
      'edit_file',
      'glob',
      'grep',
      'memory_list',
      'memory_read',
      'memory_search',
      'memory_write',
      'monitor',
      'read_file',
      'task',
      'todo_clear',
      'todo_create',
      'todo_get',
      'todo_list',
      'todo_update',
      'wait_for',
      'write_file',
    ];
    for (const name of builtins) {
      expect(TOOL_VOCAB[name]).toBeDefined();
    }
  });

  test('lookupToolVocab returns the registered entry when present', () => {
    const v = lookupToolVocab('read_file');
    expect(v.activeVerb).toBe('Reading file');
    expect(v.finalVerb).toBe('Read file');
  });

  test('lookupToolVocab falls back to generic verbs for unknown names', () => {
    const v = lookupToolVocab('made_up_tool');
    expect(v.activeVerb).toBe('Calling made_up_tool');
    expect(v.finalVerb).toBe('Called made_up_tool');
    expect(v.subject).toBeUndefined();
  });

  test('subject extractors return null when args lack the expected field', () => {
    const v = lookupToolVocab('read_file');
    expect(v.subject?.({})).toBeNull();
    expect(v.subject?.({ path: 123 })).toBeNull();
    expect(v.subject?.({ path: '' })).toBeNull();
    expect(v.subject?.({ path: '/x.ts' })).toBe('/x.ts');
  });

  test('bash subject is the command argument', () => {
    expect(TOOL_VOCAB.bash?.subject?.({ command: 'rg foo' })).toBe('rg foo');
  });

  test('memory_list surfaces scope: <name> as subject', () => {
    expect(TOOL_VOCAB.memory_list?.subject?.({ scope: 'project_local' })).toBe(
      'scope: project_local',
    );
  });

  test('memory_write surfaces scope/name as subject', () => {
    expect(
      TOOL_VOCAB.memory_write?.subject?.({ scope: 'project_local', name: 'no-console-log' }),
    ).toBe('project_local/no-console-log');
    // Falls back to whichever side is present.
    expect(TOOL_VOCAB.memory_write?.subject?.({ name: 'just-name' })).toBe('just-name');
    expect(TOOL_VOCAB.memory_write?.subject?.({ scope: 'user' })).toBe('user');
    expect(TOOL_VOCAB.memory_write?.subject?.({})).toBeNull();
  });

  test('bash_output / bash_kill format pid as `pid <id>`', () => {
    expect(TOOL_VOCAB.bash_output?.subject?.({ process_id: '12345' })).toBe('pid 12345');
    expect(TOOL_VOCAB.bash_kill?.subject?.({ process_id: '999' })).toBe('pid 999');
  });

  test('task prefers subagent name, falls back to prompt', () => {
    // Real fields per src/tools/builtin/task.ts: `subagent` + `prompt`.
    expect(TOOL_VOCAB.task?.subject?.({ subagent: 'reviewer', prompt: 'audit' })).toBe('reviewer');
    expect(TOOL_VOCAB.task?.subject?.({ prompt: 'audit' })).toBe('audit');
    expect(TOOL_VOCAB.task?.subject?.({})).toBeNull();
  });

  test('todo_create has no subject extractor (the count goes elsewhere)', () => {
    expect(TOOL_VOCAB.todo_create?.subject).toBeUndefined();
  });

  // Discriminated-union tools (monitor, wait_for) take a nested
  // `condition: {kind, ...}` object. Subject surfaces the kind so the
  // operator sees what shape of wait/monitor is in flight without
  // expanding.
  describe('nested condition.kind extractors', () => {
    test('monitor surfaces condition.kind as `kind: <name>`', () => {
      expect(
        TOOL_VOCAB.monitor?.subject?.({
          condition: { kind: 'process_output_lines', process_id: 'p1' },
          duration_ms: 1000,
        }),
      ).toBe('kind: process_output_lines');
    });

    test('monitor returns null when condition is missing or non-object', () => {
      expect(TOOL_VOCAB.monitor?.subject?.({ duration_ms: 1000 })).toBeNull();
      expect(TOOL_VOCAB.monitor?.subject?.({ condition: 'oops', duration_ms: 1000 })).toBeNull();
      expect(TOOL_VOCAB.monitor?.subject?.({ condition: null, duration_ms: 1000 })).toBeNull();
    });

    test('wait_for surfaces condition.kind for sleep / file_exists / process_exit / etc.', () => {
      expect(
        TOOL_VOCAB.wait_for?.subject?.({
          condition: { kind: 'sleep', duration_ms: 500 },
          timeout_ms: 1000,
        }),
      ).toBe('kind: sleep');
      expect(
        TOOL_VOCAB.wait_for?.subject?.({
          condition: { kind: 'file_exists', path: '/tmp/x' },
          timeout_ms: 1000,
        }),
      ).toBe('kind: file_exists');
      expect(
        TOOL_VOCAB.wait_for?.subject?.({
          condition: { kind: 'process_exit', process_id: 'p1' },
          timeout_ms: 1000,
        }),
      ).toBe('kind: process_exit');
    });
  });
});
