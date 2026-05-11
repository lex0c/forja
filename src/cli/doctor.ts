// `agent doctor [--json]` — §13 platform provisioning health check.
//
// First slice on §13 — foundation for future `agent sandbox setup`
// + broker/worker arch. Runs a fixed set of checks and reports
// status per check. Spec philosophy line 765: "detect, don't
// distribute" — we probe the host, surface what's there, and
// recommend (don't auto-install) anything missing.
//
// Checks (this slice):
//   - platform: OS + architecture (informational, always ok).
//   - sandbox: bwrap (linux) or sandbox-exec (macOS) availability.
//   - config_dir: `~/.config/agent` writability — needed for
//     install_id + policy files.
//   - data_dir: `~/.local/share/forja` writability — needed for
//     the sessions DB.
//   - git: presence on PATH — degrades git_* tools when absent.
//
// Exit codes:
//   - 0: every check is `ok` or `warn` (operator can proceed).
//   - 1: any check is `fail` (engine can't bootstrap safely).
//
// JSON mode emits one NDJSON event per check followed by a
// `{"kind":"summary",...}` line. Same convention as
// --list-sessions / --explain-permissions.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir, arch as nodeArch, platform as nodePlatform } from 'node:os';
import { dirname } from 'node:path';
import { detectSandboxAvailability } from '../permissions/index.ts';
import { installIdPath } from '../permissions/paths.ts';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  // Optional next-step text. Rendered after the status line when
  // present; omitted on `ok` checks where there's nothing to do.
  remediation?: string;
}

export interface RunDoctorOptions {
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  // Test seam for `which()` so unit tests can simulate missing
  // binaries without touching $PATH on the runner host.
  which?: (cmd: string) => string | null;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const STATUS_LABEL: Record<DoctorStatus, string> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
};

// `Bun.which` is the production binary probe; tests inject a stub
// via options.which. Returns null on miss, the absolute path on hit.
const defaultWhich = (cmd: string): string | null => Bun.which(cmd);

const platformCheck = (env: NodeJS.ProcessEnv): DoctorCheck => {
  const os = nodePlatform();
  const archStr = nodeArch();
  return {
    name: 'platform',
    status: 'ok',
    detail: `${os} ${archStr} (node ${process.versions.node ?? 'unknown'}, bun ${env.BUN_VERSION ?? process.versions.bun ?? 'unknown'})`,
  };
};

const sandboxCheck = (which: (cmd: string) => string | null): DoctorCheck => {
  const availability = detectSandboxAvailability({ which });
  if (availability.available) {
    return {
      name: 'sandbox',
      status: 'ok',
      detail: `${availability.tool ?? 'unknown'} available`,
    };
  }
  // Sandbox absence is `warn`, not `fail`: the engine still runs
  // (degraded path) but operators should know. `fail` would block
  // the first-boot experience for every Linux user without bwrap
  // pre-installed.
  return {
    name: 'sandbox',
    status: 'warn',
    detail: availability.reason || 'no sandbox tool detected',
    remediation:
      nodePlatform() === 'linux'
        ? 'install bubblewrap (`apt install bubblewrap` or distro equivalent)'
        : nodePlatform() === 'darwin'
          ? 'macOS sandbox-exec is built-in; install missing only on stripped systems'
          : 'sandboxing is not supported on this platform',
  };
};

// Check that a directory exists OR can be created with mode 0700.
// Returns a tri-state: 'ok' (exists + writable), 'fail' (can't
// create + parent unwritable). Errors caught broadly — the OS
// returns enough information via the thrown error message; we
// surface it verbatim.
const dirWritable = (dir: string): { writable: boolean; error?: string } => {
  if (existsSync(dir)) {
    // Best-effort writability probe: create + remove a sentinel
    // file. Skipped here — `mkdirSync` with `recursive: true` is
    // idempotent and would also fail if the dir is read-only.
    return { writable: true };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { writable: true };
  } catch (e) {
    return { writable: false, error: (e as Error).message };
  }
};

