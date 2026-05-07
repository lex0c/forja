// `agent init` handler. Spec: AGENTIC_CLI.md §2.1 (init mode) +
// §8 (permission engine bootstrap path) + PLAYBOOKS.md §14
// (canonical playbooks distribution).
//
// Two paths share the entry point:
//
//   1. Default — scaffolds `.agent/permissions.yaml` so the
//      operator isn't stuck under strict default-deny.
//   2. `--playbooks` — copies the 10 canonical .md playbooks
//      to `.agent/agents/`. Each file becomes a discoverable
//      definition the loader picks up at the next REPL boot.
//
// Pure filesystem work — no DB, no provider, no permission engine.
// We're WRITING files the engine would later read, so loading
// the engine here would be a chicken-and-egg dependency.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectPolicyPath } from '../permissions/index.ts';
import { projectAgentsDir } from '../subagents/paths.ts';
import { CANONICAL_PLAYBOOKS, type CanonicalPlaybook } from './init-playbooks/index.ts';
import { type InitMode, renderInitTemplate } from './init-template.ts';

export interface InitOptions {
  cwd: string;
  force: boolean;
  mode: InitMode;
  // Switches the handler to the canonical-playbooks path
  // (`PLAYBOOKS.md` §14). When true, `mode` is ignored and the
  // 10 .md assets bundled under `init-playbooks/` are written
  // to `.agent/agents/`. False (default) preserves the
  // permissions-scaffold behavior.
  playbooks?: boolean;
  // Test seam — defaults to the bundled `CANONICAL_PLAYBOOKS`.
  // Tests pass a fixture array to exercise the copy/skip/force
  // matrix without depending on the full canonical set.
  playbookSource?: ReadonlyArray<CanonicalPlaybook>;
  // Sink for the success / error message. Production wires to
  // stdout/stderr; tests inject collectors. Errors go through
  // `err`, ok messages through `out` so a `--json` future can
  // route them differently without re-plumbing.
  out: (s: string) => void;
  err: (s: string) => void;
}

// Permissions path (default). Single source of truth for the
// policy path: `projectPolicyPath` is what the engine's hierarchy
// resolver reads at boot. Using any other literal here would risk
// write/read divergence the day the path moves (e.g. `.forja/`).
const runInitPermissions = (options: InitOptions): number => {
  const { cwd, force, mode, out, err } = options;
  const target = projectPolicyPath(cwd);
  if (existsSync(target) && !force) {
    err(`forja: ${target} already exists. Use --force to overwrite.\n`);
    return 1;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderInitTemplate(mode), { encoding: 'utf8' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to write ${target}: ${msg}\n`);
    return 1;
  }
  out(`forja: wrote ${target}\n`);
  out("forja: review the file, edit as needed, then run 'agent' to start.\n");
  return 0;
};

// Playbooks path. Copies each bundled .md to
// `<cwd>/.agent/agents/<filename>`. Skip-if-exists by default —
// authors who edited a playbook keep their changes. `--force`
// overwrites each entry (existing or not) and reports the
// overwrites separately so the operator notices what was clobbered.
//
// Failure to write any single file aborts the run with a partial
// report on stderr. We do NOT roll back files already written —
// the operator can re-run with `--force` once they fix the cause
// (commonly EACCES on a file owned by a previous root invocation).
const runInitPlaybooks = (options: InitOptions): number => {
  const { cwd, force, out, err } = options;
  const targetDir = projectAgentsDir(cwd);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`forja: failed to create ${targetDir}: ${msg}\n`);
    return 1;
  }
  const source = options.playbookSource ?? CANONICAL_PLAYBOOKS;
  let copied = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const playbook of source) {
    const target = join(targetDir, playbook.filename);
    const exists = existsSync(target);
    if (exists && !force) {
      skipped++;
      out(`forja: skip ${target} (already exists; use --force to overwrite)\n`);
      continue;
    }
    try {
      writeFileSync(target, playbook.content, { encoding: 'utf8' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`forja: failed to write ${target}: ${msg}\n`);
      return 1;
    }
    if (exists) {
      overwritten++;
      out(`forja: overwrote ${target}\n`);
    } else {
      copied++;
      out(`forja: wrote ${target}\n`);
    }
  }
  // Summary line so the operator does not have to count rows.
  // Distinguishing copied / overwritten / skipped lets a future
  // `--dry-run` reuse the same renderer without behavior changes.
  out(
    `forja: ${copied} copied, ${overwritten} overwritten, ${skipped} skipped (${source.length} total)\n`,
  );
  if (copied + overwritten > 0) {
    out("forja: review the playbooks under .agent/agents/, then run 'agent' to use them.\n");
  }
  return 0;
};

export const runInit = (options: InitOptions): number => {
  if (options.playbooks === true) return runInitPlaybooks(options);
  return runInitPermissions(options);
};
