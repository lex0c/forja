// Conformance test driver. Discovers every *.yaml under
// tests/conformance/cases/ and runs each case through the
// engine, asserting decision shape per §16. Failed cases
// surface the case name + the reasons array so the operator
// sees exactly which assertion broke.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { loadCasesFromYaml, runCase } from './index.ts';

const CASES_DIR = join(import.meta.dir, 'cases');

const allCaseFiles = (): string[] => {
  const entries = readdirSync(CASES_DIR);
  return entries.filter((e) => e.endsWith('.yaml')).map((e) => join(CASES_DIR, e));
};

const allCases = () =>
  allCaseFiles().flatMap((path) => {
    const content = readFileSync(path, 'utf-8');
    return loadCasesFromYaml(content).map((c) => ({ ...c, _file: path }));
  });

describe('conformance suite', () => {
  // Bash cases need the tree-sitter-bash grammar loaded. Init runs
  // once for the whole suite (idempotent + cached).
  beforeAll(async () => {
    await initBashParser();
  });

  const cases = allCases();

  test(`discovers at least one case file under ${CASES_DIR}`, () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(`[${c._file.split('/').pop()}] ${c.name}`, () => {
      const result = runCase(c);
      if (!result.ok) {
        const detail = result.reasons.join('\n  - ');
        throw new Error(`conformance case '${c.name}' failed:\n  - ${detail}`);
      }
      expect(result.ok).toBe(true);
    });
  }
});
