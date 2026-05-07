import { describe, expect, test } from 'bun:test';
import {
  MAX_PLAYBOOK_TABLE_ROWS,
  PLAYBOOK_DELEGATION_PREAMBLE,
  composeWithPlaybookHint,
} from '../../src/cli/playbook-prompt.ts';
import type { SubagentSet } from '../../src/subagents/load.ts';
import type { SubagentDefinition } from '../../src/subagents/types.ts';

// Minimal subagent definition factory. Tests only care about
// `name` + `whenToUse` for table semantics; everything else gets a
// stub. Optional `whenToUse` lets a test exercise the
// without-whenToUse filter without writing a full second factory.
const makeDef = (name: string, whenToUse?: string): SubagentDefinition => ({
  name,
  description: `${name} description`,
  tools: [],
  budget: { maxSteps: 1, maxCostUsd: 0.01 },
  systemPrompt: 'body',
  scope: 'user',
  isolation: 'none',
  sourcePath: `/fake/${name}.md`,
  sourceSha256: 'a'.repeat(64),
  ...(whenToUse !== undefined ? { whenToUse } : {}),
  meta: {},
});

const makeSet = (defs: SubagentDefinition[]): SubagentSet => {
  const byName = new Map<string, SubagentDefinition>();
  for (const def of defs) byName.set(def.name, def);
  return { byName, shadows: [] };
};

describe('PLAYBOOK_DELEGATION_PREAMBLE', () => {
  test('cites the routing tools the model is supposed to use', () => {
    expect(PLAYBOOK_DELEGATION_PREAMBLE).toContain('task_sync');
    expect(PLAYBOOK_DELEGATION_PREAMBLE).toContain('task_async');
  });

  test('contains both the delegate and do-not-delegate halves', () => {
    // Spec PLAYBOOKS.md §1.4 lists constraints negativas first,
    // then positivas. Both halves must be present — the model
    // tunes against negative constraints more reliably than
    // positive ones, so dropping either half degrades routing.
    expect(PLAYBOOK_DELEGATION_PREAMBLE).toMatch(/Delegate to a playbook when/i);
    expect(PLAYBOOK_DELEGATION_PREAMBLE).toMatch(/Do NOT delegate when/i);
  });

  test('warns against auto-delegating everything', () => {
    // The §1.4 anti-pattern ("auto-delegar tudo") must surface in
    // the preamble, otherwise the model treats the table as a
    // menu of shortcuts and over-routes simple questions.
    expect(PLAYBOOK_DELEGATION_PREAMBLE.toLowerCase()).toContain('default to answering directly');
  });
});

describe('composeWithPlaybookHint — empty registry paths', () => {
  test('returns downstream untouched when set is undefined', () => {
    expect(composeWithPlaybookHint('user prompt', undefined)).toBe('user prompt');
    expect(composeWithPlaybookHint(undefined, undefined)).toBeUndefined();
  });

  test('returns downstream untouched when set has no defs', () => {
    expect(composeWithPlaybookHint('user prompt', makeSet([]))).toBe('user prompt');
  });

  test('returns downstream untouched when no def has whenToUse', () => {
    // Legacy generic subagents (`agents/explore.md` etc.) without
    // a `when_to_use` declaration are intentionally absent from
    // the discovery table — a row with an empty `when_to_use`
    // cell teaches nothing. The downstream prompt must pass
    // through verbatim in this case.
    const set = makeSet([makeDef('explore'), makeDef('legacy-helper')]);
    expect(composeWithPlaybookHint('user prompt', set)).toBe('user prompt');
  });
});

