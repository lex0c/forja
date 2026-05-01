import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

// Smoke test: exercise the full scanner pipeline against the
// Forja repo itself. Catches regressions that don't surface in
// micro-fixtures — extension parsing on real-world files,
// memory pressure on the actual file count, end-to-end pipeline
// correctness. Skip when not running inside a git checkout (no
// .git → smoke can't determine project root).

const forjaRoot = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();

describe('smoke: scan the Forja repo', () => {
  if (forjaRoot === null) {
    test.skip('git toplevel not available, skipping smoke', () => {});
    return;
  }

  test('scans the Forja repo with zero hard errors and recognizable symbols', async () => {
    const idx = await CodeIndex.init({
      projectRoot: forjaRoot,
      dbOverride: openMemoryDb(),
    });
    try {
      const result = await idx.scan({ projectRoot: forjaRoot, respectGitignore: true });
      // Hard errors (parse exceptions, read failures) MUST be
      // zero on a clean checkout. Partials are tolerated — TS
      // grammar quirks on edge files happen, the index just
      // flags them.
      expect(result.errors).toEqual([]);
      // Sanity bounds: at minimum, the scanner finds the source
      // dirs we know exist. Upper bound is loose to absorb
      // organic growth without flaking.
      expect(result.filesScanned).toBeGreaterThan(50);
      expect(result.symbolsInserted).toBeGreaterThan(100);

      // Spot-check known top-level symbols that should always
      // be present in the index. If these regress, something
      // structurally broke (export detection, query scope,
      // file walker).
      expect(idx.getSymbol('CodeIndex').length).toBeGreaterThan(0);
      expect(idx.getSymbol('walkProject').length).toBeGreaterThan(0);
      expect(idx.getSymbol('scanProject').length).toBeGreaterThan(0);
      expect(idx.getSymbol('runCodeIndexCli').length).toBeGreaterThan(0);

      // The CodeIndex class symbol should classify as 'class'
      // and be exported. Confirms visibility resolution + kind
      // classification together.
      const codeIndexSym = idx.getSymbol('CodeIndex').find((s) => s.kind === 'class');
      expect(codeIndexSym).toBeDefined();
      expect(codeIndexSym?.visibility).toBe('export');

      // References + resolver pipeline end-to-end. The codebase
      // has many calls to top-level helpers; pick a function we
      // know is heavily used and assert refs land. Bypasses the
      // unique-name check for resolver via findReferencesByName
      // first (string match), then via findReferences once we
      // pin the unique resolution worked for at least one
      // common name.
      expect(result.referencesInserted).toBeGreaterThan(50);
      expect(result.referencesResolved).toBeGreaterThan(0);
      // Imports resolution: pin that the explicit-extension
      // imports common in this repo (./auth.ts, ../foo.ts)
      // resolve correctly. Pre-fix the resolver would always
      // append an extension and miss every one of these,
      // leaving target_path null and dependents_of empty for
      // every Forja file. Smoke surfaces the regression.
      expect(result.importsResolved).toBeGreaterThan(0);
      // dependents_of works against a real, frequently-imported
      // file. types.ts is imported by most code-index modules;
      // a non-zero result confirms target_path got populated.
      const dependents = idx.dependentsOf('src/code-index/types.ts');
      expect(dependents.length).toBeGreaterThan(0);
      // `walkProject` is the one canonical symbol we expect to
      // be resolved — name is unique in the codebase. A regression
      // in the resolver pipeline would flip this to 0.
      const walkSym = idx.getSymbol('walkProject')[0];
      expect(walkSym).toBeDefined();
      const walkRefs = idx.findReferences(walkSym?.id ?? -1);
      expect(walkRefs.length).toBeGreaterThan(0);
    } finally {
      idx.close();
    }
  });
});
