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

  test('parses compaction budget knobs', () => {
    const yaml = `
name: x
prompt: y
expect:
  - status: done
budget:
  compactionThreshold: 0.02
  compactionPreserveTail: 1
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.budget?.compactionThreshold).toBe(0.02);
    expect(c.budget?.compactionPreserveTail).toBe(1);
  });

  test('rejects compactionThreshold out of (0, 1]', () => {
    const baseYaml = (v: string) => `
name: x
prompt: y
expect:
  - status: done
budget:
  compactionThreshold: ${v}
`;
    expect(() => parseEvalCase(baseYaml('0'), '/tmp/c.yaml')).toThrow(
      /compactionThreshold must be a number in \(0, 1\]/,
    );
    expect(() => parseEvalCase(baseYaml('1.5'), '/tmp/c.yaml')).toThrow(
      /compactionThreshold must be a number in \(0, 1\]/,
    );
  });

  test('rejects compactionPreserveTail negative', () => {
    const yaml = `
name: x
prompt: y
expect:
  - status: done
budget:
  compactionPreserveTail: -1
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(
      /compactionPreserveTail must be a non-negative integer/,
    );
  });

  test('parses compaction_triggered with strategy', () => {
    const yaml = `
name: x
prompt: y
expect:
  - compaction_triggered:
      min_count: 2
      strategy: llm
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.expect[0]).toEqual({
      kind: 'compaction_triggered',
      minCount: 2,
      strategy: 'llm',
    });
  });

  test('parses compaction_triggered without strategy (any)', () => {
    const yaml = `
name: x
prompt: y
expect:
  - compaction_triggered:
      min_count: 1
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.expect[0]).toEqual({ kind: 'compaction_triggered', minCount: 1 });
  });

  test('rejects compaction_triggered with min_count <= 0', () => {
    const yaml = `
name: x
prompt: y
expect:
  - compaction_triggered:
      min_count: 0
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(
      /min_count must be a positive integer/,
    );
  });

  test('parses tool_denied expectation', () => {
    const yaml = `
name: x
prompt: y
expect:
  - tool_denied: bash
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.expect[0]).toEqual({ kind: 'tool_denied', tool: 'bash' });
  });

  test('rejects file_exists with .. segment', () => {
    const yaml = `
name: x
prompt: y
expect:
  - file_exists: ../../etc/passwd
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(
      /file_exists.*contains '\.\.' segment/,
    );
  });

  test('rejects file_not_exists with absolute path', () => {
    const yaml = `
name: x
prompt: y
expect:
  - file_not_exists: /etc/passwd
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/file_not_exists.*is absolute/);
  });

  test('rejects file_contains with .. segment in path', () => {
    const yaml = `
name: x
prompt: y
expect:
  - file_contains:
      path: ../../host-secret
      pattern: TOKEN
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(
      /file_contains.path.*contains '\.\.' segment/,
    );
  });

  test('rejects setup.fixture absolute path', () => {
    const yaml = `
name: x
prompt: y
setup:
  fixture: /etc
expect:
  - status: done
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/setup.fixture '\/etc' is absolute/);
  });

  test('accepts setup.fixture with .. (sibling reach)', () => {
    const yaml = `
name: x
prompt: y
setup:
  fixture: ../fixtures/foo
expect:
  - status: done
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.setup?.fixture).toBe('../fixtures/foo');
  });

  test('rejects setup.files path with .. segment', () => {
    const yaml = `
name: x
prompt: y
setup:
  files:
    "../escape.txt": "leak"
expect:
  - status: done
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/contains '\.\.' segment/);
  });

  test('rejects setup.files path with .. segment in middle', () => {
    const yaml = `
name: x
prompt: y
setup:
  files:
    "src/../../escape.txt": "leak"
expect:
  - status: done
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/contains '\.\.' segment/);
  });

  test('rejects setup.files absolute path (POSIX)', () => {
    const yaml = `
name: x
prompt: y
setup:
  files:
    "/tmp/escape.txt": "leak"
expect:
  - status: done
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/is absolute/);
  });

  test('rejects setup.files empty key', () => {
    const yaml = `
name: x
prompt: y
setup:
  files:
    "": "leak"
expect:
  - status: done
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(/non-empty path/);
  });

  test('accepts safe relative paths with subdirectories', () => {
    const yaml = `
name: x
prompt: y
setup:
  files:
    "src/nested/file.txt": "ok"
    "config.json": "{}"
expect:
  - status: done
`;
    const c = parseEvalCase(yaml, '/tmp/c.yaml');
    expect(c.setup?.files?.['src/nested/file.txt']).toBe('ok');
    expect(c.setup?.files?.['config.json']).toBe('{}');
  });

  test('rejects compaction_triggered with unknown strategy', () => {
    const yaml = `
name: x
prompt: y
expect:
  - compaction_triggered:
      min_count: 1
      strategy: bogus
`;
    expect(() => parseEvalCase(yaml, '/tmp/c.yaml')).toThrow(
      /strategy must be one of: fallback, llm, skipped/,
    );
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
