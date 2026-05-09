// Recap eval smoke runner. Loads each fixture from `evals/recap/`,
// seeds a fresh in-memory DB, runs `projectRecap` + every
// deterministic renderer, and compares against the golden files
// under `evals/recap/golden/`. Fidelity is PR-blocking
// (RECAP.md §11.3).
//
// Update goldens after an INTENTIONAL renderer / projection change:
//   UPDATE_GOLDENS=1 bun test tests/recap/eval.test.ts
// then review the resulting diff and commit alongside the source
// change. Never use the env var to mask unintended drift.

import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture as f01 } from '../../evals/recap/fixtures/01-read-only.ts';
import { fixture as f02 } from '../../evals/recap/fixtures/02-write-refactor.ts';
import { fixture as f03 } from '../../evals/recap/fixtures/03-with-decisions.ts';
import { fixture as f04 } from '../../evals/recap/fixtures/04-with-subagent.ts';
import { fixture as f05 } from '../../evals/recap/fixtures/05-incomplete-session.ts';
import type { RecapFixture } from '../../evals/recap/fixtures/types.ts';
import { renderChangelogDeterministic } from '../../src/recap/changelog/index.ts';
import { renderPrDeterministic } from '../../src/recap/pr/index.ts';
import { projectRecap } from '../../src/recap/projection.ts';
import { renderHuman, renderJson } from '../../src/recap/render.ts';
import { renderSlackDeterministic } from '../../src/recap/slack/index.ts';
import { renderTerseDeterministic } from '../../src/recap/terse/index.ts';
import type { RecapIntermediate } from '../../src/recap/types.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';

const FIXTURES: readonly RecapFixture[] = [f01, f02, f03, f04, f05];

const GOLDEN_DIR = join(import.meta.dir, '..', '..', 'evals', 'recap', 'golden');

const updateMode = process.env.UPDATE_GOLDENS === '1';

// Each renderer declares its file extension and a render function
// that takes an already-projected intermediate. Adding a new
// deterministic renderer is one entry here plus the 5 goldens.
interface RendererSpec {
  readonly name: string; // label shown in the test name
  readonly ext: string; // file extension under golden/
  readonly render: (intermediate: RecapIntermediate) => string;
}

const HOME_OVERRIDE = '/home/lex';

const RENDERERS: readonly RendererSpec[] = [
  { name: 'human', ext: 'human.md', render: (i) => renderHuman(i, { home: HOME_OVERRIDE }) },
  { name: 'json', ext: 'json', render: (i) => renderJson(i) },
  { name: 'pr', ext: 'pr.md', render: (i) => renderPrDeterministic(i, { home: HOME_OVERRIDE }) },
  {
    name: 'changelog',
    ext: 'changelog.md',
    render: (i) => renderChangelogDeterministic(i, { home: HOME_OVERRIDE }),
  },
  {
    name: 'slack',
    ext: 'slack.md',
    render: (i) => renderSlackDeterministic(i, { home: HOME_OVERRIDE }),
  },
  {
    name: 'terse',
    ext: 'terse.md',
    render: (i) => renderTerseDeterministic(i, { home: HOME_OVERRIDE }),
  },
];

const goldenPath = (name: string, ext: string): string => join(GOLDEN_DIR, `${name}.${ext}`);

const readGolden = async (path: string): Promise<string | null> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
};

const writeGolden = async (path: string, content: string): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
};

describe('recap eval smoke (PR-blocking)', () => {
  for (const fx of FIXTURES) {
    for (const renderer of RENDERERS) {
      test(`${fx.name} — ${renderer.name} render matches golden`, async () => {
        const db = openMemoryDb();
        migrate(db);
        const scope = fx.seed(db);
        const intermediate = projectRecap(db, { scope, now: fx.now });
        const rendered = renderer.render(intermediate);

        const path = goldenPath(fx.name, renderer.ext);
        if (updateMode) {
          await writeGolden(path, rendered);
          // In update mode the assertion is trivial; the side
          // effect is the file write. The CI guard below catches
          // a forgotten env var that landed in trunk.
          expect(await readGolden(path)).toBe(rendered);
          return;
        }
        const golden = await readGolden(path);
        if (golden === null) {
          throw new Error(
            `Missing golden for fixture '${fx.name}' (${renderer.name}). Run \`UPDATE_GOLDENS=1 bun test tests/recap/eval.test.ts\` to create it.`,
          );
        }
        expect(rendered).toBe(golden);
      });
    }
  }

  // Guard against committing UPDATE_GOLDENS=1 in CI accidentally:
  // CI runs without the env var, so this assertion only fires for
  // a developer who left it exported. Cheap insurance against a
  // dev-loop habit landing in trunk.
  test('UPDATE_GOLDENS env is not set in committed CI runs', () => {
    if (process.env.CI === 'true') {
      expect(process.env.UPDATE_GOLDENS).not.toBe('1');
    }
  });
});
