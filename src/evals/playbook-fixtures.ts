// Playbook eval fixture loader (`PLAYBOOKS.md` §1.4 + §10).
//
// The slice 10 entry point. Reads YAML fixtures from
// `evals/playbooks/` and surfaces them as typed shapes a runner
// (or a smoke test) can iterate over without invoking the
// provider. The loader's job is end-to-end shape validation —
// catching a malformed fixture at "did this even parse" time so
// the regression suite never reports false confidence from a
// broken file silently dropped.
//
// Two flavors live side-by-side:
//
//   1. **Per-playbook fixtures** — one directory per canonical
//      playbook (`evals/playbooks/code-review/01-stub.yaml`
//      etc.). Each fixture pairs a prompt with the playbook
//      name + optional output assertions. The shipped stubs
//      cover one minimal case per playbook; the full
//      regression set grows over time as authors add real-
//      world prompts that exercise specific edge cases.
//
//   2. **Routing fixtures** — a flat set under
//      `evals/playbooks/_routing/` (one yaml per case). Each
//      pairs a prompt with the expected dispatch decision
//      (`'<playbook-name>' | 'none' | 'ambiguous'`). The
//      routing metric (`PLAYBOOKS.md` §1.4) is computed from
//      the shipped set: `wrong_dispatch_rate`,
//      `false_dispatch_rate`, `missed_dispatch_rate`. PR-
//      blocking enforcement is deferred until the eval harness
//      has a live provider runner.
//
// The loader does NOT run the playbook against the prompt —
// that requires a provider key, real cost, and is opt-in via
// the future eval CLI. Every test in the suite calling this
// loader is shape-only.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Shape of a per-playbook fixture file. Authors compose these
// inside `evals/playbooks/<playbook-name>/<id>.yaml`.
export interface PlaybookFixture {
  // Short identifier (kebab-case). Used in `evals/...` reports
  // for per-fixture grouping and in eval audit rows. Must match
  // the filename minus `.yaml` so tooling can grep both.
  name: string;
  // Canonical playbook name (matches the `name:` field of the
  // .md definition). The runner dispatches via
  // `task_sync(playbook=<this>)` against this prompt.
  playbook: string;
  // Self-contained prompt. Same constraint as a `task_sync`
  // call from the model: the subagent has no view of any
  // surrounding conversation, so the prompt must include all
  // context the playbook needs.
  prompt: string;
  // Optional assertions evaluated post-run. Slice 10 ships
  // shape only — the runner that consumes them lands in a
  // future slice. Authors who declare them today get free
  // forward-compat.
  expect?: PlaybookExpectations;
  // Resolved absolute path the fixture was loaded from.
  // Diagnostics use this in error messages.
  sourcePath: string;
  // Directory name above the file — `code-review`, etc. Used
  // by the loader to verify `playbook` matches the directory.
  // Caught at load time so a misfiled fixture does not
  // dispatch against the wrong playbook silently.
  directory: string;
}

export interface PlaybookExpectations {
  // When true (default), the runner validates the terminal
  // output against the playbook's declared output_schema
  // (`PLAYBOOKS.md` §1.2). Setting `false` skips schema
  // validation — used for fixtures that exercise an explicit
  // mismatch (e.g., a test pin for `playbook.output_invalid`).
  outputSchemaValid?: boolean;
  // Substring assertions on the rendered terminal output.
  // Each entry must appear at least once. A simple, robust
  // proxy for "did the model take the right shape" without
  // requiring full output equality (which models drift on).
  outputContains?: ReadonlyArray<string>;
  // Optional substrings that MUST NOT appear. Useful for
  // negative tests ("the output should NOT mention X").
  outputNotContains?: ReadonlyArray<string>;
}

// Routing fixture — exercises the principal agent's auto-
// delegation decision (`PLAYBOOKS.md` §1.4). Three flavors:
//
//   - `dispatch: <playbook-name>` — the prompt SHOULD route
//     to that playbook. The runner asserts the principal
//     called `task_sync(playbook=<playbook-name>)` (or
//     `task_async`).
//   - `dispatch: none` — the prompt should NOT delegate.
//     Direct response is the right call. The runner asserts
//     the principal answered without invoking task_*.
//   - `dispatch: ambiguous` — multi-playbook plausible.
//     Either a clarifying question OR a justified single
//     dispatch is acceptable. The runner asserts no WRONG
//     dispatch (any non-listed playbook name is a fail).
export interface RoutingFixture {
  name: string;
  prompt: string;
  // Either a specific playbook name, the `'none'` sentinel,
  // or the `'ambiguous'` sentinel. Loader validates the
  // discriminator so a typo (`'amb'`, `'no'`) fails loud.
  expectDispatch: string | 'none' | 'ambiguous';
  // Optional list of playbook names that are acceptable when
  // `expectDispatch === 'ambiguous'`. The runner allows ANY
  // of these as the dispatched name. Empty / absent means
  // "any of the known playbooks is acceptable".
  ambiguousAcceptable?: ReadonlyArray<string>;
  sourcePath: string;
}

