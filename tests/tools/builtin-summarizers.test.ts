import { describe, expect, test } from 'bun:test';
import { bashTool } from '../../src/tools/builtin/bash.ts';
import { globTool } from '../../src/tools/builtin/glob.ts';
import { grepTool } from '../../src/tools/builtin/grep.ts';

// `metadata.summarize` is the harness-side contract for output
// reduction. These tests exercise each builtin's summarizer
// directly — pure functions, no exec / fixtures needed. The
// invariants under test:
//   1. Small outputs pass through unchanged (`reduced: false`,
//      `policy: 'noop'`).
//   2. Large outputs trigger reduction (`reduced: true`, named
//      policy).
//   3. The reduced result keeps the same top-level shape as the
//      raw — only heavy fields shrink.
//
// Tests don't cover ToolError inputs: the harness routes error
// results through a separate path that never invokes the
// summarizer, so the summarizer's behavior on a ToolError is
// undefined-by-contract.

describe('bashTool.metadata.summarize', () => {
  const summarize = bashTool.metadata.summarize;

  test('exposes a summarize function', () => {
    expect(summarize).toBeDefined();
  });

  test('passes a short stdout/stderr through unchanged', () => {
    const out = summarize?.(
      {
        stdout: 'ok\n',
        stderr: '',
        exit_code: 0,
        duration_ms: 1,
        timed_out: false,
        truncated: false,
      },
      {},
    );
    expect(out?.reduced).toBe(false);
    expect(out?.policy).toBe('noop');
  });

  test('head-tails stdout when it crosses the byte threshold', () => {
    const stdout = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n');
    const out = summarize?.(
      {
        stdout,
        stderr: '',
        exit_code: 0,
        duration_ms: 1,
        timed_out: false,
        truncated: false,
      },
      {},
    );
    expect(out?.reduced).toBe(true);
    expect(out?.policy).toBe('head_tail');
    const summarized = out?.result as { stdout: string; stderr: string };
    expect(summarized.stdout).toContain('line0');
    expect(summarized.stdout).toContain('line4999');
    expect(summarized.stdout).toContain('lines elided');
    expect(summarized.stdout).not.toContain('line2500');
    // stderr (empty) is untouched.
    expect(summarized.stderr).toBe('');
  });

  test('summarizes stderr independently from stdout', () => {
    const stderr = Array.from({ length: 5000 }, (_, i) => `err${i}`).join('\n');
    const out = summarize?.(
      {
        stdout: 'short stdout\n',
        stderr,
        exit_code: 1,
        duration_ms: 1,
        timed_out: false,
        truncated: false,
      },
      {},
    );
    expect(out?.reduced).toBe(true);
    const summarized = out?.result as { stdout: string; stderr: string; exit_code: number };
    expect(summarized.stdout).toBe('short stdout\n');
    expect(summarized.stderr).toContain('lines elided');
    expect(summarized.exit_code).toBe(1);
  });
});

describe('grepTool.metadata.summarize', () => {
  const summarize = grepTool.metadata.summarize;

  test('exposes a summarize function', () => {
    expect(summarize).toBeDefined();
  });

  test('passes a small match list through unchanged', () => {
    const matches = Array.from({ length: 10 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i,
      text: `hit ${i}`,
    }));
    const out = summarize?.({ pattern: 'x', matches, count: 10, truncated: false }, {});
    expect(out?.reduced).toBe(false);
    expect(out?.policy).toBe('noop');
  });

  test('group-by-file folds hits when count crosses threshold', () => {
    // 100 hits spread across 5 files → fold to 5 grouped entries.
    const matches = Array.from({ length: 100 }, (_, i) => ({
      file: `f${i % 5}.ts`,
      line: i,
      text: `hit ${i}`,
    }));
    const out = summarize?.({ pattern: 'x', matches, count: 100, truncated: false }, {});
    expect(out?.reduced).toBe(true);
    expect(out?.policy).toBe('group_by_file');
    const summarized = out?.result as {
      matches: { file: string; count: number; firstLine: number; firstText: string }[];
    };
    expect(summarized.matches).toHaveLength(5);
    // Each grouped entry has count = 20.
    for (const entry of summarized.matches) {
      expect(entry.count).toBe(20);
      expect(entry.firstText).toContain('hit');
    }
  });
});

describe('globTool.metadata.summarize', () => {
  const summarize = globTool.metadata.summarize;

  test('exposes a summarize function', () => {
    expect(summarize).toBeDefined();
  });

  test('passes a small matches array through unchanged', () => {
    const matches = ['a.ts', 'b.ts', 'c.ts'];
    const out = summarize?.({ pattern: '*', matches, count: 3, truncated: false }, {});
    expect(out?.reduced).toBe(false);
    expect(out?.policy).toBe('noop');
  });

  test('head-tails a large matches array', () => {
    const matches = Array.from({ length: 500 }, (_, i) => `dir/file${i}.ts`);
    const out = summarize?.({ pattern: '**/*.ts', matches, count: 500, truncated: false }, {});
    expect(out?.reduced).toBe(true);
    expect(out?.policy).toBe('head_tail');
    const summarized = out?.result as { matches: string[] };
    // 50 head + 1 elision marker + 50 tail.
    expect(summarized.matches).toHaveLength(50 + 1 + 50);
    expect(summarized.matches[0]).toBe('dir/file0.ts');
    expect(summarized.matches[50]).toContain('paths elided');
    expect(summarized.matches[summarized.matches.length - 1]).toBe('dir/file499.ts');
  });
});
