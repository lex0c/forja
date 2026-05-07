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

  test('captures genuinely unknown frontmatter into meta', () => {
    // Forward-compat invariant: a frontmatter key with no typed
    // parser still lands in `meta` so a future slice that adds the
    // parser doesn't need a loader bump to start reading the
    // field. The well-known playbook surfaces (output_schema,
    // sampling, references, tool_restrictions, etc.) all have
    // typed parsers now and live on dedicated fields — this test
    // covers ONLY the overflow path, with a synthetic key that no
    // parser claims.
    const def = loadSubagentFromString(
      `---
name: review
description: Stub.
tools: []
budget:
  max_steps: 1
  max_cost_usd: 0.01
custom_unrecognized_field:
  arbitrary: payload
---
prompt`,
      'user',
      '/p',
    );
    expect(def.meta.custom_unrecognized_field).toEqual({ arbitrary: 'payload' });
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
budget: { max_steps: 1, max_cost_usd: 0.01 }
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

  // Note: the prior "rejects write/exec tools" test moved to
  // tests/subagents/validate.test.ts. The loader is registry-
  // agnostic; capability validation happens at bootstrap (where
  // the registry is available) and at runtime (defense in depth).

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

  test('rejects duplicate entries in tools[] at load time', () => {
    // Pull-forward of the runtime's duplicate detection. Earlier
    // a malformed `tools: ["echo", "echo"]` passed bootstrap and
    // failed mid-run as a generic `tool.exception` from the
    // `task` tool, burning a tool-error slot and obscuring the
    // root cause. Now the loader catches it source-aware with
    // both indices in the message so the author can fix the
    // typo without diff'ing the file.
    const cases: Array<[string, RegExp]> = [
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [echo, echo]'),
        /'tools' lists 'echo' twice \(index 0 and index 1\)/,
      ],
      [
        VALID.replace('tools: [read_file, grep, glob]', 'tools: [read_file, grep, read_file]'),
        /'tools' lists 'read_file' twice \(index 0 and index 2\)/,
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

  test('sha256 differs between LF and CRLF line endings (deliberate)', () => {
    // Cross-platform footgun made deliberate: a Windows clone
    // with `core.autocrlf=true` produces CRLF on disk where
    // Linux has LF, so the same git revision yields different
    // shas across machines. This test locks in the deliberate
    // choice — silently normalizing would alias real edits to
    // the source form. Authors who want stable shas across
    // platforms should set `* text=lf` in .gitattributes.
    const lf = VALID;
    const crlf = lf.replace(/\n/g, '\r\n');
    const defLf = loadSubagentFromString(lf, 'user', '/p');
    const defCrlf = loadSubagentFromString(crlf, 'user', '/p');
    expect(defLf.sourceSha256).not.toBe(defCrlf.sourceSha256);
    // Both are still well-formed; the body field strips the line
    // endings as part of trim, so semantic content survives.
    expect(defLf.systemPrompt.length).toBeGreaterThan(0);
    expect(defCrlf.systemPrompt.length).toBeGreaterThan(0);
  });

  test('isolation defaults to none when frontmatter omits the field', () => {
    // Backward-compat invariant: every Step 4.1 definition must
    // keep loading unchanged. The loader fills the new `isolation`
    // field with 'none' so the validator/runtime treat the legacy
    // shape exactly as before.
    const def = loadSubagentFromString(VALID, 'user', '/p');
    expect(def.isolation).toBe('none');
  });

  test("isolation: 'worktree' parses through to the typed field", () => {
    const src = VALID.replace(
      '---\nYou are an exploration subagent. Be concise.',
      'isolation: worktree\n---\nYou are an exploration subagent. Be concise.',
    );
    const def = loadSubagentFromString(src, 'user', '/p');
    expect(def.isolation).toBe('worktree');
    // Known-fields surface — must NOT spill into meta. A typo in
    // an `isolation`-adjacent key (e.g., `isolations`) would land
    // in meta and silently downgrade the protection.
    expect(def.meta.isolation).toBeUndefined();
  });

  test("isolation: 'none' parses (explicit form is identical to default)", () => {
    const src = VALID.replace(
      '---\nYou are an exploration subagent. Be concise.',
      'isolation: none\n---\nYou are an exploration subagent. Be concise.',
    );
    const def = loadSubagentFromString(src, 'user', '/p');
    expect(def.isolation).toBe('none');
  });

  test('isolation rejects any value other than none/worktree at load time', () => {
    // Typos like `isolation: worktee` would silently downgrade to
    // 'none' if the loader fell back on a default. Refuse loud at
    // load time so the author finds the typo before any subagent
    // with `write_file` ships unguarded.
    const cases = ['worktee', 'subprocess', 'sandbox', '', 'true'];
    for (const bad of cases) {
      const src = VALID.replace(
        '---\nYou are an exploration subagent. Be concise.',
        `isolation: ${JSON.stringify(bad)}\n---\nYou are an exploration subagent. Be concise.`,
      );
      expect(() => loadSubagentFromString(src, 'user', '/p')).toThrow(
        /'isolation' must be 'none' or 'worktree'/,
      );
    }
  });

  test('captures sha256 of raw content (frontmatter + body)', () => {
    // Snapshot fingerprint contract: hash deterministic from
    // exact file bytes, not from parsed/normalized form. Two
    // semantically equivalent files with different whitespace
    // MUST produce different sha — otherwise audit can't tell
    // apart edits to the file's source form.
    const def = loadSubagentFromString(VALID, 'user', '/p');
    expect(def.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    // Same content yields same sha regardless of source path
    // (path is identity, sha is content fingerprint).
    const def2 = loadSubagentFromString(VALID, 'project', '/different/path.md');
    expect(def2.sourceSha256).toBe(def.sourceSha256);
    // A whitespace edit (extra blank line in body) changes the sha.
    const edited = `${VALID}\n`;
    const def3 = loadSubagentFromString(edited, 'user', '/p');
    expect(def3.sourceSha256).not.toBe(def.sourceSha256);
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
    ).toThrow(/'budget.max_cost_usd' must be a finite positive number/);
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
        /'budget\.max_cost_usd' must be a finite positive number/,
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

// Helper: substitute the closing `---` line with extra frontmatter
// keys preceded by a newline, then the closing delimiter and body.
// Avoids fragile string-replace recipes when a test needs to add
// arbitrary YAML to the canonical fixture.
const withExtraFrontmatter = (extra: string): string =>
  `---
name: explore
description: Read-only codebase exploration.
tools: [read_file, grep, glob]
budget:
  max_steps: 20
  max_cost_usd: 0.5
${extra}
---
You are an exploration subagent. Be concise.`;

describe('playbook surface — slash', () => {
  test('absent slash yields undefined', () => {
    const def = loadSubagentFromString(VALID, 'user', '/p');
    expect(def.slash).toBeUndefined();
  });

  test('valid kebab-case slash parses through', () => {
    const def = loadSubagentFromString(withExtraFrontmatter('slash: review'), 'user', '/p');
    expect(def.slash).toBe('review');
    expect(def.meta.slash).toBeUndefined();
  });

  test('rejects non-string slash', () => {
    expect(() => loadSubagentFromString(withExtraFrontmatter('slash: 42'), 'user', '/p')).toThrow(
      /'slash' must be a non-empty string/,
    );
  });

  test('rejects non-kebab slash', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('slash: ReviewIt'), 'user', '/p'),
    ).toThrow(/'slash' must be kebab-case/);
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('slash: 9-review'), 'user', '/p'),
    ).toThrow(/'slash' must be kebab-case/);
  });
});

describe('playbook surface — when_to_use', () => {
  test('absent when_to_use yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').whenToUse).toBeUndefined();
  });

  test('valid when_to_use parses through verbatim', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('when_to_use: "diff ready for review"'),
      'user',
      '/p',
    );
    expect(def.whenToUse).toBe('diff ready for review');
    expect(def.meta.when_to_use).toBeUndefined();
  });

  test('rejects empty / whitespace-only when_to_use', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('when_to_use: ""'), 'user', '/p'),
    ).toThrow(/'when_to_use' must be a non-empty string/);
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('when_to_use: "   "'), 'user', '/p'),
    ).toThrow(/'when_to_use' must be a non-empty string/);
  });
});

