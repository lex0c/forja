// `agent init` handler. Spec: AGENTIC_CLI.md §2.1 (init mode) +
// §2.1.1 (config.toml schema) + §8 (permission engine bootstrap
// path) + MEMORY.md §2.5 (gitignore ownership) + PLAYBOOKS.md §12
// (canonical playbooks distribution) + SKILLS.md §6 (seed skill
// catalog distribution).
//
// Scaffolds the five bootstrap artifacts under .agent/:
//
//   1. permissions.yaml   — strict default-deny baseline (mode tunable)
//   2. .gitignore         — runtime data exclusion (operator-owned post-creation)
//   3. config.toml        — schema documentation (every key commented)
//   4. agents/*.md        — 11 canonical playbooks
//   5. skills/shared/*.md — 20 canonical skills
//
// Each step is idempotent — skips files that already exist so a
// re-run after partial failure is safe and an operator's hand edits
// survive. `--only` restricts to a subset; `--force` (or
// `--force=<csv>`) overwrites the force-eligible subset (everything
// except `.gitignore`, which is operator-owned per MEMORY.md §2.5).
//
// Pure filesystem work — no DB, no provider, no permission engine.
// We're WRITING files the engine would later read, so loading the
// engine here would be a chicken-and-egg dependency.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../config/loaders.ts';
import { DEFAULT_BUDGET } from '../harness/types.ts';
import { ensureAgentGitignore } from '../memory/gitignore.ts';
import { resolveScopeRoots as resolveMemoryScopeRoots } from '../memory/paths.ts';
import { installVendorSeeds } from '../memory/seeds-installer.ts';
import { projectPolicyPath } from '../permissions/index.ts';
import { DEFAULT_MODEL } from '../providers/default-model.ts';
import { projectScopeRoots } from '../skills/index.ts';
import { projectAgentsDir } from '../subagents/paths.ts';
import { renderInitConfigTemplate } from './init-config-template.ts';
import { CANONICAL_PLAYBOOKS, type CanonicalPlaybook } from './init-playbooks/index.ts';
import type { CanonicalSeed } from './init-seeds/index.ts';
import { CANONICAL_SKILLS, type CanonicalSkill } from './init-skills/index.ts';
import { type InitMode, renderInitTemplate } from './init-template.ts';

// Discrete steps in the scaffold. Order in DEFAULT_STEPS reflects
// the order they run when no `--only` is passed: permissions first
// (load-bearing — without it everything denies), gitignore next
// (so subsequent writes don't pollute the operator's git status),
// config third (depends only on .agent/ existing), then the
// playbooks + skills catalogs (largest payloads, longest to walk),
// finally `seeds` which lands in the operator's USER scope
// (`<user>/seeds/` per MEMORY.md §5.7.4) — last so the install
// report's stdout order moves from project-local to user-global,
// matching the operator's mental "outside-in" model.
export type InitStep = 'permissions' | 'gitignore' | 'config' | 'playbooks' | 'skills' | 'seeds';

export const DEFAULT_STEPS: ReadonlyArray<InitStep> = [
  'permissions',
  'gitignore',
  'config',
  'playbooks',
  'skills',
  'seeds',
];

// `gitignore` is excluded — it is operator-owned after creation per
// MEMORY.md §2.5. Forcing a re-write would defeat the spec promise
// and surprise an operator who edited the file. `seeds` is also
// excluded: seeds have their own upgrade lifecycle (spec §5.7.5)
// that decides per-body whether to rewrite (vendor_updated) or
// preserve (user_kept) — a blanket `--force=seeds` would override
// the conservative-default policy and silently wipe operator edits,
// the opposite of what the spec promises.
export type ForceEligibleStep = Exclude<InitStep, 'gitignore' | 'seeds'>;

