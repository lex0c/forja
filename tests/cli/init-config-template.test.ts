import { describe, expect, test } from 'bun:test';
import { renderInitConfigTemplate } from '../../src/cli/init-config-template.ts';

describe('renderInitConfigTemplate', () => {
  test('parses as valid TOML', () => {
    // Guard against typos that break the rendered file's syntax.
    // The scaffold today is pure comments — the parser walks an
    // empty doc — but stray unbalanced brackets in any future
    // value would surface here.
    expect(() => Bun.TOML.parse(renderInitConfigTemplate())).not.toThrow();
  });

  test('parses to an empty config (slim scaffold posture)', () => {
    // Mechanical pin of AGENTIC_CLI.md §2.1.1: the scaffold writes
    // no inline sections. Discovery lives in the spec, not in the
    // file. If a future change adds an active toggle to the
    // scaffold, this test fails — the operator would lose those
    // values on the next `/memory governance` toggle (round-trip
    // normalizes formatting and the comment justifying the toggle
    // would vanish; only the value would survive).
    expect(Bun.TOML.parse(renderInitConfigTemplate())).toEqual({});
  });

  test('does NOT inline active toggle keys (slim scaffold)', () => {
    // Slim scaffold posture from §2.1.1: per-toggle documentation
    // lives in the spec, not in the rendered file. Key names and
    // example values must stay out so the `/memory governance`
    // round-trip doesn't silently delete a richly-commented
    // scaffold on its first invocation. The prose IS allowed to
    // mention the section names by reference (e.g. "Add a [memory]
    // section to override defaults") since those words don't
    // affect the no-op parse posture — the structural pin is in
    // the "parses to an empty config" test.
    const rendered = renderInitConfigTemplate();
    expect(rendered).not.toContain('verify_semantic_llm');
    expect(rendered).not.toContain('conflict_detect_llm');
    expect(rendered).not.toContain('override_detect_llm');
    expect(rendered).not.toContain('on_writes');
    expect(rendered).not.toContain('prompt_version');
  });

  test('points at the spec section for the schema reference', () => {
    // The slim scaffold's only job is to direct the operator to
    // the canonical schema location. A regression that drops this
    // pointer leaves an operator opening the file with no path
    // forward.
    expect(renderInitConfigTemplate()).toContain('AGENTIC_CLI.md §2.1.1');
  });

  test('warns operators that slash toggles do not preserve comments', () => {
    // Honest UX: the round-trip behavior of `/memory governance`
    // (Bun.TOML.parse drops comments) is documented inline so an
    // operator who adds notes here learns about the loss BEFORE
    // running a toggle, not after.
    const rendered = renderInitConfigTemplate();
    expect(rendered).toContain('/memory governance');
    expect(rendered).toContain('comments NOT preserved');
  });

  test('ends with a trailing newline', () => {
    // POSIX text-file convention; matters for diff hygiene when
    // an operator first opens the file and their editor would
    // otherwise append one on save.
    expect(renderInitConfigTemplate()).toMatch(/\n$/);
  });
});