describe('playbook surface — output_schema', () => {
  test('absent output_schema yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').outputSchema).toBeUndefined();
  });

  test('YAML inline shorthand passes through unchanged', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('output_schema:\n  summary: string\n  blockers: array'),
      'user',
      '/p',
    );
    expect(def.outputSchema).toEqual({ summary: 'string', blockers: 'array' });
    expect(def.meta.output_schema).toBeUndefined();
  });

  test('JSON Schema-style mapping passes through unchanged', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'output_schema:\n  type: object\n  required: [summary]\n  properties:\n    summary:\n      type: string',
      ),
      'user',
      '/p',
    );
    expect(def.outputSchema).toEqual({
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    });
  });

  test('rejects array / scalar output_schema', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('output_schema: [a, b]'), 'user', '/p'),
    ).toThrow(/'output_schema' must be a YAML mapping/);
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('output_schema: scalar'), 'user', '/p'),
    ).toThrow(/'output_schema' must be a YAML mapping/);
  });
});

describe('playbook surface — references', () => {
  test('absent references yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').references).toBeUndefined();
  });

  test('valid references list parses through', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('references:\n  - OPSEC.md\n  - CRYPTOGRAPHY.md'),
      'user',
      '/p',
    );
    expect(def.references).toEqual(['OPSEC.md', 'CRYPTOGRAPHY.md']);
    expect(def.meta.references).toBeUndefined();
  });

  test('rejects non-array references', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('references: OPSEC.md'), 'user', '/p'),
    ).toThrow(/'references' must be an array of strings/);
  });

  test('rejects non-string entries', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('references: ["OPSEC.md", 42]'), 'user', '/p'),
    ).toThrow(/'references\[1\]' must be a string \(got number\)/);
  });

  test('rejects empty / whitespace-padded entries', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('references: [""]'), 'user', '/p'),
    ).toThrow(/'references\[0\]' must be a non-empty path/);
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('references: [" OPSEC.md"]'), 'user', '/p'),
    ).toThrow(/'references\[0\]' has leading or trailing whitespace/);
  });

  test('rejects duplicates', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('references: ["OPSEC.md", "CRYPTO.md", "OPSEC.md"]'),
        'user',
        '/p',
      ),
    ).toThrow(/'references' lists 'OPSEC.md' twice \(index 0 and index 2\)/);
  });
});