export interface InitOptions {
  cwd: string;
  mode: InitMode;
  // Subset of steps to run. Defaults to DEFAULT_STEPS (all five).
  only?: ReadonlyArray<InitStep>;
  // `'all'` overwrites every force-eligible step (permissions,
  // config, playbooks, skills). An array overwrites only the listed
  // steps. `undefined` means "no overwrites" — every step is
  // skip-if-exists. `.gitignore` is never force-eligible.
  force?: 'all' | ReadonlyArray<ForceEligibleStep>;
  // Test seam — defaults to the bundled CANONICAL_PLAYBOOKS. Tests
  // pass a fixture array to exercise the copy/skip/force matrix
  // without depending on the full canonical set.
  playbookSource?: ReadonlyArray<CanonicalPlaybook>;
  // Test seam for the skills step — same role as `playbookSource`.
  skillSource?: ReadonlyArray<CanonicalSkill>;
  // Test seam for the seeds step. Production omits → bundled
  // CANONICAL_SEEDS; tests can pin a fixture so a future catalog
  // bump doesn't break the regression set.
  seedSource?: ReadonlyArray<CanonicalSeed>;
  // Sink for the success / error messages. Production wires to
  // stdout/stderr; tests inject collectors.
  out: (s: string) => void;
  err: (s: string) => void;
}

interface StepResult {
  wrote: number;
  skipped: number;
  overwritten: number;
  // Optional fifth bucket: the seeds step's upgrade lifecycle
  // (spec §5.7.5) can ARCHIVE a body that the new vendor catalog
  // dropped (moved to `<user>/seeds/archived/<name>.<ts>.md`).
  // Distinct from `overwritten` because the body isn't replaced —
  // it's preserved at a new location. Aggregate summary surfaces
  // it as `... K archived` when non-zero; other scaffolds always
  // omit the field and the summary skips the suffix.
  archived?: number;
  // Optional sixth bucket: the seeds step honors per-seed opt-out
  // sentinels (spec §5.7.6 — `<user>/seeds/.disabled.json` populated
  // via `/memory seeds disable <name>`). Distinct from `skipped`
  // (which lumps `unchanged` and `userKept` together, both
  // technical-pipeline outcomes) because `disabled` is operator-
  // intent and warrants its own summary suffix so an operator running
  // `agent init` sees "5 disabled" instead of "5 skipped" hiding the
  // opt-out behind the same number that would mean "no work to do".
  disabled?: number;
}

