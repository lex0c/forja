import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EvalBudget, EvalCase, EvalExpectation, EvalSetup } from './types.ts';

// Fields tolerated at the top level. Unknown keys throw — the
// motivation is the same as policy parsing: a typo like `expects`
// (plural) silently dropped expectations and the case looked like
// it passed. Refuse to load.
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'prompt',
  'plan',
  'setup',
  'expect',
  'budget',
]);

const SETUP_KEYS: ReadonlySet<string> = new Set(['fixture', 'files']);

const BUDGET_KEYS: ReadonlySet<string> = new Set(['maxSteps', 'maxCostUsd']);

// Each expectation form has a tight schema — the parser rejects
// unknown discriminants AND extra keys to keep the surface
// auditable. The const map drives both validation and the
// exhaustive switch in `parseExpectation` (matches the
// EvalExpectation union 1:1; adding a new kind without updating
// here lights up `kind` exhaustiveness).
const EXPECTATION_KEYS = {
  tool_called: new Set(['tool_called']),
  tool_not_called: new Set(['tool_not_called']),
  file_exists: new Set(['file_exists']),
  file_not_exists: new Set(['file_not_exists']),
  file_contains: new Set(['file_contains']),
  status: new Set(['status']),
  exit_reason: new Set(['exit_reason']),
  output_contains: new Set(['output_contains']),
} as const satisfies Record<EvalExpectation['kind'], ReadonlySet<string>>;

const requireString = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`eval: ${label} must be a non-empty string`);
  }
  return v;
};

const requireRecord = (v: unknown, label: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`eval: ${label} must be a mapping`);
  }
  return v as Record<string, unknown>;
};

const rejectUnknown = (
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `eval: ${label} has unknown key '${key}' (expected one of: ${[...allowed]
          .sort()
          .join(', ')})`,
      );
    }
  }
};

const parseSetup = (raw: unknown): EvalSetup | undefined => {
  if (raw === undefined) return undefined;
  const r = requireRecord(raw, 'setup');
  rejectUnknown(r, SETUP_KEYS, 'setup');
  const setup: EvalSetup = {};
  if (r.fixture !== undefined) {
    setup.fixture = requireString(r.fixture, 'setup.fixture');
  }
  if (r.files !== undefined) {
    const files = requireRecord(r.files, 'setup.files');
    const out: Record<string, string> = {};
    for (const [path, body] of Object.entries(files)) {
      if (typeof body !== 'string') {
        throw new Error(`eval: setup.files['${path}'] must be a string`);
      }
      out[path] = body;
    }
    setup.files = out;
  }
  return setup;
};

const parseBudget = (raw: unknown): EvalBudget | undefined => {
  if (raw === undefined) return undefined;
  const r = requireRecord(raw, 'budget');
  rejectUnknown(r, BUDGET_KEYS, 'budget');
  const out: EvalBudget = {};
  if (r.maxSteps !== undefined) {
    if (typeof r.maxSteps !== 'number' || !Number.isInteger(r.maxSteps) || r.maxSteps <= 0) {
      throw new Error('eval: budget.maxSteps must be a positive integer');
    }
    out.maxSteps = r.maxSteps;
  }
  if (r.maxCostUsd !== undefined) {
    if (typeof r.maxCostUsd !== 'number' || r.maxCostUsd < 0) {
      throw new Error('eval: budget.maxCostUsd must be a non-negative number');
    }
    out.maxCostUsd = r.maxCostUsd;
  }
  return out;
};