describe('playbook surface — tool_restrictions', () => {
  test('absent tool_restrictions yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').toolRestrictions).toBeUndefined();
  });

  test('list shorthand becomes { allow: [...] }', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('tool_restrictions:\n  bash:\n    - "git diff *"\n    - "git log *"'),
      'user',
      '/p',
    );
    expect(def.toolRestrictions).toEqual({
      bash: { allow: ['git diff *', 'git log *'] },
    });
    expect(def.meta.tool_restrictions).toBeUndefined();
  });

  test('mapping form with allow / deny passes through unchanged', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'tool_restrictions:\n  bash:\n    allow: ["rg *", "cat *"]\n    deny: ["rm -rf *"]',
      ),
      'user',
      '/p',
    );
    expect(def.toolRestrictions).toEqual({
      bash: { allow: ['rg *', 'cat *'], deny: ['rm -rf *'] },
    });
  });

  test('allow_patterns is a synonym for allow', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'tool_restrictions:\n  bash:\n    allow_patterns: ["hyperfine *", "perf record *"]',
      ),
      'user',
      '/p',
    );
    expect(def.toolRestrictions).toEqual({
      bash: { allow: ['hyperfine *', 'perf record *'] },
    });
  });

  test('rejects mixing allow and allow_patterns on the same rule', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter(
          'tool_restrictions:\n  bash:\n    allow: ["a *"]\n    allow_patterns: ["b *"]',
        ),
        'user',
        '/p',
      ),
    ).toThrow(/cannot declare both 'allow' and 'allow_patterns'/);
  });

  test('allow_paths / deny_paths normalize to camelCase', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'tool_restrictions:\n  write_file:\n    allow_paths: ["src/**"]\n    deny_paths: ["src/secret/**"]',
      ),
      'user',
      '/p',
    );
    expect(def.toolRestrictions).toEqual({
      write_file: { allowPaths: ['src/**'], denyPaths: ['src/secret/**'] },
    });
  });

  test('multiple tools with independent rules', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'tool_restrictions:\n  bash:\n    - "git diff *"\n  write_file:\n    allow_paths: ["src/**"]',
      ),
      'user',
      '/p',
    );
    expect(def.toolRestrictions).toEqual({
      bash: { allow: ['git diff *'] },
      write_file: { allowPaths: ['src/**'] },
    });
  });

  test('rejects unknown rule key', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash:\n    allows: ["typo *"]'),
        'user',
        '/p',
      ),
    ).toThrow(/'tool_restrictions\.bash' has unknown key 'allows'/);
  });

  test('rejects non-mapping / non-array rule', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash: "git *"'),
        'user',
        '/p',
      ),
    ).toThrow(/'tool_restrictions\.bash' must be an array of patterns or a mapping/);
  });

  test('rejects non-mapping tool_restrictions', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('tool_restrictions: ["bash"]'), 'user', '/p'),
    ).toThrow(/'tool_restrictions' must be a mapping/);
  });

  test('rejects empty pattern strings inside an allow list', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash:\n    allow: ["valid *", ""]'),
        'user',
        '/p',
      ),
    ).toThrow(/'tool_restrictions\.bash\.allow\[1\]' must be a non-empty pattern/);
  });

  test('rejects duplicate patterns inside an allow list', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash:\n    allow: ["rg *", "rg *"]'),
        'user',
        '/p',
      ),
    ).toThrow(/'tool_restrictions\.bash\.allow' lists "rg \*" twice \(index 0 and index 1\)/);
  });

  test('rejects patterns padded with leading or trailing whitespace', () => {
    // Regression: the matcher does literal-position glob
    // comparison (no input/pattern normalization on the path
    // side), so ` src/**` or `src/** ` would never trigger any
    // path the write tools would resolve. The loader caught
    // empty strings but not whitespace-padded ones, leaving
    // typo-shaped entries to silently disable an allow rule
    // (or fail to deny a sensitive path). Reject at load so
    // the author sees the cause source-aware.
    const padded = [
      'tool_restrictions:\n  write_file:\n    allow_paths: ["src/** "]',
      'tool_restrictions:\n  write_file:\n    allow_paths: [" src/**"]',
      'tool_restrictions:\n  write_file:\n    deny_paths: ["\\tsecrets/**"]',
      'tool_restrictions:\n  bash:\n    deny: ["rm -rf *\\n"]',
    ];
    for (const fm of padded) {
      expect(() => loadSubagentFromString(withExtraFrontmatter(fm), 'user', '/p')).toThrow(
        /has surrounding whitespace/,
      );
    }
  });

  test('rejects path-shape keys on a bash-shape tool', () => {
    // Regression: the parser accepted `bash.allow_paths` /
    // `bash.deny_paths` even though the runtime gates bash by
    // command-string match (allow/deny). The rule loaded fine,
    // never matched anything at runtime, and the operator
    // believed the gate was active.
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash:\n    allow_paths: ["src/**"]'),
        'user',
        '/p',
      ),
    ).toThrow(
      /'tool_restrictions\.bash\.allow_paths' is path-shape but bash is gated by command-string match/,
    );
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  bash:\n    deny_paths: ["secrets/**"]'),
        'user',
        '/p',
      ),
    ).toThrow(
      /'tool_restrictions\.bash\.deny_paths' is path-shape but bash is gated by command-string match/,
    );
  });

  test('rejects bash-shape keys on a path-shape tool', () => {
    // Mirror of the above: write_file / edit_file are gated by
    // target path; allow / deny keys on them would be silently
    // ignored. Refuse at load with a directional hint pointing
    // to allow_paths / deny_paths.
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  write_file:\n    allow: ["src/**"]'),
        'user',
        '/p',
      ),
    ).toThrow(
      /'tool_restrictions\.write_file\.allow' is command-shape but write_file is gated by target path/,
    );
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  edit_file:\n    deny: ["dist/**"]'),
        'user',
        '/p',
      ),
    ).toThrow(
      /'tool_restrictions\.edit_file\.deny' is command-shape but edit_file is gated by target path/,
    );
  });

  test('rejects list-shorthand on a path-shape tool', () => {
    // List-shorthand (`bash: [glob]`) becomes `{ allow: [...] }`.
    // On a path tool it loads as command-shape allow → silent
    // ignore at runtime. Same gate catches it.
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('tool_restrictions:\n  write_file:\n    - "src/**"'),
        'user',
        '/p',
      ),
    ).toThrow(
      /'tool_restrictions\.write_file\.allow' is command-shape but write_file is gated by target path/,
    );
  });

  test('forward-compat: unknown tool with arbitrary keys still loads', () => {
    // Tools the runtime does not gate (`future_tool_xyz`) pass
    // through untouched. The shape map is the authority on what
    // gets enforced; refusing here would punish authors for the
    // loader's intentional permissiveness on arbitrary tool
    // names (`tool_restrictions` accepts forward-compat names
    // even when the runtime ignores them).
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'tool_restrictions:\n  future_tool_xyz:\n    allow: ["foo *"]\n    allow_paths: ["src/**"]',
      ),
      'user',
      '/p',
    );
    expect(def.toolRestrictions?.future_tool_xyz).toEqual({
      allow: ['foo *'],
      allowPaths: ['src/**'],
    });
  });

  test('keeps internal whitespace inside patterns valid (bash needs it)', () => {
    // Bash command patterns legitimately have spaces between
    // tokens (`git diff *`); the surrounding-whitespace guard
    // must NOT swallow them.
    const def = loadSubagentFromString(
      withExtraFrontmatter('tool_restrictions:\n  bash:\n    allow: ["git diff *"]'),
      'user',
      '/p',
    );
    expect(def.toolRestrictions?.bash?.allow).toEqual(['git diff *']);
  });
});

