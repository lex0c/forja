import { describe, expect, test } from 'bun:test';
import { buildAssistantContent } from '../../src/harness/assistant-content.ts';
import type { CollectedStep } from '../../src/harness/collect.ts';

const step = (
  over: Partial<CollectedStep>,
): Pick<CollectedStep, 'reasoning' | 'text' | 'tool_uses'> => ({
  reasoning: [],
  text: '',
  tool_uses: [],
  ...over,
});

const reasoning = (data: unknown) => ({ type: 'reasoning', provider: 'anthropic', data }) as const;

describe('buildAssistantContent', () => {
  test('reasoning first, then text, then tool_uses', () => {
    const out = buildAssistantContent(
      step({
        reasoning: [reasoning({ thinking: 't', signature: 's' })],
        text: 'hello',
        tool_uses: [{ id: 'c1', name: 'read', input: { path: '/x' } }],
      }),
    );
    expect(out.map((b) => b.type)).toEqual(['reasoning', 'text', 'tool_use']);
  });

  test('omits reasoning on a no-text/no-tool turn (would serialize to empty wire content)', () => {
    // A reasoning-only turn ends the loop; keeping the block would yield an
    // assistant message that a non-replaying converter drops to `[]` → 400.
    const out = buildAssistantContent(
      step({ reasoning: [reasoning({ thinking: 't', signature: 's' })] }),
    );
    expect(out).toEqual([]);
  });

  test('keeps reasoning when accompanied by a tool_use even with empty text', () => {
    const out = buildAssistantContent(
      step({
        reasoning: [reasoning({ thinking: 't', signature: 's' })],
        tool_uses: [{ id: 'c1', name: 'read', input: { path: '/x' } }],
      }),
    );
    expect(out.map((b) => b.type)).toEqual(['reasoning', 'tool_use']);
  });

  test('reasoning data is carried VERBATIM (not canonicalized)', () => {
    // Key order preserved — signatures/encrypted items must round-trip byte-equal.
    const data = { z: 1, a: 2, signature: 'sig' };
    const out = buildAssistantContent(step({ reasoning: [reasoning(data)], text: 'x' }));
    const block = out[0] as { data: unknown };
    expect(block.data).toBe(data);
  });

  test('canonicalizes tool_use input keys (stable cache prefix)', () => {
    const out = buildAssistantContent(
      step({ text: 'x', tool_uses: [{ id: 'c1', name: 'read', input: { b: 1, a: 2 } }] }),
    );
    const tu = out.find((b) => b.type === 'tool_use') as { input: Record<string, unknown> };
    expect(Object.keys(tu.input)).toEqual(['a', 'b']);
  });

  test('empty step → empty content', () => {
    expect(buildAssistantContent(step({}))).toEqual([]);
  });

  describe('order-preserving (interleaved thinking)', () => {
    test('keeps thinking interleaved with tool_use (thinking1, tool1, thinking2, tool2)', () => {
      // The case Anthropic 400s on if reordered: grouping reasoning-first would
      // emit thinking1, thinking2, tool1, tool2. `order` must be honored exactly.
      const r1 = reasoning({ thinking: 't1', signature: 's1' });
      const r2 = reasoning({ thinking: 't2', signature: 's2' });
      const tu1 = { id: 'c1', name: 'read', input: { p: '/a' } };
      const tu2 = { id: 'c2', name: 'read', input: { p: '/b' } };
      const out = buildAssistantContent({
        reasoning: [r1, r2],
        text: '',
        tool_uses: [tu1, tu2],
        order: [
          { kind: 'reasoning', reasoning: r1 },
          { kind: 'tool_use', toolUse: tu1 },
          { kind: 'reasoning', reasoning: r2 },
          { kind: 'tool_use', toolUse: tu2 },
        ],
      });
      expect(out.map((b) => b.type)).toEqual(['reasoning', 'tool_use', 'reasoning', 'tool_use']);
      // Reasoning data carried verbatim, in position.
      expect((out[0] as { data: unknown }).data).toBe(r1.data);
      expect((out[2] as { data: unknown }).data).toBe(r2.data);
    });

    test('order with only reasoning (no text/tool) → omitted', () => {
      const r1 = reasoning({ thinking: 't', signature: 's' });
      const out = buildAssistantContent({
        reasoning: [r1],
        text: '',
        tool_uses: [],
        order: [{ kind: 'reasoning', reasoning: r1 }],
      });
      expect(out).toEqual([]);
    });

    test('canonicalizes tool_use input in the ordered path', () => {
      const tu = { id: 'c1', name: 'read', input: { b: 1, a: 2 } };
      const out = buildAssistantContent({
        reasoning: [],
        text: '',
        tool_uses: [tu],
        order: [{ kind: 'tool_use', toolUse: tu }],
      });
      const block = out.find((b) => b.type === 'tool_use') as { input: Record<string, unknown> };
      expect(Object.keys(block.input)).toEqual(['a', 'b']);
    });
  });
});
