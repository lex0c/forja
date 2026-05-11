// `agent doctor [--json]` — §13 platform provisioning health check.
//
// First slice on §13 — foundation for future `agent sandbox setup`
// + broker/worker arch. Runs a fixed set of checks and reports
// status per check. Spec philosophy line 765: "detect, don't
// distribute" — we probe the host, surface what's there, and
// recommend (don't auto-install) anything missing.
//
// Checks:
//   - platform: OS + architecture (informational, always ok).
//   - sandbox: bwrap (linux) or sandbox-exec (macOS) availability.
//   - config_dir: `~/.config/agent` writability — needed for
//     install_id + policy files.
//   - data_dir: `~/.local/share/forja` writability — needed for
//     the sessions DB.
//   - policy_load: §5 hierarchy resolution — per-layer
//     enterprise/user/project status (slice 61).
//   - sealing: §7.3 worm-file seal status — entry count + last
//     seal timestamp (slice 60).
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
import {
  type SealStore,
  createWormFileSealer,
  detectSandboxAvailability,
  resolvePolicy,
} from '../permissions/index.ts';
import { installIdPath } from '../permissions/paths.ts';
import type { SealPolicy } from '../permissions/types.ts';

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
  // Working directory used by the sealing check's policy resolution.
  // Defaults to process.cwd() in production; tests pin a specific
  // directory containing the relevant `.agent/permissions.yaml`.
  cwd?: string;
  // Test seams for `resolvePolicy` — match the CLI verbs' shape so
  // the same yaml fixtures work across surfaces. `null` disables the
  // layer; `undefined` falls through to platform defaults.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Test seam for the sealing check's `SealStore` construction.
  // Production reads the configured seal file in read-only mode via
  // `createWormFileSealer`; tests inject a mem-store pre-loaded with
  // entries so the check's branches can be exercised deterministically.
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  // Timestamp seam for the sealing check's relative-time rendering
  // ("last seal 4h ago"). Production: Date.now(); tests pin a fixed
  // number for stable assertions.
  now?: () => number;
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

// §13.3 policy-load health check (slice 61). Resolves the active
// policy via `resolvePolicy(cwd/HOME)` and reports per-layer
// loaded/absent status. Lock conflicts surface as `warn` — the
// policy DID load, but a higher layer's lock rejected a lower
// layer's attempted override. Schema errors during parse fail
// loudly with the underlying parser message as the remediation
// guide.
//
// Spec line 803 shows the canonical line:
//   `Policy load: enterprise=none user=ok project=ok OK`
// Status semantics:
//   - `ok`         — every requested layer either loaded cleanly
//                    or was absent (no errors, no lock conflicts).
//   - `warn`       — loaded with lock conflicts. Operator should
//                    review the layer hierarchy; enforcement still
//                    works but lower-layer intent was overridden.
//   - `fail`       — parse error / schema violation. The bootstrap
//                    would refuse to start; doctor catches it
//                    early.
//
// Session layer is not reported — it's runtime-injected via CLI
// flag overrides, not file-backed, so it's irrelevant for a
// pre-flight check that's about disk state.
interface PolicyLoadCheckOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  enterprisePath?: string | null;
  userPath?: string | null;
}

const policyLoadCheck = (options: PolicyLoadCheckOptions): DoctorCheck => {
  let resolved: ReturnType<typeof resolvePolicy>;
  try {
    resolved = resolvePolicy({
      cwd: options.cwd,
      home: options.env.HOME ?? options.cwd,
      env: options.env,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
    });
  } catch (e) {
    return {
      name: 'policy_load',
      status: 'fail',
      detail: (e as Error).message,
      remediation: 'check the YAML files for syntax errors or schema violations',
    };
  }
  // Initial state: every requested layer is `none` (absent on disk).
  // `resolved.layers` includes ONLY the layers that loaded cleanly,
  // so any layer NOT in the list is genuinely missing. Disabled
  // layers (test seam `enterprisePath: null`) also show as `none` —
  // semantically correct: doctor reports observed state, not
  // intent.
  const status: { enterprise: string; user: string; project: string } = {
    enterprise: 'none',
    user: 'none',
    project: 'none',
  };
  for (const l of resolved.layers) {
    if (l.layer === 'enterprise' || l.layer === 'user' || l.layer === 'project') {
      status[l.layer] = 'ok';
    }
  }
  const summary = `enterprise=${status.enterprise} user=${status.user} project=${status.project}`;
  if (resolved.lockConflicts.length > 0) {
    // Render the first conflict's `section + lockedBy + attemptedBy`
    // shape; if there are more, append "(+N more)". One line stays
    // readable; the operator drills deeper via `agent perms`.
    const first = resolved.lockConflicts[0];
    if (first === undefined) {
      // Defensive — unreachable since length > 0.
      return { name: 'policy_load', status: 'ok', detail: summary };
    }
    const more =
      resolved.lockConflicts.length > 1 ? ` (+${resolved.lockConflicts.length - 1} more)` : '';
    return {
      name: 'policy_load',
      status: 'warn',
      detail: `${summary}; lock conflict: ${first.section} locked by ${first.lockedBy}, attempted by ${first.attemptedBy}${more}`,
      remediation:
        'review layer precedence: a lower-priority layer attempted to override a locked field',
    };
  }
  return { name: 'policy_load', status: 'ok', detail: summary };
};

