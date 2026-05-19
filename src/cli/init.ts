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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureAgentGitignore } from '../memory/gitignore.ts';
import { projectPolicyPath } from '../permissions/index.ts';
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
    writeFileSync(target, renderInitTemplate(mode), { encoding: 'utf8' });
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
    writeFileSync(target, renderInitConfigTemplate(), { encoding: 'utf8' });
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
      writeFileSync(target, playbook.content, { encoding: 'utf8' });
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
