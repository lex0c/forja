import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  COMPACTION_STRATEGIES,
  type CompactionStrategy,
  EXIT_REASONS,
  type ExitReason,
} from '../harness/index.ts';
import type {
  EvalBudget,
  EvalCase,
  EvalExpectation,
  EvalHttpResponse,
  EvalSetup,
} from './types.ts';

// Built once from the harness's source-of-truth tuple. Adding a new
// `ExitReason` automatically widens this allowlist — no hand-rolled
// mirror to keep in sync (the prior inline literal silently rejected
// `stepStalled` for a whole milestone before anyone tried to assert
// it in YAML).
const VALID_EXIT_REASONS: ReadonlySet<string> = new Set(EXIT_REASONS);

// Fields tolerated at the top level. Unknown keys throw — the
// motivation is the same as policy parsing: a typo like `expects`
// (plural) silently dropped expectations and the case looked like
// it passed. Refuse to load.
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'prompt',
  'setup',
  'expect',
  'budget',
]);

const SETUP_KEYS: ReadonlySet<string> = new Set([
  'fixture',
  'files',
  'approvalPosture',
  'gitInit',
  'httpStub',
]);

const BUDGET_KEYS: ReadonlySet<string> = new Set([
  'maxSteps',
  'maxCostUsd',
  'compactionThreshold',
  'compactionPreserveTail',
  'compactionRelevance',
]);

// Driven off the harness's single-source tuple (same pattern as
// VALID_EXIT_REASONS above) — a new strategy in COMPACTION_STRATEGIES is
// assertable in YAML automatically, no hand-rolled mirror to drift.
const VALID_COMPACTION_STRATEGIES: ReadonlySet<string> = new Set(COMPACTION_STRATEGIES);

// Each expectation form has a tight schema — the parser rejects
// unknown discriminants AND extra keys to keep the surface
// auditable. The const map drives both validation and the
// exhaustive switch in `parseExpectation` (matches the
// EvalExpectation union 1:1; adding a new kind without updating
// here lights up `kind` exhaustiveness).
const EXPECTATION_KEYS = {
  tool_called: new Set(['tool_called']),
  tool_not_called: new Set(['tool_not_called']),
  tool_denied: new Set(['tool_denied']),
  file_exists: new Set(['file_exists']),
  file_not_exists: new Set(['file_not_exists']),
  file_contains: new Set(['file_contains']),
  file_not_contains: new Set(['file_not_contains']),
  status: new Set(['status']),
  exit_reason: new Set(['exit_reason']),
  output_contains: new Set(['output_contains']),
  compaction_triggered: new Set(['compaction_triggered']),
  min_steps: new Set(['min_steps']),
} as const satisfies Record<EvalExpectation['kind'], ReadonlySet<string>>;

const requireString = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`eval: ${label} must be a non-empty string`);
  }
  return v;
};

