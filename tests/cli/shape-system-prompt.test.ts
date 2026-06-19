import { describe, expect, test } from 'bun:test';
import type { AcquiredGuide } from '../../src/cli/project-context.ts';
import { type SystemInputs, shapeSystemPrompt } from '../../src/cli/shape-system-prompt.ts';

// Acquire/shape split (CONTEXT_TUNING §2.2). shapeSystemPrompt is the pure,
// per-turn function of (inputs, window): it re-clips the guide and recomposes.
const guide = (body: string): AcquiredGuide => ({
  name: 'AGENTS.md',
  path: '/repo/AGENTS.md',
  safePath: '/repo/AGENTS.md',
  body,
  truncatedAtAcquisition: false,
});

const inputs = (over: Partial<SystemInputs> = {}): SystemInputs => ({
  stablePrefix: 'STABLE PREFIX',
  memorySegmentText: '# Memory\n\n- [user] role — dev',
  ...over,
});

const LARGE = 200_000;
const SMALL = 32_000; // guideMaxBytes ≈ 12800 bytes

describe('shapeSystemPrompt', () => {
  test('segments flatten to the system string (CONTEXT_TUNING §3.1 invariant)', () => {
    const out = shapeSystemPrompt(inputs({ acquiredGuide: guide('a'.repeat(2000)) }), LARGE);
    const flattened = (out.systemSegments ?? []).map((s) => s.text).join('\n\n');
    expect(out.system).toBe(flattened);
  });

  test('two cache breakpoints: a stable segment and a memory segment', () => {
    const out = shapeSystemPrompt(inputs({ acquiredGuide: guide('hi') }), LARGE);
    expect(out.systemSegments?.map((s) => s.id)).toEqual(['stable', 'memory']);
    expect(out.systemSegments?.every((s) => s.cacheBreakpoint === true)).toBe(true);
  });

  test('the guide rides the stable segment, not the memory segment', () => {
    const out = shapeSystemPrompt(inputs({ acquiredGuide: guide('GUIDE_BODY_MARKER') }), LARGE);
    const stable = out.systemSegments?.find((s) => s.id === 'stable');
    expect(stable?.text).toContain('GUIDE_BODY_MARKER');
    expect(stable?.text).toContain('STABLE PREFIX');
  });

  test('epoch stability: same window → byte-identical system + hash', () => {
    const i = inputs({ acquiredGuide: guide('a'.repeat(20_000)) });
    const a = shapeSystemPrompt(i, SMALL);
    const b = shapeSystemPrompt(i, SMALL);
    expect(a.system).toBe(b.system);
    expect(a.systemPromptHash).toBe(b.systemPromptHash);
  });

  test('a large guide re-clips smaller on a small window (different bytes + hash)', () => {
    // 20KB body: large window clips to the 16KB absolute cap; small window
    // clips further to ~12.8KB. Different bytes → different hash.
    const i = inputs({ acquiredGuide: guide('a'.repeat(20_000)) });
    const big = shapeSystemPrompt(i, LARGE);
    const small = shapeSystemPrompt(i, SMALL);
    expect(small.system).not.toBe(big.system);
    expect(small.systemPromptHash).not.toBe(big.systemPromptHash);
    expect((small.system ?? '').length).toBeLessThan((big.system ?? '').length);
    // Both are truncated (over the absolute cap), so both carry the marker.
    expect(small.system).toContain('truncated at');
  });

  test('a guide that fits is identical across windows (no window effect)', () => {
    // 2KB body < the small-window budget → no clip on either window.
    const i = inputs({ acquiredGuide: guide('a'.repeat(2_000)) });
    expect(shapeSystemPrompt(i, SMALL).system).toBe(shapeSystemPrompt(i, LARGE).system);
  });

  test('no guide: system is prefix + memory segment, window-independent', () => {
    const out = shapeSystemPrompt(inputs(), SMALL);
    expect(out.system).toBe('STABLE PREFIX\n\n# Memory\n\n- [user] role — dev');
    expect(out.systemSegments?.map((s) => s.id)).toEqual(['stable', 'memory']);
    expect(shapeSystemPrompt(inputs(), SMALL).system).toBe(
      shapeSystemPrompt(inputs(), LARGE).system,
    );
  });
});
