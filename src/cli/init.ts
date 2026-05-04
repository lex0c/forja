// `agent init` handler. Scaffolds `.agent/permissions.yaml` so the
// operator isn't stuck under strict default-deny. Spec:
// AGENTIC_CLI.md §2.1 (init mode) + §8 (permission engine
// bootstrap path).
//
// Pure filesystem work — no DB, no provider, no permission engine.
// We're WRITING the file the engine would later read, so loading
// the engine here would be a chicken-and-egg dependency. The
// handler is intentionally narrow: validate cwd, refuse-on-exists
// without `--force`, write the rendered template, exit.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectPolicyPath } from '../permissions/index.ts';
import { type InitMode, renderInitTemplate } from './init-template.ts';

export interface InitOptions {
  cwd: string;
  force: boolean;
  mode: InitMode;
  // Sink for the success / error message. Production wires to
  // stdout/stderr; tests inject collectors. Errors go through
  // `err`, ok messages through `out` so a `--json` future can
  // route them differently without re-plumbing.
  out: (s: string) => void;
  err: (s: string) => void;
}

export const runInit = (options: InitOptions): number => {
  const { cwd, force, mode, out, err } = options;
  // Single source of truth for the policy path: `projectPolicyPath`
  // is what the engine's hierarchy resolver reads at boot. Using
  // any other literal here would risk write/read divergence the day
  // the path moves (e.g. `.forja/`).
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
