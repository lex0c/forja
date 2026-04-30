import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSubagentFromString, loadSubagents } from '../../src/subagents/load.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'forja-subagents-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const writeFile = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const VALID = `---
name: explore
description: Read-only codebase exploration.
tools: [read_file, grep, glob]
budget:
  max_steps: 20
  max_cost_usd: 0.5
---
You are an exploration subagent. Be concise.`;

describe('loadSubagentFromString', () => {
  test('parses a valid definition', () => {
    const def = loadSubagentFromString(VALID, 'user', '/fake/explore.md');
    expect(def.name).toBe('explore');
    expect(def.description).toBe('Read-only codebase exploration.');
    expect(def.tools).toEqual(['read_file', 'grep', 'glob']);
    expect(def.budget).toEqual({ maxSteps: 20, maxCostUsd: 0.5 });
    expect(def.systemPrompt).toBe('You are an exploration subagent. Be concise.');
    expect(def.scope).toBe('user');
    expect(def.sourcePath).toBe('/fake/explore.md');
    expect(def.meta).toEqual({});
  });

  test('captures unknown frontmatter into meta', () => {
    // Future playbook fields (output_schema, sampling, references)
    // must survive the loader unchanged so consumers can read them
    // without bumping this surface.
    const def = loadSubagentFromString(
      `---
name: review
description: Stub.
tools: []
budget:
  max_steps: 1
  max_cost_usd: 0
output_schema:
  summary: string
sampling:
  temperature: 0.2
---
prompt`,
      'user',
      '/p',
    );
    expect(def.meta.output_schema).toEqual({ summary: 'string' });
    expect(def.meta.sampling).toEqual({ temperature: 0.2 });
  });

  test('rejects missing leading delimiter', () => {
    expect(() => loadSubagentFromString('no frontmatter here', 'user', '/p')).toThrow(
      /missing leading '---'/,
    );
  });

  test('rejects unterminated frontmatter', () => {
    expect(() => loadSubagentFromString('---\nname: x\n', 'user', '/p')).toThrow(
      /unterminated frontmatter/,
    );
  });

  test('rejects malformed YAML', () => {
    expect(() => loadSubagentFromString('---\nname: [\n---\nbody', 'user', '/p')).toThrow(
      /malformed YAML/,
    );
  });

  test('rejects empty body', () => {
    expect(() =>
      loadSubagentFromString(
        `---
name: x
description: y
tools: []
budget: { max_steps: 1, max_cost_usd: 0 }
---
`,
        'user',
        '/p',
      ),
    ).toThrow(/body \(system prompt\) is empty/);
  });

  test('rejects non-kebab name', () => {
    expect(() =>
      loadSubagentFromString(VALID.replace('name: explore', 'name: ExplorePlz'), 'user', '/p'),
    ).toThrow(/kebab-case/);
    expect(() =>
      loadSubagentFromString(VALID.replace('name: explore', 'name: 9-explore'), 'user', '/p'),
    ).toThrow(/kebab-case/);
  });

  test('rejects missing required fields', () => {
    const cases: Array<[string, RegExp]> = [
      [VALID.replace('name: explore\n', ''), /'name' must be a non-empty string/],
      [
        VALID.replace('description: Read-only codebase exploration.\n', ''),
        /'description' must be a non-empty string/,
      ],
      [VALID.replace('tools: [read_file, grep, glob]\n', ''), /'tools' must be an array/],
      [
        VALID.replace(/budget:\n {2}max_steps: 20\n {2}max_cost_usd: 0\.5\n/, ''),
        /'budget' is required/,
      ],
    ];
    for (const [src, re] of cases) {
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(re);
    }
  });

  test('rejects write/exec tools in whitelist (Step 4.1 — until worktree)', async () => {
    // m5 from the review pass. Subagents in 4.1 run in-process with
    // the parent's tree; the parent's --undo can't reach the child's
    // writes (chain keyed by session_id) and the child's checkpoints
    // are off. Until 4.2 ships worktree isolation, an author who
    // whitelists write_file/edit_file/bash gets a hard refusal at
    // load time so the gap doesn't ship into production.
    const blocked = ['write_file', 'edit_file', 'bash', 'bash_background', 'bash_kill'];
    for (const tool of blocked) {
      const src = `---
name: refactor
description: y
tools: [${tool}]
budget:
  max_steps: 1
  max_cost_usd: 0
---
body`;
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(
        /cannot appear in subagent\.tools\[\] in Step 4\.1/,
      );
    }
  });

  test('rejects empty / whitespace-only entries in tools[]', () => {
    // Regression: the prior validator only checked `typeof e ===
    // 'string'`, so `tools: [""]` slipped through bootstrap and
    // only failed later at registry build time as a generic
    // exception on first invocation. Pull-forward at load time
    // gives the author a clean source-aware error.
    const cases: Array<[string, RegExp]> = [
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [""]'),
        /'tools\[0\]' must be a non-empty tool name/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [read_file, "", grep]'),
        /'tools\[1\]' must be a non-empty tool name/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: ["   "]'),
        /'tools\[0\]' must be a non-empty tool name/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [read_file, 42]'),
        /'tools\[1\]' must be a string \(got number\)/,
      ],
    ];
    for (const [src, re] of cases) {
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(re);
    }
  });

  test('rejects whitespace-padded tool names with a source-aware error', () => {
    // `tools: ["read_file "]` would slip through trim-only emptiness
    // checks and fail later at registry build time with the opaque
    // "tool not registered" path. Refusing here surfaces the typo
    // at load time. We refuse rather than silently trim — silent
    // normalization masks the author's mistake.
    const cases: Array<[string, RegExp]> = [
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: ["read_file "]'),
        /'tools\[0\]' has leading or trailing whitespace \(got "read_file "\)/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [" read_file"]'),
        /'tools\[0\]' has leading or trailing whitespace \(got " read_file"\)/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [read_file, "  grep  ", glob]'),
        /'tools\[1\]' has leading or trailing whitespace/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: ["\\tread_file"]'),
        /'tools\[0\]' has leading or trailing whitespace/,
      ],
    ];
    for (const [src, re] of cases) {
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(re);
    }
  });

  test('accepts well-formed tool names unchanged', () => {
    // Sanity: the new whitespace check doesn't reject legitimate
    // names (regression guard — a too-aggressive trim check could
    // start rejecting `read_file` because of the underscore or
    // similar absurd false positives).
    const def = loadSubagentFromString(VALID, 'user', '/p');
    expect(def.tools).toEqual(['read_file', 'grep', 'glob']);
  });

  test('rejects budget with bad numbers', () => {
    expect(() =>
      loadSubagentFromString(VALID.replace('max_steps: 20', 'max_steps: 0'), 'user', '/p'),
    ).toThrow(/'budget.max_steps' must be a positive integer/);
    expect(() =>
      loadSubagentFromString(VALID.replace('max_cost_usd: 0.5', 'max_cost_usd: -1'), 'user', '/p'),
    ).toThrow(/'budget.max_cost_usd' must be a finite non-negative number/);
  });

  test('rejects non-finite max_cost_usd (Infinity / NaN)', () => {
    // YAML `.inf` parses to Infinity, which silently passed the
    // earlier `>= 0` check and disabled the spend cap that this
    // field is required to enforce. Reject any non-finite value
    // so every accepted definition has a real numeric ceiling.
    // Cases cover the YAML literal forms (.inf, .nan) and the
    // JS-string fallback that the YAML parser may emit on some
    // non-canonical inputs.
    const cases = ['.inf', '.Inf', '.INF', '.nan', '.NaN', '.NAN'];
    for (const literal of cases) {
      const src = VALID.replace('max_cost_usd: 0.5', `max_cost_usd: ${literal}`);
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(
        /'budget\.max_cost_usd' must be a finite non-negative number/,
      );
    }
  });

  test('accepts CRLF line endings', () => {
    const crlf = VALID.replace(/\n/g, '\r\n');
    const def = loadSubagentFromString(crlf, 'user', '/p');
    expect(def.name).toBe('explore');
    expect(def.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe('loadSubagents (directory discovery)', () => {
  test('returns empty set when neither dir exists', () => {
    const set = loadSubagents({
      cwd: workspace,
      userDir: join(workspace, 'no-user'),
      projectDir: join(workspace, 'no-project'),
    });
    expect(set.byName.size).toBe(0);
    expect(set.shadows).toEqual([]);
  });

  test('loads from user and project, project wins on collision', () => {
    const userDir = join(workspace, 'user-agents');
    const projectDir = join(workspace, '.agent', 'agents');
    writeFile(join(userDir, 'explore.md'), VALID);
    writeFile(
      join(projectDir, 'explore.md'),
      VALID.replace('Read-only codebase exploration.', 'Project override.'),
    );
    writeFile(
      join(userDir, 'review.md'),
      VALID.replace('name: explore', 'name: review').replace(
        'Read-only codebase exploration.',
        'User-only review.',
      ),
    );
    const set = loadSubagents({ cwd: workspace, userDir, projectDir });
    expect(set.byName.size).toBe(2);
    expect(set.byName.get('explore')?.scope).toBe('project');
    expect(set.byName.get('explore')?.description).toBe('Project override.');
    expect(set.byName.get('review')?.scope).toBe('user');
    expect(set.shadows).toHaveLength(1);
    expect(set.shadows[0]?.name).toBe('explore');
    expect(set.shadows[0]?.shadowed.scope).toBe('user');
    expect(set.shadows[0]?.winning.scope).toBe('project');
  });

  test('rejects duplicate names within the same scope', () => {
    const dir = join(workspace, 'agents');
    writeFile(join(dir, 'a.md'), VALID);
    // Second file claiming the same `name` is an authoring mistake.
    writeFile(join(dir, 'b.md'), VALID);
    expect(() => loadSubagents({ cwd: workspace, userDir: dir, projectDir: null })).toThrow(
      /duplicated in user scope/,
    );
  });

  test('ignores non-md and non-file entries', () => {
    const dir = join(workspace, 'agents');
    writeFile(join(dir, 'explore.md'), VALID);
    writeFile(join(dir, 'README.txt'), 'noise');
    mkdirSync(join(dir, 'nested-dir'), { recursive: true });
    writeFile(join(dir, 'nested-dir', 'inside.md'), VALID);
    const set = loadSubagents({ cwd: workspace, userDir: dir, projectDir: null });
    expect(set.byName.size).toBe(1);
    expect(set.byName.get('explore')?.sourcePath).toBe(join(dir, 'explore.md'));
  });

  test('userDir=null disables the user scope entirely', () => {
    const projectDir = join(workspace, '.agent', 'agents');
    writeFile(join(projectDir, 'explore.md'), VALID);
    const set = loadSubagents({ cwd: workspace, userDir: null, projectDir });
    expect(set.byName.get('explore')?.scope).toBe('project');
    expect(set.shadows).toEqual([]);
  });
});