const parseExpectation = (raw: unknown, idx: number): EvalExpectation => {
  const r = requireRecord(raw, `expect[${idx}]`);
  const keys = Object.keys(r);
  if (keys.length !== 1) {
    throw new Error(
      `eval: expect[${idx}] must have exactly one discriminant key (got: ${keys.join(', ') || '<none>'})`,
    );
  }
  const rawKind = keys[0] ?? '';
  if (!(rawKind in EXPECTATION_KEYS)) {
    throw new Error(
      `eval: expect[${idx}] unknown kind '${rawKind}' (expected one of: ${Object.keys(
        EXPECTATION_KEYS,
      )
        .sort()
        .join(', ')})`,
    );
  }
  const kind = rawKind as EvalExpectation['kind'];
  const allowed = EXPECTATION_KEYS[kind];
  rejectUnknown(r, allowed, `expect[${idx}]`);
  switch (kind) {
    case 'tool_called':
      return { kind, tool: requireString(r.tool_called, `expect[${idx}].tool_called`) };
    case 'tool_not_called':
      return { kind, tool: requireString(r.tool_not_called, `expect[${idx}].tool_not_called`) };
    case 'file_exists':
      return { kind, path: requireString(r.file_exists, `expect[${idx}].file_exists`) };
    case 'file_not_exists':
      return { kind, path: requireString(r.file_not_exists, `expect[${idx}].file_not_exists`) };
    case 'file_contains': {
      const fc = requireRecord(r.file_contains, `expect[${idx}].file_contains`);
      rejectUnknown(fc, new Set(['path', 'pattern']), `expect[${idx}].file_contains`);
      return {
        kind,
        path: requireString(fc.path, `expect[${idx}].file_contains.path`),
        pattern: requireString(fc.pattern, `expect[${idx}].file_contains.pattern`),
      };
    }
    case 'status': {
      const status = requireString(r.status, `expect[${idx}].status`);
      const valid = new Set(['done', 'interrupted', 'exhausted', 'error']);
      if (!valid.has(status)) {
        throw new Error(
          `eval: expect[${idx}].status must be one of: ${[...valid].sort().join(', ')}`,
        );
      }
      return { kind, status: status as 'done' | 'interrupted' | 'exhausted' | 'error' };
    }
    case 'exit_reason': {
      const reason = requireString(r.exit_reason, `expect[${idx}].exit_reason`);
      // Mirror of harness types.ExitReason; kept inline to avoid
      // pulling the union into runtime.
      const valid = new Set([
        'done',
        'maxSteps',
        'maxWallClockMs',
        'maxOutputTokens',
        'maxToolErrors',
        'degenerateLoop',
        'aborted',
        'providerError',
        'internalError',
        'scriptExhausted',
      ]);
      if (!valid.has(reason)) {
        throw new Error(
          `eval: expect[${idx}].exit_reason must be one of: ${[...valid].sort().join(', ')}`,
        );
      }
      return {
        kind,
        reason: reason as
          | 'done'
          | 'maxSteps'
          | 'maxWallClockMs'
          | 'maxOutputTokens'
          | 'maxToolErrors'
          | 'degenerateLoop'
          | 'aborted'
          | 'providerError'
          | 'internalError'
          | 'scriptExhausted',
      };
    }
    case 'output_contains':
      return { kind, pattern: requireString(r.output_contains, `expect[${idx}].output_contains`) };
  }
};

export const parseEvalCase = (yamlText: string, sourcePath: string): EvalCase => {
  const parsed = parseYaml(yamlText);
  if (parsed === undefined || parsed === null) {
    throw new Error(`eval: ${sourcePath} is empty`);
  }
  const r = requireRecord(parsed, sourcePath);
  rejectUnknown(r, TOP_LEVEL_KEYS, sourcePath);

  const name = requireString(r.name, `${sourcePath}: name`);
  const prompt = requireString(r.prompt, `${sourcePath}: prompt`);

  if (r.plan !== undefined && typeof r.plan !== 'boolean') {
    throw new Error(`eval: ${sourcePath}: plan must be boolean`);
  }
  if (!Array.isArray(r.expect)) {
    throw new Error(`eval: ${sourcePath}: expect must be a list`);
  }
  if (r.expect.length === 0) {
    throw new Error(`eval: ${sourcePath}: expect must contain at least one expectation`);
  }
  const expect = r.expect.map((e, i) => parseExpectation(e, i));

  const out: EvalCase = {
    name,
    sourcePath,
    prompt,
    expect,
  };
  if (r.plan === true) out.plan = true;
  const setup = parseSetup(r.setup);
  if (setup !== undefined) out.setup = setup;
  const budget = parseBudget(r.budget);
  if (budget !== undefined) out.budget = budget;
  return out;
};

export const loadEvalCase = (path: string): EvalCase => {
  const abs = resolve(path);
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`eval: ${path} is not a file`);
  }
  return parseEvalCase(readFileSync(abs, 'utf8'), abs);
};