// Per-playbook keys allowed at the top of a fixture YAML.
const PLAYBOOK_FIXTURE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'playbook',
  'prompt',
  'expect',
]);
const PLAYBOOK_EXPECT_KEYS: ReadonlySet<string> = new Set([
  'output_schema_valid',
  'output_contains',
  'output_not_contains',
]);
const ROUTING_FIXTURE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'prompt',
  'expect_dispatch',
  'ambiguous_acceptable',
]);

// Keys reserved for routing dispatch values that are NOT
// playbook names. Loader rejects any other non-playbook name in
// `expect_dispatch` later (when a registry of known playbooks is
// available); for shape validation here we only enforce
// well-formedness.
const ROUTING_SENTINELS: ReadonlySet<string> = new Set(['none', 'ambiguous']);

// Strict kebab-case for playbook names (the loader-side regex
// `load.ts` uses): must start with a letter. Reused for the
// `playbook` field on per-playbook fixtures and for routing
// playbook references.
const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

// Fixture names allow a leading digit so authors can prefix
// fixture filenames with sort-order tokens (`01-foo`, `02-bar`)
// — the natural way to order regression fixtures in a directory
// without renaming when a new case lands in the middle. The
// loader still requires the rest of the name to be lowercase
// kebab so reports / paths stay greppable.
const FIXTURE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const requireString = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`playbook fixture: ${label} must be a non-empty string`);
  }
  return v;
};

const requireKebab = (v: string, label: string): string => {
  if (!KEBAB_RE.test(v)) {
    throw new Error(`playbook fixture: ${label} must be kebab-case (got '${v}')`);
  }
  return v;
};

const requireFixtureName = (v: string, label: string): string => {
  if (!FIXTURE_NAME_RE.test(v)) {
    throw new Error(
      `playbook fixture: ${label} must be lowercase kebab (digits-or-letter prefix; got '${v}')`,
    );
  }
  return v;
};

const requireRecord = (v: unknown, label: string): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`playbook fixture: ${label} must be a YAML mapping`);
  }
  return v as Record<string, unknown>;
};

const requireStringArray = (v: unknown, label: string): string[] => {
  if (!Array.isArray(v)) {
    throw new Error(`playbook fixture: ${label} must be a list of strings`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i] === '') {
      throw new Error(`playbook fixture: ${label}[${i}] must be a non-empty string`);
    }
  }
  return v as string[];
};

const parseExpectations = (raw: unknown, sourcePath: string): PlaybookExpectations => {
  const r = requireRecord(raw, `${sourcePath}: 'expect'`);
  for (const key of Object.keys(r)) {
    if (!PLAYBOOK_EXPECT_KEYS.has(key)) {
      throw new Error(
        `playbook fixture ${sourcePath}: 'expect.${key}' is not a recognized field (allowed: ${Array.from(PLAYBOOK_EXPECT_KEYS).sort().join(', ')})`,
      );
    }
  }
  const out: PlaybookExpectations = {};
  if (r.output_schema_valid !== undefined) {
    if (typeof r.output_schema_valid !== 'boolean') {
      throw new Error(
        `playbook fixture ${sourcePath}: 'expect.output_schema_valid' must be a boolean`,
      );
    }
    out.outputSchemaValid = r.output_schema_valid;
  }
  if (r.output_contains !== undefined) {
    out.outputContains = requireStringArray(
      r.output_contains,
      `${sourcePath}: 'expect.output_contains'`,
    );
  }
  if (r.output_not_contains !== undefined) {
    out.outputNotContains = requireStringArray(
      r.output_not_contains,
      `${sourcePath}: 'expect.output_not_contains'`,
    );
  }
  return out;
};