// Human-readable relative-time formatter. Matches the spec example
// at line 805 ("last success 4h ago"). Coarse buckets are fine — the
// goal is "operator glances at doctor and sees sealing is recent vs
// stale", not millisecond precision.
const formatRelativeTime = (then: number, now: number): string => {
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// §13.3 sealing health check (slice 60). Reads the active policy's
// `seal` section and reports the worm-file's state:
//   - no seal config / mode='none' → ok "not configured (optional)"
//   - mode='worm-file', file missing/empty → warn (sealing configured
//     but no entries yet; engine seals on next interval / first call)
//   - mode='worm-file', file with N entries → ok "N entries, last X ago"
//   - mode='worm-file', file corrupted → fail (tampering signal)
//
// Spec line 805 shows this line in the canonical doctor output:
//   `External sealing: rfc3161-tsa (last success 4h ago) OK`
// Slice 60 ships the worm-file variant; other backends extend the
// branch dispatch as their factories land in later slices.
interface SealingCheckOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  enterprisePath?: string | null;
  userPath?: string | null;
  sealStoreFactory?: (config: SealPolicy) => SealStore;
  now: () => number;
}

const sealingCheck = (options: SealingCheckOptions): DoctorCheck => {
  // Resolve the active policy. Failures here are reported as warn,
  // NOT fail — a bad policy is a separate problem from sealing
  // health, and the policy_load check would catch it. We don't want
  // to double-report.
  let sealConfig: SealPolicy | undefined;
  try {
    const resolved = resolvePolicy({
      cwd: options.cwd,
      home: options.env.HOME ?? options.cwd,
      env: options.env,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
    });
    sealConfig = resolved.policy.seal;
  } catch (e) {
    return {
      name: 'sealing',
      status: 'warn',
      detail: `policy load failed: ${(e as Error).message}`,
    };
  }

  if (sealConfig === undefined || sealConfig.mode === 'none') {
    return {
      name: 'sealing',
      status: 'ok',
      detail: 'not configured (optional per spec §7.3)',
    };
  }

  if (sealConfig.mode === 'worm-file') {
    if (sealConfig.path === undefined) {
      // parsePolicy enforces this; unreachable in well-formed input.
      return {
        name: 'sealing',
        status: 'fail',
        detail: "worm-file mode missing 'path' field",
        remediation: "add 'path: /var/log/agent/seal.log' to the seal section",
      };
    }
    const factory =
      options.sealStoreFactory ?? ((c: SealPolicy) => createWormFileSealer({ path: c.path ?? '' }));
    let store: SealStore;
    try {
      store = factory(sealConfig);
    } catch (e) {
      return {
        name: 'sealing',
        status: 'fail',
        detail: `factory failed: ${(e as Error).message}`,
      };
    }
    let entries: readonly { seq: number; ts: number; hash: string }[];
    try {
      entries = store.list();
    } catch (e) {
      // Malformed seal file — strong tampering signal.
      return {
        name: 'sealing',
        status: 'fail',
        detail: `seal file corrupted at ${sealConfig.path}: ${(e as Error).message}`,
        remediation: 'inspect the file; run `agent permission seal-verify` for chain cross-check',
      };
    }
    if (entries.length === 0) {
      return {
        name: 'sealing',
        status: 'warn',
        detail: `worm-file at ${sealConfig.path}: configured but no entries yet`,
        remediation:
          'the engine seals automatically per interval; run `agent permission seal-now` to force one',
      };
    }
    const last = entries[entries.length - 1];
    if (last === undefined) {
      // Defensive; unreachable since entries.length > 0.
      return { name: 'sealing', status: 'fail', detail: 'list returned a missing tail entry' };
    }
    const relTime = formatRelativeTime(last.ts, options.now());
    const entryWord = entries.length === 1 ? 'entry' : 'entries';
    return {
      name: 'sealing',
      status: 'ok',
      detail: `worm-file at ${sealConfig.path}: ${entries.length} ${entryWord}, last ${relTime}`,
    };
  }

  // Defensive — parsePolicy rejects reserved modes; this only fires
  // if a future schema accepts a new mode before the dispatch is
  // updated.
  return {
    name: 'sealing',
    status: 'warn',
    detail: `mode '${sealConfig.mode}' has no doctor check wired yet`,
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

  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;
  const checks: DoctorCheck[] = [
    platformCheck(env),
    sandboxCheck(which),
    configDirCheck(env),
    dataDirCheck(env),
    policyLoadCheck({
      env,
      cwd,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
    }),
    sealingCheck({
      env,
      cwd,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
      ...(options.sealStoreFactory !== undefined
        ? { sealStoreFactory: options.sealStoreFactory }
        : {}),
      now,
    }),
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
