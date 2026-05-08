import { describe, expect, test } from 'bun:test';
import { composeWithTaskDiscipline } from '../../src/cli/task-discipline.ts';

// Pin the contract: composer always emits the discipline section
// (no opt-out — the guidance applies regardless of whether the
// operator supplied a base prompt). Header text and the load-
// bearing nudges (prefer editing, no premature abstractions, etc)
// are pinned so a softening rewrite shows up at PR review.

describe('composeWithTaskDiscipline', () => {
  test('emits the discipline section when downstream is undefined', () => {
    const out = composeWithTaskDiscipline(undefined);
    expect(out).toContain('# Task discipline');
    expect(out).toContain('Prefer editing existing files over creating new ones');
  });

  test('emits the discipline section when downstream is empty', () => {
    const out = composeWithTaskDiscipline('');
    expect(out).toContain('# Task discipline');
  });

  test('prepends the section to a non-empty downstream with a blank-line separator', () => {
    const out = composeWithTaskDiscipline('caller body');
    expect(out.startsWith('# Task discipline')).toBe(true);
    expect(out.endsWith('caller body')).toBe(true);
    expect(out).toContain('\n\ncaller body');
  });

  test('pins the load-bearing behavioral nudges', () => {
    // These specific phrases drive the output-quality difference.
    // A regression that softens any of them shows up here. The
    // exact wording isn't load-bearing — what matters is that
    // each behavioral rule has SOME presence in the section.
    const out = composeWithTaskDiscipline(undefined);
    expect(out).toContain('Prefer editing');
    expect(out).toContain("Don't introduce abstractions");
    expect(out).toContain('Default to writing no comments');
    expect(out).toContain('the WHY is non-obvious');
    expect(out).toContain("Don't add error handling");
    expect(out).toContain("Don't add backwards-compatibility");
  });

  test('reminds the model to close active todos before the final answer', () => {
    // Without this nudge, long turns where the workflow shifts
    // mid-flight (e.g. a delegated subagent crashes and the model
    // recovers manually) routinely end with the last todo stuck
    // in `in_progress`, signaling abandoned work to the operator
    // even when the visible answer is complete.
    const out = composeWithTaskDiscipline(undefined);
    expect(out).toMatch(/close any active todos/i);
    expect(out).toContain('todo_write');
    // Vocabulary check: rule must use the actual TodoStatus
    // values (`done`, `pending`, `in_progress`), not invented
    // synonyms like `completed` / `abandoned` that todo_write
    // would reject. A drift here would teach the model to call
    // todo_write with invalid args.
    expect(out).toContain('`done`');
    expect(out).toContain('`pending`');
    expect(out).toContain('`in_progress`');
  });

  test('section size is reasonable (~200 tokens / ~1.5k chars)', () => {
    // Section sits inside cache breakpoint #1 — bigger means
    // more cached input but also more attention budget consumed
    // before the model gets to task-specific instructions. The
    // close-todos bullet pushed us past the prior 1500-char
    // ceiling; 2000 chars stays under ~250 tokens which is still
    // a small fraction of the 200k context window.
    const out = composeWithTaskDiscipline(undefined);
    expect(out.length).toBeLessThan(2000);
  });
});
