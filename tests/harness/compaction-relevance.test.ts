import { describe, expect, test } from 'bun:test';
import { relevanceElideMiddle } from '../../src/harness/compaction-relevance.ts';
import type { ProviderContentBlock, ProviderMessage } from '../../src/providers/index.ts';

// Pure scorer for the relevance compaction strategy. The contract:
// keep high-goal-relevance tool_result bodies verbatim within a byte
// budget, pointer the rest, NEVER touch errors / text / tool_use, and
// stay deterministic (clock-free) so the compaction replay path
// reproduces the same partition.

type ToolResultBlock = Extract<ProviderContentBlock, { type: 'tool_result' }>;

const big = (seed: string): string => `${seed} `.repeat(120); // > min elide (200B)
const toolResult = (id: string, content: string, isError = false): ProviderContentBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});
const userBlocks = (blocks: ProviderContentBlock[]): ProviderMessage => ({
  role: 'user',
  content: blocks,
});

// Safe accessors — the suite runs under strict noUncheckedIndexedAccess.
const blocksOf = (m: ProviderMessage | undefined): ProviderContentBlock[] => {
  if (m === undefined || typeof m.content === 'string') throw new Error('expected block content');
  return m.content;
};
const trAt = (m: ProviderMessage | undefined, i = 0): string => {
  const b = blocksOf(m)[i];
  if (b === undefined || b.type !== 'tool_result') throw new Error('expected tool_result block');
  return b.content;
};
const isElided = (s: string): boolean => s.startsWith('[tool_result elided:');
const isTR = (b: ProviderContentBlock): b is ToolResultBlock => b.type === 'tool_result';

const RELEVANT = big('authentication token validate session');
const IRRELEVANT = big('lorem ipsum dolor sit amet consectetur');
const GOAL = 'fix the authentication token validation in the session layer';

describe('relevanceElideMiddle', () => {
  test('keeps the goal-relevant result verbatim and elides the irrelevant one under budget', () => {
    // Relevant result is FIRST (least recent) so we prove relevance —
    // not recency — wins the single budget slot.
    const middle = [
      userBlocks([toolResult('rel', RELEVANT)]),
      userBlocks([toolResult('irr', IRRELEVANT)]),
    ];
    const out = relevanceElideMiddle(middle, {
      goalText: GOAL,
      verbatimBudgetBytes: Buffer.byteLength(RELEVANT, 'utf8') + 10,
    });
    expect(out.elidedCount).toBe(1);
    expect(out.keptCount).toBe(1);
    expect(trAt(out.middle[0])).toBe(RELEVANT); // kept verbatim
    expect(isElided(trAt(out.middle[1]))).toBe(true);
    // The pointer names the recovery path (retrieve_context), so the model
    // reads the body back instead of assuming it is gone — the exact confusion
    // a real session hit when the pointer said only "original in audit log".
    expect(trAt(out.middle[1])).toContain('retrieve_context');
  });

  test('never elides an error result, even when irrelevant and over budget', () => {
    const middle = [userBlocks([toolResult('err', IRRELEVANT, true)])];
    const out = relevanceElideMiddle(middle, { goalText: GOAL, verbatimBudgetBytes: 0 });
    expect(out.elidedCount).toBe(0);
    expect(trAt(out.middle[0])).toBe(IRRELEVANT);
    expect(out.middle).toBe(middle); // untouched → same reference
  });

  test('never elides a result at or below the min size', () => {
    const middle = [userBlocks([toolResult('small', 'tiny output')])];
    const out = relevanceElideMiddle(middle, { goalText: GOAL, verbatimBudgetBytes: 0 });
    expect(out.elidedCount).toBe(0);
    expect(out.middle).toBe(middle);
  });

  test('respects the verbatim byte budget (kept bodies never exceed it)', () => {
    const bodies = ['a', 'b', 'c', 'd'].map((s) => big(s));
    const middle = bodies.map((b, i) => userBlocks([toolResult(`t${i}`, b)]));
    const oneBody = Buffer.byteLength(bodies[0] ?? '', 'utf8');
    const budget = oneBody * 2 + 5; // room for ~2 of 4
    const out = relevanceElideMiddle(middle, {
      goalText: 'unrelated query',
      verbatimBudgetBytes: budget,
    });
    const keptBytes = out.middle
      .flatMap(blocksOf)
      .filter(isTR)
      .filter((b) => !isElided(b.content))
      .reduce((n, b) => n + Buffer.byteLength(b.content, 'utf8'), 0);
    expect(keptBytes).toBeLessThanOrEqual(budget);
    expect(out.keptCount).toBe(2);
    expect(out.elidedCount).toBe(2);
  });

  test('is deterministic — same input yields an identical partition', () => {
    const middle = ['x', 'y', 'z'].map((s, i) => userBlocks([toolResult(`id${i}`, big(s))]));
    const opts = { goalText: GOAL, verbatimBudgetBytes: 300 };
    const a = relevanceElideMiddle(middle, opts);
    const b = relevanceElideMiddle(middle, opts);
    expect(JSON.stringify(a.middle)).toBe(JSON.stringify(b.middle));
    expect([a.elidedCount, a.keptCount, a.freedBytes]).toEqual([
      b.elidedCount,
      b.keptCount,
      b.freedBytes,
    ]);
  });

  test('returns the middle untouched when there are no tool_results', () => {
    const middle: ProviderMessage[] = [
      { role: 'assistant', content: 'just text reasoning' },
      userBlocks([{ type: 'text', text: 'a text block' }]),
    ];
    const out = relevanceElideMiddle(middle, { goalText: GOAL, verbatimBudgetBytes: 0 });
    expect(out).toEqual({ middle, elidedCount: 0, keptCount: 0, freedBytes: 0, elidedIds: [] });
    expect(out.middle).toBe(middle);
  });

  test('with an empty goal, recency decides — the most recent result is kept', () => {
    const middle = [
      userBlocks([toolResult('older', big('alpha'))]),
      userBlocks([toolResult('newer', big('beta'))]),
    ];
    const out = relevanceElideMiddle(middle, {
      goalText: '',
      verbatimBudgetBytes: Buffer.byteLength(big('beta'), 'utf8') + 10,
    });
    expect(isElided(trAt(out.middle[0]))).toBe(true); // older pointered
    expect(trAt(out.middle[1])).toBe(big('beta')); // newer kept
  });

  test('leaves text and tool_use blocks byte-identical (object identity preserved)', () => {
    const textBlock: ProviderContentBlock = { type: 'text', text: 'reasoning' };
    const toolUseBlock: ProviderContentBlock = {
      type: 'tool_use',
      id: 'tu1',
      name: 'grep',
      input: { pattern: 'x' },
    };
    const middle: ProviderMessage[] = [
      { role: 'assistant', content: [textBlock, toolUseBlock] },
      userBlocks([toolResult('big', IRRELEVANT)]),
    ];
    const out = relevanceElideMiddle(middle, { goalText: GOAL, verbatimBudgetBytes: 0 });
    const blocks = blocksOf(out.middle[0]);
    expect(blocks[0]).toBe(textBlock); // same reference, untouched
    expect(blocks[1]).toBe(toolUseBlock);
    expect(out.elidedCount).toBe(1); // the irrelevant tool_result still got pointered
  });
});
