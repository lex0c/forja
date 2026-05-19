import { describe, expect, test } from 'bun:test';
import { renderInitConfigTemplate } from '../../src/cli/init-config-template.ts';

describe('renderInitConfigTemplate', () => {
  test('parses as valid TOML', () => {
    // Guard against typos that break the rendered file's syntax.
    // Every value-bearing line is commented today, so the parser
    // only walks the structural skeleton — but a stray unbalanced
    // bracket in the example values would still surface here once
    // an operator uncomments.
    expect(() => Bun.TOML.parse(renderInitConfigTemplate())).not.toThrow();
  });

  test('parses to an empty config until operator uncomments keys', () => {
    // Mechanical pin of the spec posture from AGENTIC_CLI.md §2.1.1
    // ("every key commented; defaults live in code; file is no-op
    // until edited"). If any key ever lands uncommented in the
    // template, this fails — surfaces the deviation in CI before it
    // ships to operator repos.
    expect(Bun.TOML.parse(renderInitConfigTemplate())).toEqual({});
  });

  test('documents [memory] governance section with all three toggles', () => {
    const rendered = renderInitConfigTemplate();
    expect(rendered).toContain('[memory]');
    expect(rendered).toContain('verify_semantic_llm');
    expect(rendered).toContain('conflict_detect_llm');
    expect(rendered).toContain('override_detect_llm');
  });

  test('documents [critique] section with the four config keys', () => {
    const rendered = renderInitConfigTemplate();
    expect(rendered).toContain('[critique]');
    expect(rendered).toContain('mode');
    expect(rendered).toContain('threshold');
    expect(rendered).toContain('model');
    expect(rendered).toContain('prompt_version');
  });

  test('references the spec section in the header', () => {
    // The template is the operator's first encounter with the schema;
    // pointing back to the spec keeps the discovery loop tight and
    // prevents drift from being silent.
    expect(renderInitConfigTemplate()).toContain('AGENTIC_CLI.md §2.1.1');
  });

  test('ends with a trailing newline', () => {
    // POSIX text-file convention; matters for diff hygiene when an
    // operator first opens the file and their editor would otherwise
    // append one on save.
    expect(renderInitConfigTemplate()).toMatch(/\n$/);
  });
});
