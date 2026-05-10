// Consistency metric (RECAP §7.4 — fourth eval dimension after
// fidelity, coverage, concision). The spec frames consistency as
// "mesmo input ⇒ output similar (não 5 renderings diferentes)" —
// for the deterministic surface this is the strongest possible
// claim: byte-identical, not "similar".
//
// This file pins that contract per fixture × per renderer. The
// eval runner already snapshots renderer output against goldens
// (catches regressions across edits); the consistency metric
// catches non-determinism INSIDE a single test run — a hidden
// `Date.now()` or `Math.random()` lurking in the projection or
// renderer would produce different bytes across the 5 invocations
// and fail this test.
//
// LLM consistency (provider returning similar but not identical
// outputs across runs) is a separate problem; the LLM-mode tests
// in `pr-llm.test.ts` etc. exercise it via mocked providers that
// return the same canned bytes. Real-provider consistency is a
// production concern, not a unit-test one.

import { describe, expect, test } from 'bun:test';
import { fixture as f01 } from '../../evals/recap/fixtures/01-read-only.ts';
import { fixture as f02 } from '../../evals/recap/fixtures/02-write-refactor.ts';
import { fixture as f03 } from '../../evals/recap/fixtures/03-with-decisions.ts';
import { fixture as f04 } from '../../evals/recap/fixtures/04-with-subagent.ts';
import { fixture as f05 } from '../../evals/recap/fixtures/05-incomplete-session.ts';
import { fixture as f06 } from '../../evals/recap/fixtures/06-cross-day-single.ts';
import { fixture as f07 } from '../../evals/recap/fixtures/07-cross-day-range.ts';
import type { RecapFixture } from '../../evals/recap/fixtures/types.ts';
import { renderChangelogDeterministic } from '../../src/recap/changelog/index.ts';
import { renderHumanDeterministic } from '../../src/recap/human/index.ts';
import { renderPrDeterministic } from '../../src/recap/pr/index.ts';
import { projectRecap } from '../../src/recap/projection.ts';
import { renderJson } from '../../src/recap/render.ts';
import { renderSlackDeterministic } from '../../src/recap/slack/index.ts';
import { renderTerseDeterministic } from '../../src/recap/terse/index.ts';
import type { RecapIntermediate } from '../../src/recap/types.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';

const FIXTURES: readonly RecapFixture[] = [f01, f02, f03, f04, f05, f06, f07];

const HOME_OVERRIDE = '/home/lex';
const ITERATIONS = 5;

const optionsFor = (intermediate: RecapIntermediate) => {
  const c = intermediate.completeness;
  if (!c.incomplete) return { home: HOME_OVERRIDE };
  return {
    home: HOME_OVERRIDE,
    incomplete: { reason: c.incompleteReason, sessionIds: c.incompleteSessions },
  };
};

interface RendererSpec {
  readonly name: string;
  readonly render: (intermediate: RecapIntermediate) => string;
}

const RENDERERS: readonly RendererSpec[] = [
  { name: 'human', render: (i) => renderHumanDeterministic(i, optionsFor(i)) },
  { name: 'json', render: (i) => renderJson(i) },
  { name: 'pr', render: (i) => renderPrDeterministic(i, optionsFor(i)) },
  { name: 'changelog', render: (i) => renderChangelogDeterministic(i, optionsFor(i)) },
  { name: 'slack', render: (i) => renderSlackDeterministic(i, optionsFor(i)) },
  { name: 'terse', render: (i) => renderTerseDeterministic(i, optionsFor(i)) },
];

describe('recap consistency metric (RECAP §7.4 — deterministic = byte-identical)', () => {
  for (const fx of FIXTURES) {
    for (const renderer of RENDERERS) {
      test(`${fx.name} × ${renderer.name}: ${ITERATIONS} runs all byte-identical`, () => {
        // Re-seed the DB AND re-project on every iteration so a
        // hidden mutation in the projection (an iterator that
        // exhausts a stream, a memoization cache that drifts) is
        // caught alongside a hidden mutation in the renderer. The
        // "5 runs" is the literal number from RECAP §7.4 — fewer
        // would miss flaky low-rate non-determinism, more is
        // diminishing returns at unit-test scope.
        const outputs: string[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          const db = openMemoryDb();
          migrate(db);
          const scope = fx.seed(db);
          const intermediate = projectRecap(db, { scope, now: fx.now });
          outputs.push(renderer.render(intermediate));
          db.close();
        }
        // All outputs must equal the first one. The first index is
        // the reference; downstream ones either match exactly or
        // surface as a divergence from index 0.
        const first = outputs[0];
        if (first === undefined) throw new Error('no outputs collected');
        for (let i = 1; i < outputs.length; i++) {
          expect(outputs[i]).toBe(first);
        }
      });
    }
  }
});
