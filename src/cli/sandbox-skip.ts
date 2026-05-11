// §13.5 sandbox_skip marker — PERMISSION_ENGINE.md slice 91.
//
// Spec line 893: "Nunca há opção silenciosa 'skip and don't ask
// again'. Re-prompt em toda sessão se sandbox continua ausente;
// suprimível só com `~/.config/forja/sandbox_skip` criado via
// `--i-know-what-im-doing`."
//
// The marker file exists for the rare advanced operator who:
//   1. acknowledges they're running without sandbox isolation;
//   2. doesn't want the first-boot prompt every session;
//   3. is OK with that visible-to-audit acknowledgment.
//
// The intent is high-friction-to-engage: long flag name (no
// short form), no env var, no config file. Operator must
// EXPLICITLY pass `--i-know-what-im-doing` once. Subsequent
// sessions read the marker + skip the welcome prompt.
//
// Out of scope: bypassing policy / sandbox enforcement at
// runtime. The marker is UX-only — the engine's degraded state +
// confirm-on-every-call posture is unaffected.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Path to the marker file. Honors `$XDG_CONFIG_HOME` per
// freedesktop spec; falls back to `$HOME/.config` (env-provided
// HOME, then `homedir()` system call). Linux/macOS only —
// Windows operators are out-of-scope per §13.2.
export const sandboxSkipPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdgConfig = env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig.length > 0) {
    return join(xdgConfig, 'forja', 'sandbox_skip');
  }
  // Prefer env.HOME so tests can pin the path without setting the
  // OS-level home directory; fall back to homedir() for runtime
  // production callers that haven't overridden env.
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, '.config', 'forja', 'sandbox_skip');
};

// True iff the marker exists. Read-only — no probing of contents.
// The file's mere presence is the signal; contents are
// operator-readable diagnostics (timestamp, version), not
// machine-readable state.
export const hasSandboxSkip = (
  options: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): boolean => {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  return exists(sandboxSkipPath(env));
};

// Create the marker file. Idempotent — re-creating an existing
// marker is a no-op (timestamps stay). Body carries a human-
// readable acknowledgment so operators inspecting the file can
// see WHEN + by which forja version it was created.
//
// Test seams: `env`, `ensureDir`, `write`, `now`. Production
// callers leave them undefined.
export interface CreateSandboxSkipOptions {
  env?: NodeJS.ProcessEnv;
  ensureDir?: (dir: string) => void;
  write?: (path: string, content: string) => void;
  exists?: (path: string) => boolean;
  now?: () => number;
  engineVersion?: string;
}

export const createSandboxSkip = (
  options: CreateSandboxSkipOptions = {},
): { path: string; created: boolean } => {
  const env = options.env ?? process.env;
  const ensureDir = options.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const write = options.write ?? ((p, c) => writeFileSync(p, c, 'utf-8'));
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const path = sandboxSkipPath(env);
  if (exists(path)) {
    return { path, created: false };
  }
  ensureDir(dirname(path));
  const ts = new Date(now()).toISOString();
  const version = options.engineVersion ?? 'unknown';
  const body = [
    '# forja sandbox_skip marker',
    `# created: ${ts}`,
    `# version: ${version}`,
    '',
    '# This file suppresses the first-boot sandbox prompt for the',
    '# operator who acknowledged the unsafe-mode posture via',
    '# --i-know-what-im-doing. Delete this file to re-enable the',
    '# prompt. Does NOT bypass engine enforcement at runtime.',
    '',
  ].join('\n');
  write(path, body);
  return { path, created: true };
};
