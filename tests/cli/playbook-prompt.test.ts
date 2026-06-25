import { describe, expect, test } from 'bun:test';
import {
  MAX_PLAYBOOK_TABLE_ROWS,
  PLAYBOOK_DELEGATION_PREAMBLE,
  PLAYBOOK_WORKFLOW_HEADER,
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

  test('makes dispatch the default when the request IS a playbook job (not inline)', () => {
    // Regression: opus-4-8 with a clean catalog reviewed "faça code review da
    // branch atual" INLINE instead of dispatching code-review — the "default
    // to answering directly" framing pulled against dispatch for a request that
    // names the playbook's job. The preamble must explicitly route such a
    // request to dispatch and call out the inline anti-pattern.
    const lower = PLAYBOOK_DELEGATION_PREAMBLE.toLowerCase();
    expect(lower).toContain('dispatch');
    expect(lower).toContain('inline');
    // The concrete review → code-review mapping must be present so the model
    // connects the natural-language ask to the routing identifier.
    expect(lower).toMatch(/review[^\n]*code-review/);
  });

  test('frames the context-compression economics, not just schema-fit', () => {
    // The load-bearing reason to delegate is keeping a large raw
    // exploration out of the parent context — exploration cost vs
    // summary cost. Without this the model only delegates for the
    // structured-playbook case and floods the turn with raw reads
    // on open-ended investigation it should have isolated.
    const lower = PLAYBOOK_DELEGATION_PREAMBLE.toLowerCase();
    expect(lower).toContain('context compression');
    expect(lower).toMatch(/investigation|exploration/);
    // The self-contained-investigation case must be a stated
    // candidate, and tightly-coupled work a stated exclusion.
    expect(lower).toContain('self-contained');
    expect(lower).toContain('tightly coupled');
  });

  test('tells the model to relay a delegated result, not treat dispatch as task-done', () => {
    // Regression: a weak model (kimi-k2.7) delegated "explore o repo" to
    // general-purpose, got the summary back, then asked "what's next" instead of
    // presenting it. The block governs WHEN to delegate; it must also say what to
    // do with the result — relay it when the request WAS the delegated work, not
    // end the turn with the report unspoken.
    const lower = PLAYBOOK_DELEGATION_PREAMBLE.toLowerCase();
    expect(lower).toContain('your answer');
    expect(lower).toContain('present its findings');
    expect(lower).toContain('explore the repo');
  });

  test('names both subagent return shapes — fixed-schema (playbooks) and prose (general-purpose)', () => {
    // The opening over-claimed "fixed-schema report" for every subagent, but
    // general-purpose returns prose — a seam a weak model trips on (got prose,
    // expected schema, unsure if done). Both shapes must be named.
    expect(PLAYBOOK_DELEGATION_PREAMBLE).toContain('fixed-schema report');
    expect(PLAYBOOK_DELEGATION_PREAMBLE.toLowerCase()).toContain('prose summary');
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

describe('PLAYBOOK_WORKFLOW_HEADER', () => {
  test('teaches decomposition before action', () => {
    expect(PLAYBOOK_WORKFLOW_HEADER.toLowerCase()).toContain('decomposition');
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/name the discrete sub-problems/i);
  });

  test('gates decomposition on multi-file / multi-surface scope', () => {
    // Without an explicit scope threshold, the model over-applies
    // decomposition to trivial changes (every typo fix becomes a
    // planning exercise). The threshold language ("multiple
    // files", "verification surfaces") gives the model something
    // to apply mechanically.
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/multiple files/i);
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/verification surfaces/i);
  });

  test('explicitly excludes trivial changes from the decomposition rule', () => {
    // The negative side of the threshold matters more than the
    // positive: without an exemption clause, the model treats
    // any prompt with two verbs as "multi-step" and decomposes
    // a one-line CSS fix.
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/Trivial changes/i);
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/skip this/i);
  });

  test('frames each delegation as self-contained', () => {
    // Without this discipline, the model assumes the subagent
    // shares its memory of the conversation; in practice the
    // child runs in an isolated context. The hint must remind
    // the model to inline goal + constraints.
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/self-contained/i);
    expect(PLAYBOOK_WORKFLOW_HEADER).toMatch(/zero context/i);
  });

  test('cites both task_async and task_sync as fan-out vs sequential', () => {
    expect(PLAYBOOK_WORKFLOW_HEADER).toContain('task_async');
    expect(PLAYBOOK_WORKFLOW_HEADER).toContain('task_sync');
  });
});

