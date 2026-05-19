import { describe, expect, test } from 'bun:test';
import {
  type InitConfigDefaults,
  renderInitConfigTemplate,
} from '../../src/cli/init-config-template.ts';
import { DEFAULT_MEMORY_CONFIG } from '../../src/critique/config-loader.ts';
import { DEFAULT_CRITIQUE_CONFIG } from '../../src/critique/types.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';
import { DEFAULT_MODEL } from '../../src/providers/default-model.ts';

// Canonical fixture sourced from the same constants the production
// orchestrator (init.ts scaffoldConfig) hands to the renderer. Pinning
// the test against the real defaults catches drift in either
// direction — if the renderer stops emitting a section the constants
// declare, the parse-back checks fail; if a constant grows a field
// the renderer doesn't know how to render, typecheck surfaces it.
const defaults = (): InitConfigDefaults => ({
  model: DEFAULT_MODEL,
  budget: DEFAULT_BUDGET,
  memory: DEFAULT_MEMORY_CONFIG,
  critique: DEFAULT_CRITIQUE_CONFIG,
});

describe('renderInitConfigTemplate', () => {
  test('parses as valid TOML', () => {
    // Guard against typos / unbalanced brackets in the rendered
    // file. The renderer interpolates values directly into a
    // template string; a future bug that produces malformed TOML
    // surfaces here before the operator's `agent` boot hits the
    // loader's parse error.
    expect(() => Bun.TOML.parse(renderInitConfigTemplate(defaults()))).not.toThrow();
  });

  test('parses to a populated config with all four sections', () => {
    // Spec posture (AGENTIC_CLI.md §2.1.1, post-rich-scaffold): the
    // scaffolded file carries ACTIVE values for every operator-
    // tunable section so the operator opens it and sees the running
    // config literally. Empty-parse would mean we regressed back
    // to the slim shape.
    const parsed = Bun.TOML.parse(renderInitConfigTemplate(defaults())) as Record<string, unknown>;
    expect(parsed.providers).toBeDefined();
    expect(parsed.budget).toBeDefined();
    expect(parsed.memory).toBeDefined();
    expect(parsed.critique).toBeDefined();
  });

  test('[providers].model matches DEFAULT_MODEL', () => {
    const parsed = Bun.TOML.parse(renderInitConfigTemplate(defaults())) as {
      providers: { model: string };
    };
    expect(parsed.providers.model).toBe(DEFAULT_MODEL);
  });

  test('[budget] values match DEFAULT_BUDGET (six operator-tunable keys)', () => {
    const parsed = Bun.TOML.parse(renderInitConfigTemplate(defaults())) as {
      budget: Record<string, unknown>;
    };
    expect(parsed.budget.max_steps).toBe(DEFAULT_BUDGET.maxSteps);
    expect(parsed.budget.max_cost_usd).toBe(DEFAULT_BUDGET.maxCostUsd);
    expect(parsed.budget.max_wall_clock_ms).toBe(DEFAULT_BUDGET.maxWallClockMs);
    expect(parsed.budget.max_step_stall_ms).toBe(DEFAULT_BUDGET.maxStepStallMs);
    expect(parsed.budget.compaction_threshold).toBe(DEFAULT_BUDGET.compactionThreshold);
    expect(parsed.budget.compaction_preserve_tail).toBe(DEFAULT_BUDGET.compactionPreserveTail);
  });

  test('[memory] values match DEFAULT_MEMORY_CONFIG (all three governance detectors)', () => {
    const parsed = Bun.TOML.parse(renderInitConfigTemplate(defaults())) as {
      memory: Record<string, unknown>;
    };
    expect(parsed.memory.verify_semantic_llm).toBe(DEFAULT_MEMORY_CONFIG.verifySemanticLlm);
    expect(parsed.memory.conflict_detect_llm).toBe(DEFAULT_MEMORY_CONFIG.conflictDetectLlm);
    expect(parsed.memory.override_detect_llm).toBe(DEFAULT_MEMORY_CONFIG.overrideDetectLlm);
  });

  test('[critique] values match DEFAULT_CRITIQUE_CONFIG', () => {
    const parsed = Bun.TOML.parse(renderInitConfigTemplate(defaults())) as {
      critique: Record<string, unknown>;
    };
    expect(parsed.critique.mode).toBe(DEFAULT_CRITIQUE_CONFIG.mode);
    expect(parsed.critique.threshold).toBe(DEFAULT_CRITIQUE_CONFIG.threshold);
    expect(parsed.critique.max_overhead_ms).toBe(DEFAULT_CRITIQUE_CONFIG.maxOverheadMs);
  });

  test('scaffold contains NO comments (slash round-trip would kill them)', () => {
    // Justification: `/memory governance enable|disable` rewrites
    // this file via `Bun.TOML.parse → mutate → emit` and
    // Bun.TOML.parse does not preserve comments. Shipping comments
    // is a false promise — they vanish on the first slash toggle.
    // The renderer must NEVER emit a `#` line into the scaffold.
    const rendered = renderInitConfigTemplate(defaults());
    // Split on newlines; every non-empty line must begin with
    // either a section header `[…]` or a `key = value` form.
    // A stray `#`-prefix anywhere fails this.
    const lines = rendered.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*#/);
    }
  });

  test('omits max_cost_usd when caller passes undefined (opt-out marker)', () => {
    // The RunBudget.maxCostUsd docstring (harness/types.ts:484)
    // distinguishes "absent" (defaults to 5) from "undefined"
    // (operator opt-out, no cap). The renderer must skip the
    // line in the latter case so the scaffold doesn't write
    // `max_cost_usd = undefined` as literal text or `undefined`
    // as a TOML value.
    const optOut: InitConfigDefaults = {
      ...defaults(),
      budget: { ...DEFAULT_BUDGET, maxCostUsd: undefined },
    };
    const rendered = renderInitConfigTemplate(optOut);
    expect(rendered).not.toContain('max_cost_usd');
    expect(rendered).not.toContain('undefined');
    // Other [budget] keys still render.
    expect(rendered).toContain('max_steps');
  });

  test('ends with a trailing newline', () => {
    expect(renderInitConfigTemplate(defaults())).toMatch(/\n$/);
  });
});
