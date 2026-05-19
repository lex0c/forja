// Regression test for the compile-safe built-in distribution fix.
//
// Under `bun build --compile`, `import.meta.dir` becomes a virtual
// `/$bunfs/...` path that `readdirSync` cannot enumerate, so the
// loader returns ZERO built-ins. `src/subagents/builtin/index.ts`
// exports `EMBEDDED_BUILTINS` (Bun text imports inlined at compile
// time) and the loader falls back to them when the default path
// returns empty.
//
// This file pins two invariants:
//   (1) The embedded list matches the on-disk `.md` files exactly.
//       Without this, a new built-in works in `bun run dev` but is
//       silently missing from compiled binaries.
//   (2) Every embedded entry parses via `loadSubagentFromString` and
//       produces a valid `SubagentDefinition` — catches a future
//       change to a `.md` file that breaks the embed/load round-trip
//       before it ships.
//
// The compile-mode fallback behavior itself is exercised indirectly
// via `loadSubagents(default)` in dev (filesystem returns the same
// set as embedded, so no behavior diverges). A full integration
// smoke would need `bun build --compile` + run, which lives outside
// the deterministic test tier.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_BUILTINS } from '../../src/subagents/builtin/index.ts';
import { loadSubagentFromString } from '../../src/subagents/load.ts';
import { BUILTIN_AGENTS_DIR } from '../../src/subagents/paths.ts';

describe('EMBEDDED_BUILTINS — compile-safe distribution fallback', () => {
  test('embedded set covers every .md under src/subagents/builtin/', () => {
    const onDisk = readdirSync(BUILTIN_AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    const embedded = EMBEDDED_BUILTINS.map((b) => b.filename).sort();
    // If this assertion ever fails, a new built-in was added under
    // src/subagents/builtin/ without an entry in EMBEDDED_BUILTINS
    // (or vice versa). The fix is to update index.ts to import +
    // export the missing entry — without it, compiled binaries
    // silently lose the new built-in.
    expect(embedded).toEqual(onDisk);
  });

  test('every embedded raw parses into a valid SubagentDefinition', () => {
    for (const { filename, raw } of EMBEDDED_BUILTINS) {
      const def = loadSubagentFromString(raw, 'builtin', `<embedded>/${filename}`);
      // Name derives from frontmatter; should match the filename
      // stem so loader keys and operator-visible names stay in
      // sync (the dev-path loader assumes this; the embedded path
      // must match).
      const stem = filename.replace(/\.md$/, '');
      expect(def.name).toBe(stem);
      expect(def.scope).toBe('builtin');
      expect(def.sourcePath).toBe(`<embedded>/${filename}`);
      expect(def.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  test('embedded body content matches the .md file on disk (byte-for-byte)', () => {
    // Drift between the text-import bytes and the on-disk bytes
    // would mean the dev-mode loader and the compile-mode loader
    // produce different definitions for the same name — a silent
    // surface divergence. Pin equality.
    const fs = require('node:fs') as typeof import('node:fs');
    for (const { filename, raw } of EMBEDDED_BUILTINS) {
      const onDisk = fs.readFileSync(join(BUILTIN_AGENTS_DIR, filename), 'utf-8');
      expect(raw).toBe(onDisk);
    }
  });
});
