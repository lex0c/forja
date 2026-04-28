import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvalCase, parseEvalCase } from '../../src/evals/loader.ts';

const minimal = `
name: smoke 1
prompt: hello
expect:
  - tool_called: read_file
`;

describe('parseEvalCase', () => {
  test('parses minimal happy path', () => {
    const c = parseEvalCase(minimal, '/tmp/case.yaml');
    expect(c.name).toBe('smoke 1');
    expect(c.prompt).toBe('hello');
    expect(c.expect.length).toBe(1);
    expect(c.expect[0]).toEqual({ kind: 'tool_called', tool: 'read_file' });
    expect(c.plan).toBeUndefined();
  });

  test('parses plan flag', () => {
    const yaml = `
name: x
prompt: y
plan: true
expect:
  - status: done
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.plan).toBe(true);
  });

  test('parses all expectation kinds', () => {
    const yaml = `
name: all
prompt: p
expect:
  - tool_called: read_file
  - tool_not_called: write_file
  - file_exists: a.ts
  - file_not_exists: b.ts
  - file_contains:
      path: c.ts
      pattern: export
  - status: done
  - exit_reason: maxSteps
  - output_contains: hello
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.expect.map((e) => e.kind)).toEqual([
      'tool_called',
      'tool_not_called',
      'file_exists',
      'file_not_exists',
      'file_contains',
      'status',
      'exit_reason',
      'output_contains',
    ]);
  });

  test('rejects unknown top-level key', () => {
    const yaml = `
name: x
prompt: y
expects: []
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/unknown key 'expects'/);
  });

  test('rejects expectation with two discriminants', () => {
    const yaml = `
name: x
prompt: y
expect:
  - tool_called: read_file
    file_exists: a.ts
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/exactly one discriminant/);
  });

  test('rejects unknown expectation kind', () => {
    const yaml = `
name: x
prompt: y
expect:
  - tests_pass: true
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/unknown kind 'tests_pass'/);
  });

  test('rejects empty expect list', () => {
    const yaml = `
name: x
prompt: y
expect: []
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/at least one expectation/);
  });

  test('rejects invalid status value', () => {
    const yaml = `
name: x
prompt: y
expect:
  - status: bogus
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/status must be one of/);
  });

  test('rejects invalid budget', () => {
    const yaml = `
name: x
prompt: y
expect:
  - status: done
budget:
  maxSteps: 0
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/maxSteps must be a positive integer/);
  });

  test('parses budget and setup', () => {
    const yaml = `
name: x
prompt: y
setup:
  fixture: ./fix
  files:
    src/a.ts: "export const a = 1\\n"
expect:
  - status: done
budget:
  maxSteps: 7
  maxCostUsd: 0.05
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.setup?.fixture).toBe('./fix');
    expect(c.setup?.files?.['src/a.ts']).toBe('export const a = 1\n');
    expect(c.budget).toEqual({ maxSteps: 7, maxCostUsd: 0.05 });
  });
});

describe('loadEvalCase', () => {
  test('loads from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-evloader-'));
    try {
      const p = join(dir, 'case.yaml');
      writeFileSync(p, minimal);
      const c = loadEvalCase(p);
      expect(c.name).toBe('smoke 1');
      expect(c.sourcePath).toBe(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on missing file', () => {
    expect(() => loadEvalCase('/nonexistent/forja/case.yaml')).toThrow();
  });
});