describe('playbook surface — sampling', () => {
  test('absent sampling yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').sampling).toBeUndefined();
  });

  test('full valid sampling block parses through with camelCase rename', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'sampling:\n  temperature: 0.2\n  top_p: 0.9\n  max_tokens: 4096\n  thinking_budget: 4000\n  seed_in_eval: true',
      ),
      'user',
      '/p',
    );
    expect(def.sampling).toEqual({
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 4096,
      thinkingBudget: 4000,
      seedInEval: true,
    });
    expect(def.meta.sampling).toBeUndefined();
  });

  test('partial sampling block leaves other fields undefined', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  temperature: 0.7'),
      'user',
      '/p',
    );
    expect(def.sampling).toEqual({ temperature: 0.7 });
  });

  test('rejects out-of-range temperature', () => {
    for (const bad of ['-0.1', '2.5']) {
      expect(() =>
        loadSubagentFromString(
          withExtraFrontmatter(`sampling:\n  temperature: ${bad}`),
          'user',
          '/p',
        ),
      ).toThrow(/'sampling\.temperature' must be in \[0, 2\]/);
    }
  });

  test('rejects out-of-range top_p', () => {
    for (const bad of ['0', '1.5']) {
      expect(() =>
        loadSubagentFromString(withExtraFrontmatter(`sampling:\n  top_p: ${bad}`), 'user', '/p'),
      ).toThrow(/'sampling\.top_p' must be in \(0, 1\]/);
    }
  });

  test('rejects non-integer / non-positive max_tokens', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('sampling:\n  max_tokens: 3.5'), 'user', '/p'),
    ).toThrow(/'sampling\.max_tokens' must be a positive integer/);
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('sampling:\n  max_tokens: 0'), 'user', '/p'),
    ).toThrow(/'sampling\.max_tokens' must be a positive integer/);
  });

  test('thinking_budget accepts 0 (disabled) and rejects negatives', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  thinking_budget: 0'),
      'user',
      '/p',
    );
    expect(def.sampling?.thinkingBudget).toBe(0);
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('sampling:\n  thinking_budget: -1'),
        'user',
        '/p',
      ),
    ).toThrow(/'sampling\.thinking_budget' must be a non-negative integer/);
  });

  test('rejects non-boolean seed_in_eval', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('sampling:\n  seed_in_eval: yes-please'),
        'user',
        '/p',
      ),
    ).toThrow(/'sampling\.seed_in_eval' must be a boolean/);
  });

  test('rejects unknown sampling key', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('sampling:\n  temprature: 0.2'), 'user', '/p'),
    ).toThrow(/'sampling\.temprature' is not a recognized option/);
  });

  test('rejects non-mapping sampling', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('sampling: 0.2'), 'user', '/p'),
    ).toThrow(/'sampling' must be a mapping/);
  });

  test('rejects thinking_budget >= explicit max_tokens (provider compatibility guard)', () => {
    // Providers reject thinking_budget >= max_tokens —
    // Anthropic 400s explicitly, Gemini silently caps the
    // budget. Catching at load means the author sees the cause
    // source-aware before any provider call. The pre-fix
    // canonical playbooks `threat-model.md` and
    // `perf-investigate.md` both shipped with `4096 == 4096`
    // and would have failed mid-run.
    const bad = [
      'thinking_budget: 4096\n  max_tokens: 4096',
      'thinking_budget: 5000\n  max_tokens: 4096',
    ];
    for (const pair of bad) {
      expect(() =>
        loadSubagentFromString(withExtraFrontmatter(`sampling:\n  ${pair}`), 'user', '/p'),
      ).toThrow(
        /'sampling\.thinking_budget' \([0-9]+\) must be strictly less than 'sampling\.max_tokens'/,
      );
    }
  });

  test('rejection message is provider-neutral (playbooks are portable across backends)', () => {
    // The error must NOT mention a single vendor's failure mode
    // — a playbook can run against Anthropic, Gemini, OpenAI,
    // or a local model. An error that says only "Anthropic 400s"
    // misleads operators running against other backends.
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('sampling:\n  thinking_budget: 5000\n  max_tokens: 4096'),
        'user',
        '/p',
      ),
    ).toThrow(/Gemini/);
  });

  test('thinking_budget without explicit max_tokens loads cleanly (runtime validates)', () => {
    // The loader does NOT gate against a fixed floor when
    // `sampling.max_tokens` is omitted. Earlier slices used a
    // 4096 floor that rejected `thinking_budget: 8000` even on
    // models whose runtime capability cap (e.g. Claude 4.x's
    // 64k) would have accommodated it — undermining the runtime
    // resolver's job of picking the real cap. The Anthropic
    // adapter (`providers/anthropic/index.ts`) re-runs the
    // cross-check against the runtime-resolved max_tokens
    // before sending the request, so an actually-invalid pair
    // still fails source-aware before the API call leaves the
    // binary; the loader only enforces what it can verify with
    // the values in front of it.
    const cases = ['thinking_budget: 4096', 'thinking_budget: 8000', 'thinking_budget: 50000'];
    for (const line of cases) {
      const def = loadSubagentFromString(
        withExtraFrontmatter(`sampling:\n  ${line}`),
        'user',
        '/p',
      );
      expect(def.sampling?.thinkingBudget).toBeGreaterThan(0);
      expect(def.sampling?.maxTokens).toBeUndefined();
    }
  });

  test('thinking_budget=0 escapes the cross-field check (disables thinking)', () => {
    // budget=0 means "no thinking block on the request" — the
    // adapter omits it entirely, so the cross-field constraint
    // doesn't apply. Authors who set 0 to disable get a clean
    // load even when max_tokens is 0-ish (or any value).
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  thinking_budget: 0\n  max_tokens: 4096'),
      'user',
      '/p',
    );
    expect(def.sampling).toEqual({ thinkingBudget: 0, maxTokens: 4096 });
  });

  test('thinking_budget=0 without max_tokens loads cleanly (disable idiom in minimal shape)', () => {
    // Pin the disable-idiom case where max_tokens is also
    // omitted. The gate's `> 0` short-circuit must fire BEFORE
    // the `maxTokens !== undefined` check; if a regression
    // swapped the conditions or relaxed `> 0` to `>= 0`,
    // budget=0 alone would surface a confusing error about
    // missing max_tokens. Pinning so the disable idiom keeps
    // working in the minimal shape.
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  thinking_budget: 0'),
      'user',
      '/p',
    );
    expect(def.sampling?.thinkingBudget).toBe(0);
    expect(def.sampling?.maxTokens).toBeUndefined();
  });

  test('thinking_budget without max_tokens loads even at small values (positive gate, not blanket refusal)', () => {
    // Counterpart to the explicit-cap "passes" test. After
    // dropping the loader floor, a small thinking_budget without
    // max_tokens still loads cleanly — pinned to confirm the
    // loader doesn't accidentally refuse the no-max_tokens shape
    // entirely.
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  thinking_budget: 2000'),
      'user',
      '/p',
    );
    expect(def.sampling?.thinkingBudget).toBe(2000);
    expect(def.sampling?.maxTokens).toBeUndefined();
  });

  test('thinking_budget < max_tokens passes', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('sampling:\n  thinking_budget: 4000\n  max_tokens: 4096'),
      'user',
      '/p',
    );
    expect(def.sampling).toEqual({ thinkingBudget: 4000, maxTokens: 4096 });
  });
});