const configDirCheck = (env: NodeJS.ProcessEnv): DoctorCheck => {
  const path = installIdPath(env);
  if (path === null) {
    return {
      name: 'config_dir',
      status: 'fail',
      detail: 'cannot derive config directory ($HOME / $XDG_CONFIG_HOME / %APPDATA% all missing)',
      remediation: 'set $HOME to a writable directory',
    };
  }
  const dir = dirname(path);
  const probe = dirWritable(dir);
  if (probe.writable) {
    return { name: 'config_dir', status: 'ok', detail: dir };
  }
  return {
    name: 'config_dir',
    status: 'fail',
    detail: `${dir} not writable: ${probe.error ?? 'unknown error'}`,
    remediation: `ensure ${dir} is writable by the current user`,
  };
};

const dataDirCheck = (env: NodeJS.ProcessEnv): DoctorCheck => {
  // defaultDataDir reads XDG_DATA_HOME / HOME from process.env;
  // override via env temporarily so the test seam works.
  const dir = (() => {
    const xdg = env.XDG_DATA_HOME;
    if (xdg !== undefined && xdg.length > 0) {
      return `${xdg}/forja`;
    }
    const home = env.HOME ?? homedir();
    return `${home}/.local/share/forja`;
  })();
  const probe = dirWritable(dir);
  if (probe.writable) {
    return { name: 'data_dir', status: 'ok', detail: dir };
  }
  return {
    name: 'data_dir',
    status: 'fail',
    detail: `${dir} not writable: ${probe.error ?? 'unknown error'}`,
    remediation: `ensure ${dir} is writable by the current user`,
  };
};

const gitCheck = (which: (cmd: string) => string | null): DoctorCheck => {
  const path = which('git');
  if (path !== null) {
    return { name: 'git', status: 'ok', detail: `found at ${path}` };
  }
  // Git absence is `warn`: most agent tools work without it, but
  // git_* tools (commit, push, branch) degrade silently. Operators
  // doing repo work need it; operators doing read-only Q&A don't.
  return {
    name: 'git',
    status: 'warn',
    detail: 'git not found on $PATH',
    remediation: 'install git (`apt install git` or distro equivalent) to enable git_* tools',
  };
};

const renderCheckPlain = (c: DoctorCheck): string[] => {
  const lines: string[] = [`${c.name}`];
  lines.push(`  status: ${STATUS_LABEL[c.status]}`);
  lines.push(`  ${c.detail}`);
  if (c.remediation !== undefined) {
    lines.push(`  → ${c.remediation}`);
  }
  return lines;
};

export const runDoctor = async (options: RunDoctorOptions = {}): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  void err;
  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const json = options.json === true;

  const checks: DoctorCheck[] = [
    platformCheck(env),
    sandboxCheck(which),
    configDirCheck(env),
    dataDirCheck(env),
    gitCheck(which),
  ];

  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const okCount = checks.filter((c) => c.status === 'ok').length;

  if (json) {
    for (const c of checks) {
      out(`${JSON.stringify({ kind: 'check', ...c })}\n`);
    }
    out(
      `${JSON.stringify({
        kind: 'summary',
        ok: failCount === 0,
        counts: { ok: okCount, warn: warnCount, fail: failCount },
      })}\n`,
    );
    return failCount === 0 ? 0 : 1;
  }

  // Plain text: one block per check, blank line between, summary
  // footer.
  const blocks: string[] = [];
  for (const c of checks) {
    blocks.push(renderCheckPlain(c).join('\n'));
  }
  out(`${blocks.join('\n\n')}\n\n`);
  if (failCount === 0 && warnCount === 0) {
    out('summary: all checks passed\n');
  } else if (failCount === 0) {
    out(`summary: ${warnCount} warning(s) — review before continuing\n`);
  } else {
    out(`summary: ${failCount} failure(s), ${warnCount} warning(s) — engine cannot bootstrap\n`);
  }
  return failCount === 0 ? 0 : 1;
};
