import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Register a beforeEach/afterEach pair that points `FORJA_SWE_DEPS_DIR` at a pre-built (empty) deps
// store, so `materializeSweWorkspace`'s `ensureIsolatedDeps` SHORT-CIRCUITS (`existsSync(node_modules)`
// → return) instead of trying to build one.
//
// Why it's needed: a SYNTHETIC test repo has no package.json, so `ensureIsolatedDeps`'s
// `bun install --frozen-lockfile` finds nothing, creates NO node_modules, and the
// `!existsSync(nm)` guard THROWS ("could not build isolated deps"). Locally the tests pass only
// because a real swe run already warmed `~/.cache/forja-swe-deps`; CI has no warm store, so every
// synthetic test that materializes a workspace fails. The synthetic oracle imports only `bun:test`
// (a builtin), so an EMPTY store is all it needs — this fixture supplies exactly that.
export const installSweDepsFixture = (): void => {
  let saved: string | undefined;
  let store: string | undefined;
  beforeEach(() => {
    saved = process.env.FORJA_SWE_DEPS_DIR;
    store = mkdtempSync(join(tmpdir(), 'swe-deps-fixture-'));
    mkdirSync(join(store, 'node_modules'), { recursive: true });
    process.env.FORJA_SWE_DEPS_DIR = store;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FORJA_SWE_DEPS_DIR;
    else process.env.FORJA_SWE_DEPS_DIR = saved;
    if (store !== undefined) rmSync(store, { recursive: true, force: true });
  });
};