describe('playbook surface — context_recipe', () => {
  test('absent context_recipe yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').contextRecipe).toBeUndefined();
  });

  test('full valid recipe parses through with camelCase rename', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'context_recipe:\n  include_repo_map: eager\n  include_diff: true\n  include_callers: false\n  goal_reinjection_every_n_steps: 4\n  fewshot_count: 1\n  memory_filter: ["security", "architecture"]\n  step_reflection: terse\n  clarify_mode: pre_execution',
      ),
      'user',
      '/p',
    );
    expect(def.contextRecipe).toEqual({
      includeRepoMap: 'eager',
      includeDiff: true,
      includeCallers: false,
      goalReinjectionEveryNSteps: 4,
      fewshotCount: 1,
      memoryFilter: ['security', 'architecture'],
      stepReflection: 'terse',
      clarifyMode: 'pre_execution',
    });
    expect(def.meta.context_recipe).toBeUndefined();
  });

  test('include_repo_map enum is enforced', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  include_repo_map: maybe'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.include_repo_map' must be one of eager, lazy, off/);
  });

  test('step_reflection enum is enforced', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  step_reflection: paragraph'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.step_reflection' must be one of off, terse, full/);
  });

  test('clarify_mode enum is enforced', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  clarify_mode: always'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.clarify_mode' must be one of off, on_high_blast, pre_execution/);
  });

  test('include_diff / include_callers must be boolean', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  include_diff: "yes"'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.include_diff' must be a boolean/);
  });

  test('goal_reinjection_every_n_steps must be positive integer', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  goal_reinjection_every_n_steps: 0'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.goal_reinjection_every_n_steps' must be a positive integer/);
  });

  test('fewshot_count accepts 0', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('context_recipe:\n  fewshot_count: 0'),
      'user',
      '/p',
    );
    expect(def.contextRecipe?.fewshotCount).toBe(0);
  });

  test('memory_filter passes through with whitespace / dup checks', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  memory_filter: ["security", "security"]'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.memory_filter' lists "security" twice/);
  });

  test('rejects unknown context_recipe key', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('context_recipe:\n  cache_size: 100'),
        'user',
        '/p',
      ),
    ).toThrow(/'context_recipe\.cache_size' is not a recognized option/);
  });
});