// Parse a single per-playbook fixture YAML.
const parsePlaybookFixture = (
  content: string,
  sourcePath: string,
  directory: string,
): PlaybookFixture => {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`playbook fixture ${sourcePath}: malformed YAML: ${msg}`);
  }
  const r = requireRecord(raw, `${sourcePath}: top-level`);
  for (const key of Object.keys(r)) {
    if (!PLAYBOOK_FIXTURE_KEYS.has(key)) {
      throw new Error(
        `playbook fixture ${sourcePath}: '${key}' is not a recognized field (allowed: ${Array.from(PLAYBOOK_FIXTURE_KEYS).sort().join(', ')})`,
      );
    }
  }
  const name = requireFixtureName(
    requireString(r.name, `${sourcePath}: 'name'`),
    `${sourcePath}: 'name'`,
  );
  const playbook = requireKebab(
    requireString(r.playbook, `${sourcePath}: 'playbook'`),
    `${sourcePath}: 'playbook'`,
  );
  // Cross-check: the directory above the fixture file MUST be
  // the playbook name. Authors who drop a fixture in the wrong
  // directory get a loud error instead of silently dispatching
  // the wrong playbook in the regression suite.
  if (playbook !== directory) {
    throw new Error(
      `playbook fixture ${sourcePath}: 'playbook' is '${playbook}' but file lives in directory '${directory}' — fixtures must sit under their playbook's directory`,
    );
  }
  const prompt = requireString(r.prompt, `${sourcePath}: 'prompt'`);
  const out: PlaybookFixture = {
    name,
    playbook,
    prompt,
    sourcePath,
    directory,
  };
  if (r.expect !== undefined) out.expect = parseExpectations(r.expect, sourcePath);
  return out;
};

// Parse a single routing fixture YAML.
const parseRoutingFixture = (content: string, sourcePath: string): RoutingFixture => {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`routing fixture ${sourcePath}: malformed YAML: ${msg}`);
  }
  const r = requireRecord(raw, `${sourcePath}: top-level`);
  for (const key of Object.keys(r)) {
    if (!ROUTING_FIXTURE_KEYS.has(key)) {
      throw new Error(
        `routing fixture ${sourcePath}: '${key}' is not a recognized field (allowed: ${Array.from(ROUTING_FIXTURE_KEYS).sort().join(', ')})`,
      );
    }
  }
  const name = requireFixtureName(
    requireString(r.name, `${sourcePath}: 'name'`),
    `${sourcePath}: 'name'`,
  );
  const prompt = requireString(r.prompt, `${sourcePath}: 'prompt'`);
  const expectDispatch = requireString(r.expect_dispatch, `${sourcePath}: 'expect_dispatch'`);
  // The dispatch value is either a sentinel ('none' /
  // 'ambiguous') or a kebab-case playbook name. Sentinels
  // double-shadow as kebab-case, so we accept them via the
  // pattern check below.
  if (!ROUTING_SENTINELS.has(expectDispatch) && !KEBAB_RE.test(expectDispatch)) {
    throw new Error(
      `routing fixture ${sourcePath}: 'expect_dispatch' must be 'none', 'ambiguous', or a kebab-case playbook name (got '${expectDispatch}')`,
    );
  }
  const out: RoutingFixture = {
    name,
    prompt,
    expectDispatch,
    sourcePath,
  };
  if (r.ambiguous_acceptable !== undefined) {
    if (expectDispatch !== 'ambiguous') {
      throw new Error(
        `routing fixture ${sourcePath}: 'ambiguous_acceptable' is only valid when expect_dispatch is 'ambiguous'`,
      );
    }
    out.ambiguousAcceptable = requireStringArray(
      r.ambiguous_acceptable,
      `${sourcePath}: 'ambiguous_acceptable'`,
    );
    for (const v of out.ambiguousAcceptable) {
      if (!KEBAB_RE.test(v)) {
        throw new Error(
          `routing fixture ${sourcePath}: 'ambiguous_acceptable' entries must be kebab-case (got '${v}')`,
        );
      }
    }
  }
  return out;
};

// List every `*.yaml` file directly under `dir`. Sorted by name
// for deterministic ordering across runs (eval reports diff
// cleanly).
const listYamlFiles = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith('.yaml')) continue;
    const full = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push(full);
  }
  out.sort();
  return out;
};

const listSubdirs = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.startsWith('_')) continue; // _routing is loaded separately
    const full = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push(e);
  }
  out.sort();
  return out;
};

