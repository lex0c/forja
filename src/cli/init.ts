// `agent init` handler. Spec: AGENTIC_CLI.md §2.1 (init mode) +
// §2.1.1 (config.toml schema) + §8 (permission engine bootstrap
// path) + MEMORY.md §2.5 (gitignore ownership) + PLAYBOOKS.md §12
// (canonical playbooks distribution).
//
// Scaffolds the four bootstrap artifacts under .agent/:
//
//   1. permissions.yaml — strict default-deny baseline (mode tunable)
//   2. .gitignore       — runtime data exclusion (operator-owned post-creation)
//   3. config.toml      — schema documentation (every key commented)
//   4. agents/*.md      — 10 canonical playbooks
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
import { DEFAULT_MEMORY_CONFIG } from '../critique/config-loader.ts';
import { DEFAULT_CRITIQUE_CONFIG } from '../critique/types.ts';
import { DEFAULT_BUDGET } from '../harness/types.ts';
import { ensureAgentGitignore } from '../memory/gitignore.ts';
import { projectPolicyPath } from '../permissions/index.ts';
import { DEFAULT_MODEL } from '../providers/default-model.ts';
import { projectAgentsDir } from '../subagents/paths.ts';
import { renderInitConfigTemplate } from './init-config-template.ts';
import { CANONICAL_PLAYBOOKS, type CanonicalPlaybook } from './init-playbooks/index.ts';
import { type InitMode, renderInitTemplate } from './init-template.ts';

// Discrete steps in the scaffold. Order in DEFAULT_STEPS reflects
// the order they run when no `--only` is passed: permissions first
// (load-bearing — without it everything denies), gitignore next
// (so subsequent writes don't pollute the operator's git status),
// config third (depends only on .agent/ existing), playbooks last
// (largest payload, longest to walk).
export type InitStep = 'permissions' | 'gitignore' | 'config' | 'playbooks';

export const DEFAULT_STEPS: ReadonlyArray<InitStep> = [
  'permissions',
  'gitignore',
  'config',
  'playbooks',
];

// `gitignore` is excluded — it is operator-owned after creation per
// MEMORY.md §2.5. Forcing a re-write would defeat the spec promise
// and surprise an operator who edited the file.
export type ForceEligibleStep = Exclude<InitStep, 'gitignore'>;

export interface InitOptions {
  cwd: string;
  mode: InitMode;
  // Subset of steps to run. Defaults to DEFAULT_STEPS (all four).
  only?: ReadonlyArray<InitStep>;
  // `'all'` overwrites every force-eligible step (permissions,
  // config, playbooks). An array overwrites only the listed steps.
  // `undefined` means "no overwrites" — every step is
  // skip-if-exists. `.gitignore` is never force-eligible.
  force?: 'all' | ReadonlyArray<ForceEligibleStep>;
  // Test seam — defaults to the bundled CANONICAL_PLAYBOOKS. Tests
  // pass a fixture array to exercise the copy/skip/force matrix
  // without depending on the full canonical set.
  playbookSource?: ReadonlyArray<CanonicalPlaybook>;
  // Sink for the success / error messages. Production wires to
  // stdout/stderr; tests inject collectors.
  out: (s: string) => void;
  err: (s: string) => void;
}

interface StepResult {
  wrote: number;
  skipped: number;
  overwritten: number;
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
    // Scaffold sources all four section values from the canonical
    // code defaults so a re-run with `--force=config` (or a fresh
    // init after a bump) re-syncs to the current values.
    atomicWrite(
      target,
      renderInitConfigTemplate({
        model: DEFAULT_MODEL,
        budget: DEFAULT_BUDGET,
        memory: DEFAULT_MEMORY_CONFIG,
        critique: DEFAULT_CRITIQUE_CONFIG,
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

const scaffoldPlaybooks = (options: InitOptions, force: boolean): StepResult | null => {
  const { cwd, out, err } = options;
  const targetDir = projectAgentsDir(cwd);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to create ${targetDir}: ${msg}\n`);
    return null;
  }
  const source = options.playbookSource ?? CANONICAL_PLAYBOOKS;
  let wrote = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const playbook of source) {
    const target = join(targetDir, playbook.filename);
    const exists = existsSync(target);
    if (exists && !force) {
      skipped++;
      out(
        `forja: skip ${target} (already exists; use --force or --force=playbooks to overwrite)\n`,
      );
      continue;
    }
    try {
      atomicWrite(target, playbook.content);
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
    } else {
      result = scaffoldPlaybooks(options, forcedFor(options.force, 'playbooks'));
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
  }
  const stepWord = steps.length === 1 ? 'step' : 'steps';
  options.out(
    `forja: ${totals.wrote} wrote, ${totals.overwritten} overwritten, ${totals.skipped} skipped (${steps.length} ${stepWord})\n`,
  );
  if (totals.wrote + totals.overwritten > 0) {
    options.out("forja: review .agent/ and run 'agent' to start.\n");
  }
  return 0;
};