describe('playbook surface — prompt_version / context_recipe_version', () => {
  test('absent versions yield undefined', () => {
    const def = loadSubagentFromString(VALID, 'user', '/p');
    expect(def.promptVersion).toBeUndefined();
    expect(def.contextRecipeVersion).toBeUndefined();
  });

  test('positive integers parse through', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter('prompt_version: 3\ncontext_recipe_version: 1'),
      'user',
      '/p',
    );
    expect(def.promptVersion).toBe(3);
    expect(def.contextRecipeVersion).toBe(1);
  });

  test('rejects 0 / negative / non-integer prompt_version', () => {
    for (const bad of ['0', '-1', '1.5']) {
      expect(() =>
        loadSubagentFromString(withExtraFrontmatter(`prompt_version: ${bad}`), 'user', '/p'),
      ).toThrow(/'prompt_version' must be a positive integer/);
    }
  });

  test('rejects 0 / negative / non-integer context_recipe_version', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('context_recipe_version: 0'), 'user', '/p'),
    ).toThrow(/'context_recipe_version' must be a positive integer/);
  });
});

describe('playbook surface — phases', () => {
  test('absent phases yields undefined', () => {
    expect(loadSubagentFromString(VALID, 'user', '/p').phases).toBeUndefined();
  });

  test('valid phases list parses through with camelCase rename', () => {
    const def = loadSubagentFromString(
      withExtraFrontmatter(
        'phases:\n  - name: explore\n    on_enter: \'goal_push("explore")\'\n  - name: synthesize\n    on_enter: \'goal_push("synthesize")\'\n    on_complete: \'goal_pop("completion")\'',
      ),
      'user',
      '/p',
    );
    expect(def.phases).toEqual([
      { name: 'explore', onEnter: 'goal_push("explore")' },
      {
        name: 'synthesize',
        onEnter: 'goal_push("synthesize")',
        onComplete: 'goal_pop("completion")',
      },
    ]);
    expect(def.meta.phases).toBeUndefined();
  });

  test('rejects non-array phases', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('phases: explore'), 'user', '/p'),
    ).toThrow(/'phases' must be an array of phase mappings/);
  });

  test('rejects phase missing name', () => {
    expect(() =>
      loadSubagentFromString(withExtraFrontmatter('phases:\n  - on_enter: foo'), 'user', '/p'),
    ).toThrow(/'phases\[0\]\.name' must be a non-empty string/);
  });

  test('rejects phase with non-kebab name', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('phases:\n  - name: SynthesizeAll'),
        'user',
        '/p',
      ),
    ).toThrow(/'phases\[0\]\.name' must be kebab-case/);
  });

  test('rejects unknown phase key', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('phases:\n  - name: explore\n    when: pre'),
        'user',
        '/p',
      ),
    ).toThrow(/'phases\[0\]\.when' is not a recognized field/);
  });

  test('rejects duplicate phase names', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('phases:\n  - name: explore\n  - name: explore'),
        'user',
        '/p',
      ),
    ).toThrow(/'phases' lists name 'explore' twice \(index 0 and index 1\)/);
  });

  test('rejects empty on_enter / on_complete strings', () => {
    expect(() =>
      loadSubagentFromString(
        withExtraFrontmatter('phases:\n  - name: explore\n    on_enter: ""'),
        'user',
        '/p',
      ),
    ).toThrow(/'phases\[0\]\.on_enter' must be a non-empty string/);
  });
});

