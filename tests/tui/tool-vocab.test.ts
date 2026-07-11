import { describe, expect, test } from 'bun:test';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.ts';
import { TOOL_VOCAB, lookupToolVocab } from '../../src/tui/tool-vocab.ts';

describe('tool-vocab', () => {
  test('every registered builtin tool has a vocab entry (derived from the registry)', () => {
    // Derive from the AUTHORITATIVE registry, not a hand-maintained list. The
    // old hand list silently drifted and hid 8 builtins with no vocab entry
    // (skill_invoke/show/list, reminder/reminder_cancel/reminder_list,
    // retrieve_context, bash_list) — they fell back to the awkward
    // `Called <name>` chip. Deriving from BUILTIN_TOOLS means a new builtin
    // without a vocab entry fails here automatically, no list to update.
    const missing = BUILTIN_TOOLS.filter((t) => TOOL_VOCAB[t.name] === undefined).map(
      (t) => t.name,
    );
    expect(missing).toEqual([]);
  });

  test('lookupToolVocab returns the registered entry when present', () => {
    const v = lookupToolVocab('read_file');
    expect(v.activeVerb).toBe('Reading file');
    expect(v.finalVerb).toBe('Read file');
  });

  test('clarify settles as "Question answered" (not the generic Called verb)', () => {
    const v = lookupToolVocab('clarify');
    expect(v.activeVerb).toBe('Asking');
    expect(v.finalVerb).toBe('Question answered');
    // No subject — the question→answer rides the resultDetail connector.
    expect(v.subject).toBeUndefined();
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

  test('git subject renders the operation (mode + flags + ref + path)', () => {
    const s = TOOL_VOCAB.git?.subject;
    expect(s?.({ mode: 'status' })).toBe('status');
    expect(s?.({ mode: 'log', path: 'src/foo.ts' })).toBe('log src/foo.ts');
    expect(s?.({ mode: 'diff', staged: true })).toBe('diff --staged');
    expect(s?.({ mode: 'diff', stat: true })).toBe('diff --stat');
    expect(s?.({ mode: 'show', ref: 'HEAD~1' })).toBe('show HEAD~1');
    expect(s?.({ mode: 'show_file', ref: 'v1', path: 'old.ts' })).toBe('show_file v1 old.ts');
    expect(s?.({})).toBeNull(); // no mode → no subject
  });

  test('the task_* subagent-orchestration family is silent', () => {
    // `task` is the visible legacy alias of the deferred `task_sync` and is the
    // name the model actually invokes — it must be silent too, else its
    // `Delegating · <name>` card stacks redundantly next to the live Subagents
    // block.
    for (const name of [
      'task',
      'task_sync',
      'task_async',
      'task_await',
      'task_cancel',
      'task_list',
    ]) {
      expect(TOOL_VOCAB[name]?.silent).toBe(true);
    }
    // Both delegation entry points keep revealFailure so a pre-spawn failure
    // (no child, hence no Subagents block) stays visible.
    expect(TOOL_VOCAB.task?.revealFailure).toBe(true);
    expect(TOOL_VOCAB.task_sync?.revealFailure).toBe(true);
  });

  test('skill_invoke / skill_show surface the skill name as subject', () => {
    // So the chip reads `Invoked skill · review-diff`, not the contentless
    // `Called skill_invoke` — the operator sees WHICH skill ran.
    expect(TOOL_VOCAB.skill_invoke?.subject?.({ name: 'review-diff' })).toBe('review-diff');
    expect(TOOL_VOCAB.skill_show?.subject?.({ name: 'review-diff' })).toBe('review-diff');
    expect(TOOL_VOCAB.skill_invoke?.finalVerb).toBe('Invoked skill');
    expect(TOOL_VOCAB.skill_invoke?.subject?.({})).toBeNull();
  });

  test('working_state_update is silent on success but reveals failures', () => {
    // Success feedback is the `working_state_updated` event → scrollback panel
    // block, so the per-call chip is silent. revealFailure keeps a rejected
    // update visible (no success event fires for it, so it would otherwise
    // vanish entirely).
    expect(TOOL_VOCAB.working_state_update?.silent).toBe(true);
    expect(TOOL_VOCAB.working_state_update?.revealFailure).toBe(true);
    expect(TOOL_VOCAB.working_state_update?.finalVerb).toBe('Updated working state');
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
