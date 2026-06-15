// Bundled canonical skills (`SKILLS.md` §6 — seed catalog). The 9
// .md files in this directory are imported as text assets and
// exposed as a stable array. The skills step of `agent init` writes
// each entry into `<cwd>/.agent/skills/shared/`, where the catalog
// scan picks them up at the next REPL boot.
//
// Bun's `with { type: 'text' }` import attribute embeds the file
// content as a string at build time, so the compiled binary carries
// the assets without a runtime filesystem dependency. The ambient
// `*.md` declaration in `../init-playbooks/playbooks.d.ts` already
// covers these imports project-wide — no separate declaration here.
//
// Adding a new canonical skill:
//   1. Drop the `.md` file in this directory.
//   2. Add the `import` + entry below.
//   3. The loader test (`tests/cli/init-skills.test.ts`) runs
//      `parseSkillFile` against every entry, so a malformed
//      frontmatter is caught before the asset ships.

import addRegressionTestMd from './add-regression-test.md' with { type: 'text' };
import bulkEditFilesMd from './bulk-edit-files.md' with { type: 'text' };
import gitBisectRegressionMd from './git-bisect-regression.md' with { type: 'text' };
import gitRecoverLostWorkMd from './git-recover-lost-work.md' with { type: 'text' };
import gitResolveConflictMd from './git-resolve-conflict.md' with { type: 'text' };
import reviewDiffMd from './review-diff.md' with { type: 'text' };
import safeBulkDeleteMd from './safe-bulk-delete.md' with { type: 'text' };
import threatModelComponentMd from './threat-model-component.md' with { type: 'text' };
import triageFlakyTestMd from './triage-flaky-test.md' with { type: 'text' };

export interface CanonicalSkill {
  // Filename at the destination
  // (`<cwd>/.agent/skills/shared/<filename>`). Kept as `.md` so the
  // catalog's directory scan picks the file up alongside any
  // operator-authored skills.
  filename: string;
  // Raw frontmatter + body, written verbatim — the catalog parses
  // and validates at scan time, so we keep the source form and let
  // an operator edit it later.
  content: string;
}

// Order is alphabetical by filename — the init handler iterates in
// order, so a stable sequence keeps the stdout report (and the
// regression-test snapshot) predictable.
export const CANONICAL_SKILLS: ReadonlyArray<CanonicalSkill> = [
  { filename: 'add-regression-test.md', content: addRegressionTestMd },
  { filename: 'bulk-edit-files.md', content: bulkEditFilesMd },
  { filename: 'git-bisect-regression.md', content: gitBisectRegressionMd },
  { filename: 'git-recover-lost-work.md', content: gitRecoverLostWorkMd },
  { filename: 'git-resolve-conflict.md', content: gitResolveConflictMd },
  { filename: 'review-diff.md', content: reviewDiffMd },
  { filename: 'safe-bulk-delete.md', content: safeBulkDeleteMd },
  { filename: 'threat-model-component.md', content: threatModelComponentMd },
  { filename: 'triage-flaky-test.md', content: triageFlakyTestMd },
];
