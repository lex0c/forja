import type { RecapScopeOption } from '../../../src/recap/projection.ts';
import type { DB } from '../../../src/storage/db.ts';

// One fixture per file. The runner imports the fixture, opens a
// fresh memory DB, runs `seedFixture`, then projects + renders
// against the scope returned. Pinned-id / pinned-timestamp seeds
// keep the golden output reproducible regardless of host clock or
// UUID RNG.
export interface RecapFixture {
  // Display name for the test runner; matches the file name minus
  // the extension.
  name: string;
  // One-line scenario summary. Copied into the README table.
  description: string;
  // Mutates the DB with the fixture's synthetic state. Must use
  // explicit `id` and `createdAt` on every insert so the projection
  // output is byte-identical across runs.
  seed: (db: DB) => RecapScopeOption;
  // Pinned epoch ms passed into `projectRecap` as `now`. Drives the
  // `generatedAt` field and the `endedAt ?? now` fallback for
  // sessions that were left running.
  now: number;
}

// Pin pattern for UUIDs across fixtures. Each fixture uses its own
// 2-char prefix so cross-fixture id reuse is caught immediately if
// a typo lands. The unique segment lives in the FIRST 8 chars of
// the UUID so the renderer's `shortStep` (first 7 chars) surfaces
// something meaningful (`f1read01` reads better than `0000000` in
// the golden output).
export const padId = (prefix: string, n: number): string => {
  // 36-char UUID shape: 8-4-4-4-12. Build the head (8 chars) from
  // prefix + zero-padded ord; the rest stays fixed zeros so the
  // pattern is immediately recognizable as synthetic.
  const head = `${prefix}${String(n).padStart(8 - prefix.length, '0')}`;
  return `${head}-0000-0000-0000-000000000000`;
};
