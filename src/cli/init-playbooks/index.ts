// Bundled canonical playbooks (`PLAYBOOKS.md` §14). The 10 .md
// files in this directory are imported as text assets and exposed
// as a stable array. `agent init --playbooks` writes each entry
// into `<cwd>/.agent/agents/`, where the loader picks them up at
// the next REPL boot.
//
// Bun's `with { type: 'text' }` import attribute embeds the file
// content as a string at build time, so the compiled binary
// carries the assets without a runtime filesystem dependency. Tests
// and dev runs use the same path — there is no separate dev/prod
// loading code.
//
// Adding a new canonical playbook:
//   1. Drop the `.md` file in this directory.
//   2. Add the `import` + entry below.
//   3. The loader test (`tests/cli/init-playbooks.test.ts`) runs
//      `loadSubagentFromString` against every entry, so a malformed
//      frontmatter is caught before the asset ships.

import challengeAssumptionsMd from './challenge-assumptions.md' with { type: 'text' };
import codeReviewMd from './code-review.md' with { type: 'text' };
import debugMd from './debug.md' with { type: 'text' };
import explainMd from './explain.md' with { type: 'text' };
import gapAuditMd from './gap-audit.md' with { type: 'text' };
import gitHygieneMd from './git-hygiene.md' with { type: 'text' };
import perfInvestigateMd from './perf-investigate.md' with { type: 'text' };
import refactorMd from './refactor.md' with { type: 'text' };
import securityAuditMd from './security-audit.md' with { type: 'text' };
import threatModelMd from './threat-model.md' with { type: 'text' };

export interface CanonicalPlaybook {
  // Filename used at the destination (`<cwd>/.agent/agents/<filename>`).
  // Kept as `.md` so the loader's directory scan picks the file up
  // alongside any user-authored playbooks.
  filename: string;
  // Raw frontmatter + body. Ready to be written verbatim — the
  // loader normalizes the YAML at read time, so we do not parse
  // here. Keeping the source form lets `agent init --playbooks`
  // produce a byte-for-byte copy authors can edit later.
  content: string;
}

// Order is alphabetical by filename. The init handler iterates in
// order, so a stable ordering keeps the stdout report (and any
// regression test snapshot) predictable.
export const CANONICAL_PLAYBOOKS: ReadonlyArray<CanonicalPlaybook> = [
  { filename: 'challenge-assumptions.md', content: challengeAssumptionsMd },
  { filename: 'code-review.md', content: codeReviewMd },
  { filename: 'debug.md', content: debugMd },
  { filename: 'explain.md', content: explainMd },
  { filename: 'gap-audit.md', content: gapAuditMd },
  { filename: 'git-hygiene.md', content: gitHygieneMd },
  { filename: 'perf-investigate.md', content: perfInvestigateMd },
  { filename: 'refactor.md', content: refactorMd },
  { filename: 'security-audit.md', content: securityAuditMd },
  { filename: 'threat-model.md', content: threatModelMd },
];