describe('playbook surface — fully populated playbook leaves meta empty', () => {
  test('every PLAYBOOKS.md §1.1 field has a typed parser', () => {
    // Sanity: the typed surface is large enough that a "kitchen
    // sink" playbook produces an empty `meta`. If a future spec
    // change adds a new field, this test fails until either the
    // parser ships or the field is intentionally left to overflow.
    const def = loadSubagentFromString(
      `---
name: kitchen-sink
description: Hits every typed playbook field.
tools: [read_file, grep]
budget:
  max_steps: 25
  max_cost_usd: 0.75
isolation: none
slash: kitchen
when_to_use: "exhaustive validator coverage"
output_schema:
  summary: string
references:
  - SOFTWARE_ARCHITECTURE.md
tool_restrictions:
  bash:
    - "git diff *"
sampling:
  temperature: 0.2
  max_tokens: 2048
context_recipe:
  step_reflection: terse
  memory_filter: [security]
prompt_version: 1
context_recipe_version: 1
phases:
  - name: explore
    on_enter: 'goal_push("explore")'
---
Body.`,
      'user',
      '/p',
    );
    expect(def.meta).toEqual({});
    expect(def.slash).toBe('kitchen');
    expect(def.whenToUse).toBe('exhaustive validator coverage');
    expect(def.outputSchema).toEqual({ summary: 'string' });
    expect(def.references).toEqual(['SOFTWARE_ARCHITECTURE.md']);
    expect(def.toolRestrictions).toEqual({ bash: { allow: ['git diff *'] } });
    expect(def.sampling).toEqual({ temperature: 0.2, maxTokens: 2048 });
    expect(def.contextRecipe).toEqual({
      stepReflection: 'terse',
      memoryFilter: ['security'],
    });
    expect(def.promptVersion).toBe(1);
    expect(def.contextRecipeVersion).toBe(1);
    expect(def.phases).toEqual([{ name: 'explore', onEnter: 'goal_push("explore")' }]);
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