describe('composeWithPlaybookHint — table rendering', () => {
  test('single eligible def yields a one-row table', () => {
    const set = makeSet([makeDef('code-review', 'diff ready for gate before merge')]);
    const out = composeWithPlaybookHint(undefined, set);
    expect(out).toBeDefined();
    expect(out).toContain(PLAYBOOK_DELEGATION_PREAMBLE);
    expect(out).toContain('| name | when_to_use |');
    expect(out).toContain('|---|---|');
    expect(out).toContain('| code-review | diff ready for gate before merge |');
  });

  test('multiple eligible defs sorted alphabetically by name', () => {
    // Spec PLAYBOOKS.md §1.4 emphasizes the table is "stable";
    // alphabetical ordering means scope precedence (user vs
    // project) and load iteration order do not perturb the
    // rendered prompt. Regression tests can hash the prompt
    // safely.
    const set = makeSet([
      makeDef('refactor', 'apply scope-bounded mutations'),
      makeDef('code-review', 'gate diff before merge'),
      makeDef('debug', 'reproduce + isolate root cause'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out.length).toBeGreaterThan(0);
    const reviewIdx = out.indexOf('code-review');
    const debugIdx = out.indexOf('debug');
    const refactorIdx = out.indexOf('refactor');
    expect(reviewIdx).toBeGreaterThan(0);
    expect(debugIdx).toBeGreaterThan(reviewIdx);
    expect(refactorIdx).toBeGreaterThan(debugIdx);
  });

  test('omits defs without whenToUse but keeps the rest', () => {
    const set = makeSet([
      makeDef('explore'), // no whenToUse — must NOT appear
      makeDef('code-review', 'gate diff before merge'),
    ]);
    const out = composeWithPlaybookHint(undefined, set);
    expect(out).toBeDefined();
    expect(out).toContain('code-review');
    // `explore` would only legitimately appear inside a row,
    // never inside the preamble or table header. Asserting
    // absence catches a regression where the filter let
    // whenToUse-less defs through.
    expect(out).not.toMatch(/\| explore \|/);
  });

  test('truncates at MAX_PLAYBOOK_TABLE_ROWS with overflow footer', () => {
    // 14 eligible defs > cap of 12 → first 12 (alphabetical)
    // shown, footer line summarizes the remaining 2.
    const defs: SubagentDefinition[] = [];
    for (let i = 0; i < MAX_PLAYBOOK_TABLE_ROWS + 2; i++) {
      // Pad ids to a stable two-digit width so alphabetical
      // sort matches numerical insertion order — `pb-09` <
      // `pb-10` in both. Without padding `pb-10` sorts before
      // `pb-2` and the assertions below would lie.
      const id = String(i).padStart(2, '0');
      defs.push(makeDef(`pb-${id}`, `purpose ${id}`));
    }
    const out = composeWithPlaybookHint(undefined, makeSet(defs));
    expect(out).toBeDefined();
    expect(out).toContain('pb-00');
    expect(out).toContain(`pb-${String(MAX_PLAYBOOK_TABLE_ROWS - 1).padStart(2, '0')}`);
    // First entry that should be dropped:
    expect(out).not.toContain(`| pb-${String(MAX_PLAYBOOK_TABLE_ROWS).padStart(2, '0')} |`);
    expect(out).toContain('additional playbooks omitted');
  });

  test('exact cap (MAX rows) does NOT trigger the overflow footer', () => {
    const defs: SubagentDefinition[] = [];
    for (let i = 0; i < MAX_PLAYBOOK_TABLE_ROWS; i++) {
      const id = String(i).padStart(2, '0');
      defs.push(makeDef(`pb-${id}`, `purpose ${id}`));
    }
    const out = composeWithPlaybookHint(undefined, makeSet(defs));
    expect(out).toBeDefined();
    expect(out).not.toContain('additional playbooks omitted');
  });

  test('long whenToUse cells render verbatim (no per-row truncation)', () => {
    // The §1.4 cap is on table row count and total tokens, not
    // per-cell length. A long `when_to_use` that helps routing
    // is more valuable than a truncated one.
    const longWhen =
      'decisão com confiança alta + evidência fraca; raciocínio que usa "obviously", "sempre podemos depois", ou ignora opções óbvias (não fazer nada, comprar, deprecar)';
    const set = makeSet([makeDef('challenge-assumptions', longWhen)]);
    const out = composeWithPlaybookHint(undefined, set);
    expect(out).toContain(longWhen);
  });
});

describe('composeWithPlaybookHint — composition with downstream', () => {
  const set = makeSet([makeDef('code-review', 'gate diff before merge')]);

  test('hint goes FIRST when a downstream is provided', () => {
    const out = composeWithPlaybookHint('user prompt body', set) ?? '';
    expect(out.length).toBeGreaterThan(0);
    const preambleIdx = out.indexOf(PLAYBOOK_DELEGATION_PREAMBLE);
    const sepIdx = out.indexOf('---');
    const userIdx = out.indexOf('user prompt body');
    expect(preambleIdx).toBe(0);
    expect(sepIdx).toBeGreaterThan(preambleIdx);
    expect(userIdx).toBeGreaterThan(sepIdx);
  });

  test('returns hint alone when downstream is undefined', () => {
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('---\n\nuser');
    expect(out.startsWith(PLAYBOOK_DELEGATION_PREAMBLE)).toBe(true);
  });

  test('returns hint alone when downstream is empty string', () => {
    // Empty string is treated like undefined: the separator + ""
    // would render as a dangling `---` at the bottom of the
    // prompt for no benefit. Mirrors `composeWithParallelHint`.
    const out = composeWithPlaybookHint('', set) ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/---\s*$/);
    expect(out.startsWith(PLAYBOOK_DELEGATION_PREAMBLE)).toBe(true);
  });
});

describe('composeWithPlaybookHint — scope precedence does not perturb the table', () => {
  test('user-scope and project-scope defs both render under their canonical name', () => {
    // Stage a registry where one def is project-scoped and one
    // is user-scoped — ordering still alphabetical, scope is
    // not surfaced in the table. Anchors the §1.4 invariant
    // that the table is a routing hint, not a scope inspector.
    const userDef = makeDef('explain', 'mental model question');
    const projectDef: SubagentDefinition = {
      ...makeDef('code-review', 'gate diff before merge'),
      scope: 'project',
    };
    const set = makeSet([userDef, projectDef]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out.length).toBeGreaterThan(0);
    const reviewIdx = out.indexOf('| code-review |');
    const explainIdx = out.indexOf('| explain |');
    expect(reviewIdx).toBeGreaterThan(0);
    expect(explainIdx).toBeGreaterThan(reviewIdx);
    // No scope leak into the rendered table:
    expect(out).not.toContain('project');
    expect(out).not.toContain('user-scope');
  });
});