// Atomic write helper. Writes `content` to a temp file alongside
// `target`, then renames into place. The rename is a single
// filesystem syscall and is atomic on POSIX/NTFS for same-volume
// renames — so a process killed mid-write can leave behind a
// `<target>.tmp-<pid>-<ts>` orphan but NEVER a partially-written
// target file. Without this, a fresh `permissions.yaml` truncated
// at byte 500 would refuse parse on next boot (engine goes refusing,
// operator has no way to know which file is corrupt).
//
// Permission-bit preservation: if `target` already exists, we
// capture its mode via `statSync` BEFORE writing and `chmodSync`
// the temp to match BEFORE the rename. Operators who
// `chmod 600 .agent/config.toml` for a security-tightened repo
// keep that mode after `init --force=config`. Without this,
// rename adopts the temp's default mode (typically 0644 modulated
// by umask) and silently relaxes the restriction.
//
// Best-effort orphan cleanup on write failure: if writeFileSync /
// chmodSync / renameSync throws, we unlinkSync the temp before
// re-raising. Failure to unlink (EACCES, race with another
// process) is swallowed — the operator's broader EACCES surface is
// the original failure; a secondary unlink error would just
// confuse the diagnostic.
//
// Not durable across system crashes: data may remain in OS page
// cache after rename; a power loss between rename and the next
// kernel flush can lose the write. `fsyncSync` would close that
// window but is overkill for config files (we accept the trade-off
// per `AGENTIC_CLI.md` §13 — config files are not transactional
// state). Production state that needs crash-durability lives in
// SQLite, where `bun:sqlite` honors WAL durability semantics.
//
// Symlink note: if `target` is a symlink, `renameSync` replaces the
// SYMLINK with the regular file. The link breaks. Operator who
// linked `.agent/permissions.yaml → ~/shared-policy.yaml` and
// runs `init --force=permissions` ends up with a regular file at
// the .agent path, no longer following the shared policy.
//
// Mirrors the temp+rename idiom from `cli/slash/commands/memory.ts`
// (`mutateMemoryConfig`) and `memory/writer.ts`. TODO: extract to
// `src/storage/atomic-write.ts` when a fourth consumer surfaces —
// today's two impls have slight semantic differences (this one
// preserves mode + cleans up on failure; memory's keeps it
// minimal) and consolidating prematurely risks regressing one of
// the divergent behaviors.
const atomicWrite = (target: string, content: string): void => {
  // Capture existing mode (if any) so the rename below doesn't
  // silently relax permissions an operator deliberately tightened.
  let preservedMode: number | undefined;
  try {
    preservedMode = statSync(target).mode & 0o777;
  } catch {
    // Target doesn't exist (first-write case) — write inherits the
    // platform default mode modulated by umask. Nothing to preserve.
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8' });
    if (preservedMode !== undefined) {
      chmodSync(tmp, preservedMode);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore; the original write error is what matters
    }
    throw err;
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
};

const forcedFor = (force: InitOptions['force'], step: ForceEligibleStep): boolean => {
  if (force === 'all') return true;
  if (Array.isArray(force)) return force.includes(step);
  return false;
};

const scaffoldPermissions = (options: InitOptions, force: boolean): StepResult | null => {
  const { cwd, mode, out, err } = options;
  const target = projectPolicyPath(cwd);
  const exists = existsSync(target);
  if (exists && !force) {
    out(
      `forja: skip ${target} (already exists; use --force or --force=permissions to overwrite)\n`,
    );
    return { wrote: 0, skipped: 1, overwritten: 0 };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, renderInitTemplate(mode));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to write ${target}: ${msg}\n`);
    return null;
  }
  if (exists) {
    out(`forja: overwrote ${target}\n`);
    return { wrote: 0, skipped: 0, overwritten: 1 };
  }
  out(`forja: wrote ${target}\n`);
  return { wrote: 1, skipped: 0, overwritten: 0 };
};

const scaffoldGitignore = (options: InitOptions): StepResult | null => {
  const { cwd, out, err } = options;
  try {
    const result = ensureAgentGitignore(cwd);
    if (result.created) {
      out(`forja: wrote ${result.path}\n`);
      return { wrote: 1, skipped: 0, overwritten: 0 };
    }
    out(`forja: skip ${result.path} (operator-owned after creation)\n`);
    return { wrote: 0, skipped: 1, overwritten: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to write .agent/.gitignore: ${msg}\n`);
    return null;
  }
};