// Reusable parse-time guard for any path that must stay inside
// the eval workspace at runtime (setup.files keys, file_exists/
// file_not_exists/file_contains expectation paths). Rejects empty,
// absolute, and any `..` segment. Loader-level rejection surfaces
// the error before any FS interaction; the executor still
// validates resolved containment to catch programmatic
// EvalCase construction that bypasses the loader.
const validateWorkspaceRelativePath = (path: string, label: string): void => {
  if (path.length === 0) {
    throw new Error(`eval: ${label} must be a non-empty path`);
  }
  if (isAbsolute(path)) {
    throw new Error(
      `eval: ${label} '${path}' is absolute; only paths relative to the eval workspace are allowed`,
    );
  }
  const segments = path.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(
      `eval: ${label} '${path}' contains '..' segment; paths must stay inside the eval workspace`,
    );
  }
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
    const fixture = requireString(r.fixture, 'setup.fixture');
    // Absolute fixture paths bypass the executor's case-relative
    // boundary entirely (a literal '/etc' or '/home/x/.ssh' would
    // resolve to itself, escaping any containment check anchored
    // at the case dir). Reject at parse time. `..` segments are
    // allowed because legitimate layouts ship fixtures in a
    // sibling directory (e.g., `../fixtures/foo`); the executor
    // enforces the resolved-path boundary.
    if (isAbsolute(fixture)) {
      throw new Error(
        `eval: setup.fixture '${fixture}' is absolute; only paths relative to the case file are allowed`,
      );
    }
    setup.fixture = fixture;
  }
  if (r.files !== undefined) {
    const files = requireRecord(r.files, 'setup.files');
    const out: Record<string, string> = {};
    for (const [path, body] of Object.entries(files)) {
      if (typeof body !== 'string') {
        throw new Error(`eval: setup.files['${path}'] must be a string`);
      }
      validateWorkspaceRelativePath(path, `setup.files['${path}']`);
      out[path] = body;
    }
    setup.files = out;
  }
  if (r.gitInit !== undefined) {
    if (typeof r.gitInit !== 'boolean') {
      throw new Error('eval: setup.gitInit must be a boolean');
    }
    setup.gitInit = r.gitInit;
  }
  if (r.approvalPosture !== undefined) {
    const p = requireString(r.approvalPosture, 'setup.approvalPosture');
    if (p !== 'supervised' && p !== 'autonomous') {
      throw new Error(
        `eval: setup.approvalPosture must be 'supervised' or 'autonomous', got '${p}'`,
      );
    }
    setup.approvalPosture = p;
  }
  if (r.httpStub !== undefined) {
    const stub = requireRecord(r.httpStub, 'setup.httpStub');
    const out: Record<string, EvalHttpResponse> = {};
    for (const [url, resp] of Object.entries(stub)) {
      const rr = requireRecord(resp, `setup.httpStub['${url}']`);
      const entry: EvalHttpResponse = {
        body: requireString(rr.body, `setup.httpStub['${url}'].body`),
      };
      if (rr.status !== undefined) {
        if (
          typeof rr.status !== 'number' ||
          !Number.isInteger(rr.status) ||
          rr.status < 100 ||
          rr.status > 599
        ) {
          throw new Error(`eval: setup.httpStub['${url}'].status must be an integer in [100, 599]`);
        }
        entry.status = rr.status;
      }
      if (rr.contentType !== undefined) {
        entry.contentType = requireString(rr.contentType, `setup.httpStub['${url}'].contentType`);
      }
      out[url] = entry;
    }
    setup.httpStub = out;
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
  if (r.compactionThreshold !== undefined) {
    if (
      typeof r.compactionThreshold !== 'number' ||
      r.compactionThreshold <= 0 ||
      r.compactionThreshold > 1
    ) {
      throw new Error('eval: budget.compactionThreshold must be a number in (0, 1]');
    }
    out.compactionThreshold = r.compactionThreshold;
  }
  if (r.compactionPreserveTail !== undefined) {
    if (
      typeof r.compactionPreserveTail !== 'number' ||
      !Number.isInteger(r.compactionPreserveTail) ||
      r.compactionPreserveTail < 0
    ) {
      throw new Error('eval: budget.compactionPreserveTail must be a non-negative integer');
    }
    out.compactionPreserveTail = r.compactionPreserveTail;
  }
  if (r.compactionRelevance !== undefined) {
    if (typeof r.compactionRelevance !== 'boolean') {
      throw new Error('eval: budget.compactionRelevance must be a boolean');
    }
    out.compactionRelevance = r.compactionRelevance;
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
    case 'tool_denied':
      return { kind, tool: requireString(r.tool_denied, `expect[${idx}].tool_denied`) };
    case 'file_exists': {
      const path = requireString(r.file_exists, `expect[${idx}].file_exists`);
      validateWorkspaceRelativePath(path, `expect[${idx}].file_exists`);
      return { kind, path };
    }
    case 'file_not_exists': {
      const path = requireString(r.file_not_exists, `expect[${idx}].file_not_exists`);
      validateWorkspaceRelativePath(path, `expect[${idx}].file_not_exists`);
      return { kind, path };
    }
    case 'file_contains': {
      const fc = requireRecord(r.file_contains, `expect[${idx}].file_contains`);
      rejectUnknown(fc, new Set(['path', 'pattern']), `expect[${idx}].file_contains`);
      const path = requireString(fc.path, `expect[${idx}].file_contains.path`);
      validateWorkspaceRelativePath(path, `expect[${idx}].file_contains.path`);
      return {
        kind,
        path,
        pattern: requireString(fc.pattern, `expect[${idx}].file_contains.pattern`),
      };
    }
    case 'file_not_contains': {
      const fnc = requireRecord(r.file_not_contains, `expect[${idx}].file_not_contains`);
      rejectUnknown(fnc, new Set(['path', 'pattern']), `expect[${idx}].file_not_contains`);
      const path = requireString(fnc.path, `expect[${idx}].file_not_contains.path`);
      validateWorkspaceRelativePath(path, `expect[${idx}].file_not_contains.path`);
      return {
        kind,
        path,
        pattern: requireString(fnc.pattern, `expect[${idx}].file_not_contains.pattern`),
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
      if (!VALID_EXIT_REASONS.has(reason)) {
        throw new Error(
          `eval: expect[${idx}].exit_reason must be one of: ${[...VALID_EXIT_REASONS]
            .sort()
            .join(', ')}`,
        );
      }
      return { kind, reason: reason as ExitReason };
    }
    case 'output_contains':
      return { kind, pattern: requireString(r.output_contains, `expect[${idx}].output_contains`) };
    case 'min_steps': {
      const n = r.min_steps;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        throw new Error(`eval: expect[${idx}].min_steps must be a positive integer`);
      }
      return { kind, count: n };
    }
    case 'compaction_triggered': {
      const cf = requireRecord(r.compaction_triggered, `expect[${idx}].compaction_triggered`);
      rejectUnknown(cf, new Set(['min_count', 'strategy']), `expect[${idx}].compaction_triggered`);
      const minCountRaw = cf.min_count;
      if (typeof minCountRaw !== 'number' || !Number.isInteger(minCountRaw) || minCountRaw < 1) {
        throw new Error(
          `eval: expect[${idx}].compaction_triggered.min_count must be a positive integer`,
        );
      }
      const out: EvalExpectation = { kind, minCount: minCountRaw };
      if (cf.strategy !== undefined) {
        const strategy = requireString(cf.strategy, `expect[${idx}].compaction_triggered.strategy`);
        if (!VALID_COMPACTION_STRATEGIES.has(strategy)) {
          throw new Error(
            `eval: expect[${idx}].compaction_triggered.strategy must be one of: ${[
              ...VALID_COMPACTION_STRATEGIES,
            ]
              .sort()
              .join(', ')}`,
          );
        }
        out.strategy = strategy as CompactionStrategy;
      }
      return out;
    }
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