describe('composeWithPlaybookHint — workflow + closing-review block', () => {
  test('workflow header is appended after the table', () => {
    const set = makeSet([makeDef('refactor', 'apply scope-bounded mutations')]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    const tableIdx = out.indexOf('| name | when_to_use |');
    const workflowIdx = out.indexOf('**Workflow:**');
    expect(tableIdx).toBeGreaterThan(0);
    expect(workflowIdx).toBeGreaterThan(tableIdx);
  });

  test('closing-review bullet cites both code-review and security-audit when both loaded', () => {
    const set = makeSet([
      makeDef('code-review', 'gate diff before merge'),
      makeDef('security-audit', 'scan changes for vuln surface'),
      makeDef('refactor', 'apply scope-bounded mutations'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out).toMatch(/consider closing with `code-review` and `security-audit`/);
  });

  test('closing-review is phrased as a suggestion, not a prescription', () => {
    // "Consider" + "skip for trivial" is the load-bearing softening
    // that prevents reflexive review on doc-only / single-line
    // changes. Mandatory phrasing ("run before declaring done")
    // produces over-ritual; the suggestion gate keeps the cost
    // (~$0.002 + 3-5s per child) proportional to actual risk.
    const set = makeSet([
      makeDef('code-review', 'gate diff before merge'),
      makeDef('security-audit', 'scan changes for vuln surface'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out).toMatch(/consider closing with/i);
    expect(out).toMatch(/Skip for docs, comments, config tweaks/i);
    // Negative: must not read as a hard prescription.
    expect(out).not.toMatch(/^- Before declaring the work done, run/im);
  });

  test('closing-review bullet falls back to single name when only one is loaded', () => {
    const set = makeSet([
      makeDef('code-review', 'gate diff before merge'),
      makeDef('refactor', 'apply scope-bounded mutations'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    expect(out).toMatch(/consider closing with `code-review` before/);
    // Singular grammar: when only one peer is cited, the
    // following sentence must not say "Both are read-only".
    expect(out).toMatch(/It is read-only/);
    expect(out).not.toMatch(/Both are read-only/);
    // Negative: the missing peer must not appear inside the
    // closing bullet itself. (The preamble cites
    // `security-audit` as an example of bias-driven delegation,
    // which is fine; we scope the negative assertion to the
    // bullet's slice of the rendered string.)
    const closingIdx = out.indexOf('consider closing with');
    expect(closingIdx).toBeGreaterThan(0);
    const closingSlice = out.slice(closingIdx);
    expect(closingSlice).not.toContain('security-audit');
  });

  test('closing-review bullet absent when neither review playbook is loaded', () => {
    const set = makeSet([
      makeDef('refactor', 'apply scope-bounded mutations'),
      makeDef('debug', 'reproduce + isolate root cause'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    // Workflow header still renders (decomposition is universal);
    // only the closing-review bullet drops out.
    expect(out).toContain(PLAYBOOK_WORKFLOW_HEADER);
    expect(out).not.toMatch(/consider closing with/i);
  });

  test('closing-review bullet position: after the workflow header', () => {
    const set = makeSet([
      makeDef('code-review', 'gate diff before merge'),
      makeDef('security-audit', 'scan changes for vuln surface'),
    ]);
    const out = composeWithPlaybookHint(undefined, set) ?? '';
    const headerIdx = out.indexOf('**Workflow:**');
    const closingIdx = out.indexOf('consider closing with');
    expect(headerIdx).toBeGreaterThan(0);
    expect(closingIdx).toBeGreaterThan(headerIdx);
  });
});