const scaffoldConfig = (options: InitOptions, force: boolean): StepResult | null => {
  const { cwd, out, err } = options;
  const target = join(cwd, '.agent', 'config.toml');
  const exists = existsSync(target);
  if (exists && !force) {
    out(`forja: skip ${target} (already exists; use --force or --force=config to overwrite)\n`);
    return { wrote: 0, skipped: 1, overwritten: 0 };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    // Scaffold sources all three section values from the canonical
    // code defaults so a re-run with `--force=config` (or a fresh
    // init after a bump) re-syncs to the current values.
    atomicWrite(
      target,
      renderInitConfigTemplate({
        model: DEFAULT_MODEL,
        budget: DEFAULT_BUDGET,
        memory: DEFAULT_MEMORY_CONFIG,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to write ${target}: ${msg}\n`);
    return null;
  }
  if (exists) {
    out(`forja: overwrote ${target}\n`);
    return { wrote: 0, skipped: 0, overwritten: 1 };
  }
  out(`forja: wrote ${target}\n`);
  return { wrote: 1, skipped: 0, overwritten: 0 };
};

// Shared copy/skip/force loop for the directory-of-`.md`-assets
// steps (playbooks, skills). Each entry is written verbatim into
// `targetDir`; an existing file is skipped unless `force`.
// `forceLabel` is the step name used in the skip hint
// (`--force=<label>`).
const scaffoldAssetDir = (
  options: InitOptions,
  force: boolean,
  asset: {
    targetDir: string;
    source: ReadonlyArray<{ filename: string; content: string }>;
    forceLabel: string;
  },
): StepResult | null => {
  const { out, err } = options;
  try {
    mkdirSync(asset.targetDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to create ${asset.targetDir}: ${msg}\n`);
    return null;
  }
  let wrote = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const file of asset.source) {
    const target = join(asset.targetDir, file.filename);
    const exists = existsSync(target);
    if (exists && !force) {
      skipped++;
      out(
        `forja: skip ${target} (already exists; use --force or --force=${asset.forceLabel} to overwrite)\n`,
      );
      continue;
    }
    try {
      atomicWrite(target, file.content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`forja: failed to write ${target}: ${msg}\n`);
      return null;
    }
    if (exists) {
      overwritten++;
      out(`forja: overwrote ${target}\n`);
    } else {
      wrote++;
      out(`forja: wrote ${target}\n`);
    }
  }
  return { wrote, skipped, overwritten };
};

const scaffoldPlaybooks = (options: InitOptions, force: boolean): StepResult | null =>
  scaffoldAssetDir(options, force, {
    targetDir: projectAgentsDir(options.cwd),
    source: options.playbookSource ?? CANONICAL_PLAYBOOKS,
    forceLabel: 'playbooks',
  });

// Skills land in the project_shared scope (`.agent/skills/shared/`);
// the catalog scan picks them up at the next REPL boot.
const scaffoldSkills = (options: InitOptions, force: boolean): StepResult | null =>
  scaffoldAssetDir(options, force, {
    targetDir: projectScopeRoots(options.cwd).shared,
    source: options.skillSource ?? CANONICAL_SKILLS,
    forceLabel: 'skills',
  });

// Vendor seed catalog (spec MEMORY.md §5.7.4 + §5.7.8). Unlike
// playbooks / skills (which land at `<cwd>/.agent/...` per-project),
// seeds install into the user-global scope at `<user>/seeds/` —
// they are agent meta-behavior, not project content. Wiring through
// `installVendorSeeds` reuses the slice-4 upgrade state machine
// (fresh / unchanged / vendor_updated / user_kept / archived) so
// running `agent init seeds` on a host that already has the catalog
// silently no-ops the bodies the operator hasn't touched and
// preserves the ones they have.
//
// Result-shape mapping into the init scaffold's StepResult:
//   - wrote       = fresh         (bodies created for the first time)
//   - overwritten = vendorUpdated (silent rewrite on a vendor bump)
//   - skipped     = unchanged + userKept
// `archived` (seeds dropped from the new catalog) gets its own log
// line because it doesn't fit the wrote/skipped/overwritten triple.
const scaffoldSeeds = (options: InitOptions): StepResult | null => {
  const { out, err } = options;
  const memoryRoots = resolveMemoryScopeRoots(options.cwd);
  let result: ReturnType<typeof installVendorSeeds>;
  try {
    result = installVendorSeeds({
      roots: memoryRoots,
      ...(options.seedSource !== undefined ? { source: options.seedSource } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to install vendor seeds: ${msg}\n`);
    // Seeds is the last DEFAULT_STEPS step (init.ts:63-70), so a
    // failure here means the five project-scope steps ALREADY wrote
    // files under <cwd>/.agent/. Operator can fix the user-scope
    // issue (permissions, disk space, XDG path) and resume without
    // re-doing the project work via `agent init --only=seeds`.
    err(
      'forja: project artifacts already scaffolded; re-run with `agent init --only=seeds` after fixing the user-scope issue\n',
    );
    return null;
  }
  for (const filename of result.fresh) {
    out(`forja: wrote ${memoryRoots.user}/seeds/${filename}\n`);
  }
  for (const filename of result.vendorUpdated) {
    out(`forja: upgraded ${memoryRoots.user}/seeds/${filename}\n`);
  }
  for (const filename of result.userKept) {
    // Recovery path names the manual workaround. The phantom
    // `/memory seeds revert` slash command was wishful UX — it's
    // deferred to slice 5+ alongside the [k/v/a/m] interactive
    // modal. Pointing operators at a command that doesn't exist
    // would silently fail at the REPL.
    out(
      `forja: skip ${memoryRoots.user}/seeds/${filename} (operator-edited; delete the body and re-run \`agent init --only=seeds\` to restore vendor content)\n`,
    );
  }
  for (const filename of result.archived) {
    out(`forja: archived ${memoryRoots.user}/seeds/archived/${filename}\n`);
  }
  for (const filename of result.disabled) {
    // Disabled seeds are operator-intent opt-outs. Naming the file
    // and pointing at the slash command that toggles state keeps the
    // log self-explanatory — an operator reading the init output a
    // month later (or in CI logs) doesn't have to remember why a
    // seed was skipped without an "edited" hint.
    const seedName = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
    out(
      `forja: skip ${memoryRoots.user}/seeds/${filename} (disabled by /memory seeds disable; re-enable with \`/memory seeds enable ${seedName}\`)\n`,
    );
  }
  return {
    wrote: result.fresh.length,
    overwritten: result.vendorUpdated.length,
    skipped: result.unchanged.length + result.userKept.length,
    archived: result.archived.length,
    disabled: result.disabled.length,
  };
};

export const runInit = (options: InitOptions): number => {
  const steps = options.only ?? DEFAULT_STEPS;
  const totals: StepResult = { wrote: 0, skipped: 0, overwritten: 0 };
  for (const step of steps) {
    let result: StepResult | null;
    if (step === 'permissions') {
      result = scaffoldPermissions(options, forcedFor(options.force, 'permissions'));
    } else if (step === 'gitignore') {
      result = scaffoldGitignore(options);
    } else if (step === 'config') {
      result = scaffoldConfig(options, forcedFor(options.force, 'config'));
    } else if (step === 'playbooks') {
      result = scaffoldPlaybooks(options, forcedFor(options.force, 'playbooks'));
    } else if (step === 'skills') {
      result = scaffoldSkills(options, forcedFor(options.force, 'skills'));
    } else {
      // 'seeds' — no `force` flag (excluded from ForceEligibleStep).
      // The installer's upgrade state machine owns the rewrite policy.
      result = scaffoldSeeds(options);
    }
    if (result === null) {
      // Exit early with the per-step output already printed.
      // No rollback — surviving writes can be re-encountered safely
      // on the next run (skip-if-exists for each step).
      return 1;
    }
    totals.wrote += result.wrote;
    totals.skipped += result.skipped;
    totals.overwritten += result.overwritten;
    if (result.archived !== undefined) {
      totals.archived = (totals.archived ?? 0) + result.archived;
    }
    if (result.disabled !== undefined) {
      totals.disabled = (totals.disabled ?? 0) + result.disabled;
    }
  }
  const stepWord = steps.length === 1 ? 'step' : 'steps';
  // The archived / disabled suffixes only appear when the seeds step
  // actually triggered the corresponding action this run. Operators
  // who never trip those paths see the same 3-counter summary as
  // before. Order: archived before disabled (alphabetical), which
  // also matches the order they appear in the installer's state
  // machine for consistency.
  const archivedSuffix =
    totals.archived !== undefined && totals.archived > 0 ? `, ${totals.archived} archived` : '';
  const disabledSuffix =
    totals.disabled !== undefined && totals.disabled > 0 ? `, ${totals.disabled} disabled` : '';
  options.out(
    `forja: ${totals.wrote} wrote, ${totals.overwritten} overwritten, ${totals.skipped} skipped${archivedSuffix}${disabledSuffix} (${steps.length} ${stepWord})\n`,
  );
  if (totals.wrote + totals.overwritten > 0) {
    options.out("forja: review .agent/ and run 'agent' to start.\n");
  }
  return 0;
};