// Discover and parse every per-playbook fixture under `root`.
// Each playbook gets its own directory; all `.yaml` files inside
// (non-recursive) are loaded. Throws on the first malformed
// file with a source-aware message.
export const loadPlaybookFixtures = (root: string): PlaybookFixture[] => {
  const fixtures: PlaybookFixture[] = [];
  for (const dirName of listSubdirs(root)) {
    const dirPath = join(root, dirName);
    for (const filePath of listYamlFiles(dirPath)) {
      const content = readFileSync(filePath, 'utf-8');
      fixtures.push(parsePlaybookFixture(content, filePath, dirName));
    }
  }
  return fixtures;
};

// Discover and parse every routing fixture under `<root>/_routing/`.
// Empty directory yields an empty array; missing directory same.
export const loadRoutingFixtures = (root: string): RoutingFixture[] => {
  const dir = join(root, '_routing');
  const out: RoutingFixture[] = [];
  for (const filePath of listYamlFiles(dir)) {
    const content = readFileSync(filePath, 'utf-8');
    out.push(parseRoutingFixture(content, filePath));
  }
  return out;
};

// Compute the canonical routing metrics from a set of routing
// fixtures + the actual dispatch each got under test. Used by
// the runner (slice future) to report `wrong_dispatch_rate`,
// `false_dispatch_rate`, `missed_dispatch_rate`. Spec
// `PLAYBOOKS.md` §1.4 thresholds are NOT enforced here —
// computation only — so a runner that hits below threshold can
// surface the failure mode without conflating "we did not run"
// with "we ran and missed".
export interface RoutingObservation {
  fixture: RoutingFixture;
  // Actual dispatch as observed by the runner. The 'none'
  // sentinel here means "the principal answered without
  // invoking task_*". Any other string is the playbook name
  // that was dispatched.
  observed: string | 'none';
}

export interface RoutingMetrics {
  total: number;
  // Cases where expect_dispatch was a specific playbook AND
  // observed was a different playbook (NOT 'none').
  wrongDispatchCount: number;
  // Cases where expect_dispatch was 'none' AND observed was
  // some playbook (the principal over-routed).
  falseDispatchCount: number;
  // Cases where expect_dispatch was a specific playbook AND
  // observed was 'none' (the principal under-routed).
  missedDispatchCount: number;
  // Cases where expect_dispatch was 'ambiguous' AND observed
  // was a name not in `ambiguousAcceptable` (when present) —
  // also counts as wrong.
  ambiguousWrongCount: number;
  wrongDispatchRate: number;
  falseDispatchRate: number;
  missedDispatchRate: number;
}

export const computeRoutingMetrics = (
  observations: ReadonlyArray<RoutingObservation>,
): RoutingMetrics => {
  let wrong = 0;
  let falseDispatch = 0;
  let missed = 0;
  let ambiguousWrong = 0;
  for (const o of observations) {
    const expect = o.fixture.expectDispatch;
    if (expect === 'none') {
      if (o.observed !== 'none') falseDispatch += 1;
      continue;
    }
    if (expect === 'ambiguous') {
      // Ambiguous accepts any acceptable name (when declared)
      // OR any known playbook (when not). Wrong = a name OUTSIDE
      // the acceptable set when one was declared. 'none' is a
      // valid response under ambiguous (clarifying question).
      const acceptable = o.fixture.ambiguousAcceptable;
      if (acceptable !== undefined && o.observed !== 'none' && !acceptable.includes(o.observed)) {
        ambiguousWrong += 1;
      }
      continue;
    }
    // expect is a specific playbook name.
    if (o.observed === 'none') {
      missed += 1;
    } else if (o.observed !== expect) {
      wrong += 1;
    }
  }
  const total = observations.length;
  // Denominators avoid divide-by-zero. An empty observation set
  // yields 0 for every rate — operators reading the report see
  // "no data" via the total field.
  const safe = (n: number, d: number): number => (d === 0 ? 0 : n / d);
  return {
    total,
    wrongDispatchCount: wrong + ambiguousWrong,
    falseDispatchCount: falseDispatch,
    missedDispatchCount: missed,
    ambiguousWrongCount: ambiguousWrong,
    wrongDispatchRate: safe(wrong + ambiguousWrong, total),
    falseDispatchRate: safe(falseDispatch, total),
    missedDispatchRate: safe(missed, total),
  };
};
