// Bundled canonical vendor seeds (MEMORY.md §5.7.8 — vendor seed
// catalog). The 10 .md files in this directory are imported as text
// assets at build time and exposed as a stable array; the bootstrap
// installer (`src/memory/seeds-installer.ts`) writes them into the
// user scope's `<user>/seeds/` subdirectory on first invocation.
//
// Bun's `with { type: 'text' }` import attribute embeds the file
// content as a string at build time, so the compiled binary carries
// the assets without a runtime filesystem dependency. The ambient
// `*.md` declaration in `../init-playbooks/playbooks.d.ts` already
// covers these imports project-wide — no separate declaration here.
//
// Hard cap (spec §5.7.7): MAX 10 entries in the default vendor pack.
// If a future seed would push the count to 11, that's the moment to
// move it into a skill or playbook instead — the seed surface costs
// context in every session and should not bloat.
//
// Adding a new canonical seed (within the §5.7.7 cap):
//   1. Drop the `.md` file in this directory with the canonical
//      seed frontmatter (source=seed, seed_origin=vendor,
//      seed_version="1.0"|...).
//   2. Add the `import` + entry below in alphabetical-by-filename
//      order (same convention as init-skills/init-playbooks).
//   3. The catalog test (`tests/cli/init-seeds.test.ts`) runs
//      `parseMemoryFile` against every entry, so a malformed
//      frontmatter or oversized body is caught before the asset
//      ships.

import confirmBlastRadiusMd from './confirm-blast-radius.md' with { type: 'text' };
import failureRootCauseMd from './failure-root-cause.md' with { type: 'text' };
import gitFirstOrientationMd from './git-first-orientation.md' with { type: 'text' };
import noAutoCommitMd from './no-auto-commit.md' with { type: 'text' };
import noFabricationMd from './no-fabrication.md' with { type: 'text' };
import preferSpecializedNavigationMd from './prefer-specialized-navigation.md' with {
  type: 'text',
};
import respectRepoConventionsMd from './respect-repo-conventions.md' with { type: 'text' };
import safeEditDisciplineMd from './safe-edit-discipline.md' with { type: 'text' };
import scopeDisciplineMd from './scope-discipline.md' with { type: 'text' };
import secretHandlingMd from './secret-handling.md' with { type: 'text' };

export interface CanonicalSeed {
  // Filename at the destination
  // (`<user>/seeds/<filename>`). Kept as `.md` so the seeds-subdir
  // loader (slice 2's `listSeedOrphanFiles` + `readSeedByName`)
  // picks the file up alongside any operator-edited seed.
  filename: string;
  // The frontmatter `name` of this seed. The installer uses this to
  // populate the seeds/MEMORY.md index without re-parsing each body.
  name: string;
  // One-line description from the frontmatter; mirrored into the
  // seeds/MEMORY.md index entry's hook.
  description: string;
  // The frontmatter `seed_version`. Mirrored into the install
  // manifest so the upgrade lifecycle (slice 4) can detect a
  // vendor bump without re-parsing each body on every boot. Kept
  // in sync with the .md frontmatter via the catalog test.
  version: string;
  // Raw frontmatter + body, written verbatim — the seed-aware parser
  // validates at install/read time, so we keep the source form and
  // let an operator edit it later.
  content: string;
}

// Order is alphabetical by filename — the installer iterates in
// order, so a stable sequence keeps the install report (and the
// regression-test snapshot) predictable.
export const CANONICAL_SEEDS: ReadonlyArray<CanonicalSeed> = [
  {
    filename: 'confirm-blast-radius.md',
    name: 'confirm-blast-radius',
    description: 'ações irreversíveis ou de raio amplo exigem mapeamento de impacto + confirmação',
    version: '1.0',
    content: confirmBlastRadiusMd,
  },
  {
    filename: 'failure-root-cause.md',
    name: 'failure-root-cause',
    description: 'erro/teste falhando exige causa raiz; nunca bypass silencioso',
    version: '1.0',
    content: failureRootCauseMd,
  },
  {
    filename: 'git-first-orientation.md',
    name: 'git-first-orientation',
    description: 'sessão fresca em repo git começa por git status + git log -10',
    version: '1.0',
    content: gitFirstOrientationMd,
  },
  {
    filename: 'no-auto-commit.md',
    name: 'no-auto-commit',
    description: 'nunca criar commit sem pedido explícito do user',
    version: '1.0',
    content: noAutoCommitMd,
  },
  {
    filename: 'no-fabrication.md',
    name: 'no-fabrication',
    description:
      'não inventar fato/URL/path/símbolo; verificar antes de afirmar; declarar incerteza em limite semântico',
    version: '1.0',
    content: noFabricationMd,
  },
  {
    filename: 'prefer-specialized-navigation.md',
    name: 'prefer-specialized-navigation',
    description: 'tool dedicada > Bash; grep + read targeted > read inteiro em arquivo grande',
    version: '1.0',
    content: preferSpecializedNavigationMd,
  },
  {
    filename: 'respect-repo-conventions.md',
    name: 'respect-repo-conventions',
    description: 'convenções vêm do repo (git log, configs), nunca de defaults genéricos',
    version: '1.0',
    content: respectRepoConventionsMd,
  },
  {
    filename: 'safe-edit-discipline.md',
    name: 'safe-edit-discipline',
    description: 'ler antes de Edit; Edit em existente, Write so para novo ou rewrite completo',
    version: '1.0',
    content: safeEditDisciplineMd,
  },
  {
    filename: 'scope-discipline.md',
    name: 'scope-discipline',
    description:
      'ficar no escopo pedido; bugfix ≠ cleanup; sem abstração antes da terceira repetição',
    version: '1.0',
    content: scopeDisciplineMd,
  },
  {
    filename: 'secret-handling.md',
    name: 'secret-handling',
    description: 'nunca commitar/salvar credenciais; redact em output',
    version: '1.0',
    content: secretHandlingMd,
  },
];
