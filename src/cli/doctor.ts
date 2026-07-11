// `forja doctor [--json]` — §13 platform provisioning health check.
//
// First slice on §13 — foundation for future `forja sandbox setup`
// + broker/worker arch. Runs a fixed set of checks and reports
// status per check. Spec philosophy line 765: "detect, don't
// distribute" — we probe the host, surface what's there, and
// recommend (don't auto-install) anything missing.
//
// Checks:
//   - platform: OS + architecture (informational, always ok).
//   - sandbox: bwrap (linux) or sandbox-exec (macOS) availability.
//   - config_dir: `~/.config/forja` writability — needed for
//     install_id + policy files.
//   - data_dir: `~/.local/share/forja` writability — needed for
//     the sessions DB.
//   - policy_load: §5 hierarchy resolution — per-layer
//     enterprise/user/project status (slice 61).
//   - hash_chain: §7.2 audit chain integrity — verifyChain over
//     the current install's approvals_log (slice 62).
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

import { execFileSync } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants, mkdirSync, readFileSync } from 'node:fs';
import { homedir, arch as nodeArch, platform as nodePlatform } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { activeProfile, appDirName } from '../config/app-namespace.ts';
import {
  type SealStore,
  type VerifyResult,
  createSqliteSink,
  detectSandboxAvailability,
  ensureInstallId,
  factoryForSealMode,
  resolvePolicy,
} from '../permissions/index.ts';
import { installIdPath } from '../permissions/paths.ts';
import type { SandboxProfile } from '../permissions/sandbox-plan.ts';
import type { SealPolicy } from '../permissions/types.ts';
import { closeDb, defaultDbPath, openDb } from '../storage/index.ts';
import { listServers as listMcpServers } from '../storage/repos/mcp-servers.ts';
import { type DoctorCheckCache, getSharedDoctorCache, withDoctorCache } from './doctor-cache.ts';
import { forjaCommand } from './forja-command.ts';

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
  // Slice 154 (review): forward canonical-first resolver seams to
  // detectSandboxAvailability.
  exists?: (path: string) => boolean;
  stat?: (path: string) => { uid: number; mode: number } | null;
  // Execute-access (X_OK) probe for the canonical-first resolver.
  // Production uses `accessSync(path, X_OK)`. Without this seam the
  // resolver falls back to the real kernel check, so the `sandbox` /
  // `sandbox_enforcement` checks depend on whether the runner
  // actually has an *executable* /usr/bin/bwrap — flaky on CI hosts
  // that mock `which`/`exists` but lack the real binary.
  isExecutable?: (path: string) => boolean;
  // Working directory used by the sealing check's policy resolution.
  // Defaults to process.cwd() in production; tests pin a specific
  // directory containing the relevant `.forja/permissions.yaml`.
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
  // Override the default SQLite DB path for the hash_chain check.
  // Production reads the operator's session DB at `defaultDbPath()`;
  // tests pin an in-memory or temp-file path.
  dbPath?: string;
  // Test seam — reads a sysctl path (e.g.,
  // `/proc/sys/user/max_user_namespaces`). Production reads via
  // `readFileSync`; tests pass `(path) => string | null`. Returns
  // null on any read error so the check's branches stay
  // deterministic.
  readFile?: (path: string) => string | null;
  // Test seam — invokes a command + returns stdout. Production
  // wraps `execFileSync` with the same null-on-error convention.
  // Used by the net_filtering + mac_lsm checks (nft --version,
  // getenforce, aa-status).
  runCmd?: (cmd: string, args: readonly string[]) => string | null;
  // Test override for the package.json-derived engine version.
  // Production: PACKAGE_VERSION constant. Tests: pin a value
  // for stable assertions.
  engineVersion?: string;
  // §13.8 60s cache for non-critical checks (slice 124). Production:
  // a process-wide singleton from `getSharedDoctorCache()` so a
  // long-running harness re-runs doctor every N tool calls without
  // re-probing kernel/pkg versions. Tests: pass a fresh cache per
  // test so shared state doesn't leak between tests. Critical
  // checks (sandbox binary, policy_load, hash_chain, fs writable,
  // sealing) bypass the cache regardless.
  cache?: DoctorCheckCache;
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

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
};

const defaultRunCmd = (cmd: string, args: readonly string[]): string | null => {
  try {
    return execFileSync(cmd, [...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

const platformCheck = (env: NodeJS.ProcessEnv): DoctorCheck => {
  const os = nodePlatform();
  const archStr = nodeArch();
  return {
    name: 'platform',
    status: 'ok',
    detail: `${os} ${archStr} (node ${process.versions.node ?? 'unknown'}, bun ${env.BUN_VERSION ?? process.versions.bun ?? 'unknown'})`,
  };
};

const sandboxCheck = (
  which: (cmd: string) => string | null,
  exists?: (path: string) => boolean,
  stat?: (path: string) => { uid: number; mode: number } | null,
  isExecutable?: (path: string) => boolean,
): DoctorCheck => {
  // Slice 154 (review): forward canonical-first resolver seams.
  const detectOpts: Parameters<typeof detectSandboxAvailability>[0] = { which };
  if (exists !== undefined) detectOpts.exists = exists;
  if (stat !== undefined) detectOpts.stat = stat;
  if (isExecutable !== undefined) detectOpts.isExecutable = isExecutable;
  const availability = detectSandboxAvailability(detectOpts);
  if (availability.available) {
    // Slice 165 (review — Batch C sandbox observability). The
    // resolver populated `trustLevel` + `trustWarnings` in slice
    // 154 specifically so doctor + telemetry could surface them
    // to the operator. Pre-slice the warnings were computed and
    // dropped — operator running with `/tmp/evilbin/bwrap` (owner
    // root, mode 0o755 — passes the stat-check but isn't canonical)
    // saw "sandbox: ok bwrap available" without any clue that the
    // binary isn't `/usr/bin/bwrap`. Trust postmortem ("rodava com
    // bwrap não-canonical em /opt/bin" — slice 154 spec phrasing)
    // had no surface to read from.
    //
    // Post-slice doctor renders trust warnings as `warn` status (not
    // `fail` — non-canonical sandbox still works, just deserves an
    // operator-visible flag). Canonical installs continue to be
    // pure `ok`.
    if (availability.trustLevel === 'canonical') {
      return {
        name: 'sandbox',
        status: 'ok',
        detail: `${availability.tool ?? 'unknown'} available (${availability.path ?? 'canonical'})`,
      };
    }
    // path-resolved (non-canonical) — surface the warnings.
    return {
      name: 'sandbox',
      status: 'warn',
      detail: `${availability.tool ?? 'unknown'} available at ${availability.path ?? '<unknown>'} (trustLevel=${availability.trustLevel})`,
      remediation:
        availability.trustWarnings.length > 0
          ? `Trust warnings: ${availability.trustWarnings.join('; ')}. Verify the binary is legitimate or install the canonical version per spec §6.5.`
          : 'Sandbox binary resolved via $PATH instead of canonical /usr/bin/. Verify the install source.',
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

// Check that a directory exists AND is writable OR can be created
// with mode 0700. Returns a tri-state: 'ok' (exists + writable),
// 'fail' (can't create + parent unwritable). Errors caught broadly
// — the OS returns enough information via the thrown error
// message; we surface it verbatim.
//
// Slice 123 (R9 P1): pre-slice the existsSync branch returned
// `writable: true` without probing — a dir at chmod 0500
// (read+exec, no write) on the operator's `~/.config/forja`
// passed the doctor check but EVERY runtime fs op on that path
// failed. accessSync(W_OK) catches it.
const dirWritable = (dir: string): { writable: boolean; error?: string } => {
  if (existsSync(dir)) {
    try {
      accessSync(dir, fsConstants.W_OK);
      return { writable: true };
    } catch (e) {
      return { writable: false, error: (e as Error).message };
    }
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
    // appDirName(env) so `--profile dev` reports `~/.local/share/forja-dev`,
    // matching where the session DB actually lands. Re-derived here (not via
    // defaultDataDir) to honor the `env` test seam.
    const app = appDirName(env);
    const xdg = env.XDG_DATA_HOME;
    if (xdg !== undefined && xdg.length > 0) {
      return `${xdg}/${app}`;
    }
    const home = env.HOME ?? homedir();
    return `${home}/.local/share/${app}`;
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

// §7.2 + §13.3 hash chain health check (slice 62). Walks the
// audit chain for the current install_id and reports integrity.
// Mirrors what `forja permission verify` does, in a doctor-shaped
// output: one line per outcome instead of the full forensic dump.
//
// Failure modes ranked:
//   - `fail` — chain BROKEN at seq M with the verifier's reason.
//     This is a P0 signal per spec line 1212
//     (`chain_verification_failures_total > 0 = P0`). Operator
//     remediation: full `forja permission verify` for details, or
//     `forja permission rotate-chain` to archive the broken
//     segment.
//   - `warn` — chain intact BUT quarantined (post-rotation segment
//     unreviewed). Engine still works; operator should inspect via
//     `forja permission inspect <rotation_id>`.
//   - `ok`   — chain intact, not quarantined. Reports the row
//     count + rotation_id when non-zero.
//
// Empty cases:
//   - No DB file → ok "no chain yet (DB created on first session)".
//     Fresh installs don't have a sessions DB until the first
//     emit.
//   - DB exists but no rows → ok "no chain rows yet". Same shape;
//     the DB was created (e.g., for sessions metadata) but no
//     audit decisions landed.
//
// install_id discovery failure → fail. Without the install_id we
// can't filter the chain to the current install; doctor can't
// proceed without it.
interface ChainCheckOptions {
  env: NodeJS.ProcessEnv;
  dbPath: string;
}

// MCP servers (MCP.md §7): a read-only DB probe (the manager isn't built in a
// doctor run) listing configured/trusted servers and flagging any stuck in a
// degraded/error state. `ok`/no-server is the common case.
const mcpCheck = (opts: { dbPath: string }): DoctorCheck => {
  // No DB yet (fresh install — the most common doctor invocation): MCP simply
  // isn't set up. Skip the open entirely (mirrors chainCheck's existsSync guard;
  // avoids the alarming "unable to open database file" detail + a wasted open).
  if (!existsSync(opts.dbPath)) {
    return { name: 'mcp', status: 'ok', detail: 'no MCP servers (no database yet)' };
  }
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(opts.dbPath, { readonly: true });
    const servers = listMcpServers(db);
    if (servers.length === 0) {
      return { name: 'mcp', status: 'ok', detail: 'no MCP servers configured' };
    }
    const summary = servers.map((s) => `${s.name}(${s.state})`).join(', ');
    const bad = servers.filter((s) => s.state === 'error' || s.state === 'degraded');
    if (bad.length > 0) {
      return {
        name: 'mcp',
        status: 'warn',
        detail: `${servers.length} server(s): ${summary}`,
        remediation: `reconnect / re-trust the degraded or errored server(s): ${bad.map((s) => s.name).join(', ')}`,
      };
    }
    return { name: 'mcp', status: 'ok', detail: `${servers.length} server(s): ${summary}` };
  } catch (e) {
    const msg = (e as Error).message;
    // An unmigrated DB has no mcp_servers table — MCP isn't set up (clean 'ok').
    // ANY other read failure (notably a corrupt DB, which openDb surfaces via
    // its integrity_check) is NOT 'ok' — defer the severity to the hash_chain
    // check and merely warn here, rather than print a self-contradictory
    // "ok … DB is corrupted".
    if (msg.includes('no such table')) {
      return { name: 'mcp', status: 'ok', detail: 'no MCP servers (not initialized)' };
    }
    return {
      name: 'mcp',
      status: 'warn',
      detail: `could not read MCP state (see hash_chain): ${msg}`,
    };
  } finally {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore — readonly close errors don't invalidate the result above
      }
    }
  }
};

const chainCheck = (options: ChainCheckOptions): DoctorCheck => {
  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId({ env: options.env });
  } catch (e) {
    return {
      name: 'hash_chain',
      status: 'fail',
      detail: `install_id discovery failed: ${(e as Error).message}`,
      remediation: 'check $HOME / $XDG_CONFIG_HOME / %APPDATA% writability',
    };
  }

  // No DB file yet — fresh install, nothing to verify. The first
  // session's emit will create it via `migrate()`.
  if (!existsSync(options.dbPath)) {
    return {
      name: 'hash_chain',
      status: 'ok',
      detail: 'no chain yet (DB will be created on first session)',
    };
  }

  // Slice 125 (R2 P0-7 + P0-8):
  //   - Open the DB READONLY. Pre-slice chainCheck called
  //     `migrate(db, MIGRATIONS)` which writes to `_migrations`
  //     and applies pending DDL. A doctor health check is the
  //     wrong surface to mutate schema (§13.1 "detect, don't
  //     distribute"); if the schema is stale, verifyChain's
  //     query fails and that IS the right signal for the
  //     operator.
  //   - Close the DB handle on every return path. Pre-slice
  //     the handle leaked: under §13.8 the harness re-runs
  //     doctor every 50 tool calls, accumulating WAL connections
  //     over a long session.
  let result: VerifyResult;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(options.dbPath, { readonly: true });
    const sink = createSqliteSink({ db, identity });
    result = sink.verifyChain();
  } catch (e) {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore — primary error already in flight
      }
    }
    return {
      name: 'hash_chain',
      status: 'fail',
      detail: `DB error: ${(e as Error).message}`,
      // Slice 127 (R3 P1): rename remediation so the operator
      // knows that `forja permission verify` ALSO migrates the
      // schema as a side effect (it's the operator-invoked verb
      // that brings the local DB up to spec). Pre-slice the
      // remediation said "for details" — misleading because the
      // verify run silently upgrades the schema, fixing the gap
      // doctor just flagged. The honest framing is "run verify
      // — it will migrate the schema if needed AND verify the
      // chain".
      remediation: `check ${options.dbPath} for corruption / permissions, OR run \`${forjaCommand('permission verify')}\` which migrates the schema to the current spec and re-verifies the chain`,
    };
  } finally {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore — close errors on a readonly handle indicate
        // a low-level issue; the verifyChain result we just
        // captured is still authoritative.
      }
    }
  }

  if (!result.ok) {
    return {
      name: 'hash_chain',
      status: 'fail',
      detail: `BROKEN at seq ${result.brokenAt}: ${result.reason}`,
      remediation: `run \`${forjaCommand('permission verify')}\` for full diagnostic, or \`${forjaCommand('permission rotate-chain --reason <text>')}\` to archive the broken segment`,
    };
  }

  if (result.rows === 0) {
    return {
      name: 'hash_chain',
      status: 'ok',
      detail: 'no chain rows yet (engine has not emitted any decisions)',
    };
  }

  const rowWord = result.rows === 1 ? 'row' : 'rows';
  const baseDetail = `intact (${result.rows} ${rowWord}`;
  const rotationDetail =
    result.current_rotation_id > 0 ? `, rotation_id=${result.current_rotation_id}` : '';

  if (result.quarantined) {
    // Quarantined = post-rotation segment hasn't been inspected.
    // Engine still works; operator should review the archived
    // rows. `warn` not `fail` because enforcement is unaffected.
    return {
      name: 'hash_chain',
      status: 'warn',
      detail: `${baseDetail}${rotationDetail}, quarantined)`,
      remediation: `run \`${forjaCommand(`permission inspect ${result.current_rotation_id}`)}\` to audit the archived segment`,
    };
  }

  return {
    name: 'hash_chain',
    status: 'ok',
    detail: `${baseDetail}${rotationDetail})`,
  };
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

  // Backend dispatch via the shared `factoryForSealMode` helper —
  // worm-file (slice 60) + git-anchored (slice 63) supported. The
  // list()-only read path doesn't trigger backend side effects
  // (chattr / git commit) — doctor reads the seal entries without
  // touching the underlying store.
  if (sealConfig.path === undefined) {
    // parsePolicy enforces this for file-backed modes; unreachable
    // in well-formed input.
    return {
      name: 'sealing',
      status: 'fail',
      detail: `${sealConfig.mode} mode missing 'path' field`,
      remediation: "add 'path: <seal-file-or-repo>' to the seal section",
    };
  }
  const factory = options.sealStoreFactory ?? factoryForSealMode(sealConfig.mode);
  if (factory === null) {
    // Defensive — parsePolicy rejects unknown modes; this only
    // fires if a future schema accepts a new mode before the
    // dispatcher is updated.
    return {
      name: 'sealing',
      status: 'warn',
      detail: `mode '${sealConfig.mode}' has no doctor check wired yet`,
    };
  }
  // Slice 125 (R2 P1): close the store on every return path. The
  // worm-file SealStore's close is a no-op today, but future
  // backends (s3, rfc3161 TSA, git with persistent worktree) hold
  // sockets / file descriptors that MUST be released. Doing it
  // now is cheap defense in depth and matches the contract at
  // sealing.ts:51-66.
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
  try {
    let entries: readonly { seq: number; ts: number; hash: string }[];
    try {
      entries = store.list();
    } catch (e) {
      return {
        name: 'sealing',
        status: 'fail',
        detail: `seal file corrupted at ${sealConfig.path}: ${(e as Error).message}`,
        remediation: `inspect the file; run \`${forjaCommand('permission seal-verify')}\` for chain cross-check`,
      };
    }
    if (entries.length === 0) {
      return {
        name: 'sealing',
        status: 'warn',
        detail: `${sealConfig.mode} at ${sealConfig.path}: configured but no entries yet`,
        remediation: `the engine seals automatically per interval; run \`${forjaCommand('permission seal-now')}\` to force one`,
      };
    }
    const last = entries[entries.length - 1];
    if (last === undefined) {
      return { name: 'sealing', status: 'fail', detail: 'list returned a missing tail entry' };
    }
    const relTime = formatRelativeTime(last.ts, options.now());
    const entryWord = entries.length === 1 ? 'entry' : 'entries';
    return {
      name: 'sealing',
      status: 'ok',
      detail: `${sealConfig.mode} at ${sealConfig.path}: ${entries.length} ${entryWord}, last ${relTime}`,
    };
  } finally {
    try {
      store.close();
    } catch {
      // Close errors on a read-only seal-check path don't change
      // the verdict — the list() we already captured is authoritative.
    }
  }
};

// §13.3 doctor checks (slice 90). Linux kernel + LSM detail that
// affects sandbox availability + capability ceiling. Each check
// surfaces the underlying kernel/userspace state so operators
// know WHY the engine is in a particular degraded posture before
// chasing symptoms.

// Reads /proc/sys/user/max_user_namespaces. Linux-only — non-Linux
// platforms get an 'ok' with "not applicable" so the check appears
// in the output without bloating the failure count. Missing file
// (very old kernel < 4.18 or admin-disabled feature) → fail with
// a remediation hint pointing at the relevant sysctl.
const userNamespacesCheck = (readFile: (path: string) => string | null): DoctorCheck => {
  if (nodePlatform() !== 'linux') {
    return {
      name: 'user_namespaces',
      status: 'ok',
      detail: 'not applicable on this platform',
    };
  }
  const content = readFile('/proc/sys/user/max_user_namespaces');
  if (content === null) {
    return {
      name: 'user_namespaces',
      status: 'fail',
      detail: '/proc/sys/user/max_user_namespaces missing (kernel < 4.18 or feature absent)',
      remediation:
        'upgrade kernel to ≥ 4.18 or enable CONFIG_USER_NS; bwrap requires user namespaces',
    };
  }
  const max = Number.parseInt(content.trim(), 10);
  if (!Number.isFinite(max)) {
    return {
      name: 'user_namespaces',
      status: 'warn',
      detail: `unexpected /proc/sys/user/max_user_namespaces content: ${JSON.stringify(content.trim())}`,
    };
  }
  if (max < 1) {
    return {
      name: 'user_namespaces',
      status: 'fail',
      detail: `disabled (max_user_namespaces=${max})`,
      remediation: 'enable via `sudo sysctl -w user.max_user_namespaces=15000`',
    };
  }
  return {
    name: 'user_namespaces',
    status: 'ok',
    detail: `enabled (max=${max})`,
  };
};

// Detects nftables presence + version. Linux-only — affects the
// `cwd-rw-net` profile (slice 47 wires net egress filtering via
// nft). Absent on Linux → warn (the net-profile gates degrade to
// host instead of being unreachable, which the operator should
// know about). Non-Linux → ok 'not applicable'.
const netFilteringCheck = (
  which: (cmd: string) => string | null,
  runCmd: (cmd: string, args: readonly string[]) => string | null,
): DoctorCheck => {
  if (nodePlatform() !== 'linux') {
    return {
      name: 'net_filtering',
      status: 'ok',
      detail: 'not applicable on this platform',
    };
  }
  const nftPath = which('nft');
  if (nftPath === null) {
    return {
      name: 'net_filtering',
      status: 'warn',
      detail: 'nft not found on $PATH',
      remediation:
        'install nftables (`apt install nftables` or distro equivalent) to enable the cwd-rw-net sandbox profile',
    };
  }
  const versionOut = runCmd('nft', ['--version']);
  if (versionOut === null) {
    return {
      name: 'net_filtering',
      status: 'warn',
      detail: `nft at ${nftPath} but version probe failed`,
    };
  }
  // `nft --version` output shape: `nftables v1.0.9 (Old Doc Yak)`.
  // Extract the v… token if present; otherwise pass the first line
  // verbatim.
  const firstLine = versionOut.split('\n')[0] ?? '';
  const versionMatch = firstLine.match(/v[\d.]+/);
  const version = versionMatch !== null ? versionMatch[0] : firstLine.trim();
  return {
    name: 'net_filtering',
    status: 'ok',
    detail: `nftables ${version} at ${nftPath}`,
  };
};

// SELinux / AppArmor detection. Linux-only. Tries SELinux's
// `getenforce` first, then AppArmor's `aa-status`. If neither is
// installed/active → ok 'no LSM detected' (operator's choice).
// Enforce mode is reported as ok; complain/permissive mode emits
// a warn so operators know they don't have hard isolation.
//
// AppArmor's `aa-status` requires root for full output; we only
// need exit code + first line, which is non-privileged.
const macLsmCheck = (
  which: (cmd: string) => string | null,
  runCmd: (cmd: string, args: readonly string[]) => string | null,
): DoctorCheck => {
  if (nodePlatform() !== 'linux') {
    return {
      name: 'mac_lsm',
      status: 'ok',
      detail: 'not applicable on this platform',
    };
  }
  // SELinux path.
  const getEnforcePath = which('getenforce');
  if (getEnforcePath !== null) {
    const out = runCmd('getenforce', []);
    if (out !== null) {
      const mode = out.trim();
      if (mode === 'Enforcing') {
        return { name: 'mac_lsm', status: 'ok', detail: 'SELinux (Enforcing)' };
      }
      if (mode === 'Permissive' || mode === 'Disabled') {
        return {
          name: 'mac_lsm',
          status: 'warn',
          detail: `SELinux (${mode})`,
          remediation:
            mode === 'Permissive'
              ? 'consider Enforcing mode for stronger isolation (`sudo setenforce 1`)'
              : 'SELinux is installed but Disabled; enable it for stronger isolation',
        };
      }
      return { name: 'mac_lsm', status: 'warn', detail: `SELinux returned: ${mode}` };
    }
  }
  // AppArmor path. `aa-status --enabled` exits 0 if the kernel
  // has AppArmor enabled AND a Linux Security Module is loaded.
  // Non-zero exit is the COMMON case on stock distros (Fedora,
  // Arch) that ship the userspace `aa-status` binary without an
  // AppArmor LSM enabled in the kernel — pre-slice we returned a
  // "probe failed" warn, which was unhelpful (the probe didn't
  // fail; the kernel module just isn't loaded). Slice 123 (R9 P1):
  // surface that distinction. We still can't read aa-status's
  // exact exit code via the runCmd seam (which returns
  // string-or-null), but "non-zero exit on a host with the binary
  // present" is overwhelmingly the disabled-kernel-module case in
  // practice; the remediation hint walks operators through the
  // right diagnosis.
  const aaStatusPath = which('aa-status');
  if (aaStatusPath !== null) {
    const out = runCmd('aa-status', ['--enabled']);
    if (out !== null) {
      return { name: 'mac_lsm', status: 'ok', detail: 'AppArmor (enabled)' };
    }
    return {
      name: 'mac_lsm',
      status: 'warn',
      detail: 'AppArmor userspace present but kernel enforcement disabled',
      remediation:
        'verify with `aa-status` (exit 4 = no kernel support, exit 2 = module not loaded); enable AppArmor in the kernel or via `systemctl enable apparmor`',
    };
  }
  return {
    name: 'mac_lsm',
    status: 'ok',
    detail: 'no LSM detected (SELinux + AppArmor absent)',
  };
};

// Computes the sandbox profile ceiling — the maximum set of
// profiles the engine planner can reach on this host. Pure
// derivation from previously-checked state; doesn't probe again.
// Output mirrors §13.2's tier table: Linux-first-class →
// [ro, cwd-rw, cwd-rw-net, home-rw, host]; macOS-partial →
// [ro, cwd-rw, host]; everything else → [host].
const computeCapabilityCeiling = (
  sandboxAvailable: boolean,
  userNsOk: boolean,
): readonly SandboxProfile[] => {
  const platform = nodePlatform();
  if (platform === 'linux' && sandboxAvailable && userNsOk) {
    return ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw', 'host'];
  }
  if (platform === 'darwin' && sandboxAvailable) {
    return ['ro', 'cwd-rw', 'host'];
  }
  return ['host'];
};

// Reads the package.json once at module load. Production: the
// real installed version. Tests can override via the
// `engineVersion` option on runDoctor.
const PACKAGE_VERSION = ((): string => {
  try {
    const pkgPath = resolvePath(import.meta.dir, '../../package.json');
    const content = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

// §13.7 broker-mode honesty check. The earlier `sandbox` check
// reports whether the sandbox BINARY is present on the host. This
// check derives the next layer: given the binary's presence (or
// absence), what does the broker default actually do at boot?
//
// As of the broker default-flip slice, `bootstrap.ts:constructBroker`
// resolves `'spawn'` automatically when the host has a working
// sandbox tool, and `'in-process'` only as the no-sandbox fallback.
// Both source-checkout AND compiled-binary installs reach `'spawn'`
// (the compiled-binary self-exec via `FORJA_BROKER_WORKER=1`).
//
//   - sandbox binary present  → default broker resolves to `spawn`
//                               → bash spawns wrapped per the
//                               engine planner → `ok`.
//   - sandbox binary missing  → default falls back to `in-process`
//                               → bash runs unwrapped, engine
//                               permission floors are the only
//                               defense → `warn` with the
//                               actionable install hint.
//   - non-linux/non-darwin    → no sandbox tool ceiling; default
//                               `in-process` is the only option
//                               → `ok` "not applicable".
//
// The operator can still force `--broker in-process` to opt out of
// the spawn overhead; this check reports the DEFAULT path because
// that's the dominant case and the one operators most often miss.
// Forcing `--broker in-process` on a host with sandbox available
// remains a deliberate operator action, not a hidden default.
const sandboxEnforcementCheck = (
  which: (cmd: string) => string | null,
  exists?: (path: string) => boolean,
  stat?: (path: string) => { uid: number; mode: number } | null,
  isExecutable?: (path: string) => boolean,
): DoctorCheck => {
  const platform = nodePlatform();
  if (platform !== 'linux' && platform !== 'darwin') {
    return {
      name: 'sandbox_enforcement',
      status: 'ok',
      detail: 'not applicable on this platform (no sandbox tool ceiling)',
    };
  }
  // Re-probe availability directly so the verdict tracks the actual
  // presence of the binary, not the `sandbox` check's status field
  // (which is `warn` for BOTH binary-absent AND non-canonical-but-
  // present cases — different enforcement implications).
  const detectOpts: Parameters<typeof detectSandboxAvailability>[0] = { which };
  if (exists !== undefined) detectOpts.exists = exists;
  if (stat !== undefined) detectOpts.stat = stat;
  if (isExecutable !== undefined) detectOpts.isExecutable = isExecutable;
  const availability = detectSandboxAvailability(detectOpts);
  if (!availability.available) {
    return {
      name: 'sandbox_enforcement',
      status: 'warn',
      detail:
        'sandbox binary missing — broker default falls back to in-process; bash runs unwrapped',
      remediation:
        platform === 'linux'
          ? 'install bubblewrap (`apt install bubblewrap` or distro equivalent) to enable spawn-broker enforcement'
          : 'macOS ships sandbox-exec built-in; verify the binary is on $PATH',
    };
  }
  return {
    name: 'sandbox_enforcement',
    status: 'ok',
    detail: `${availability.tool ?? 'sandbox tool'} available; broker default resolves to spawn — bash spawns wrapped per engine planner`,
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
  const readFile = options.readFile ?? defaultReadFile;
  const runCmd = options.runCmd ?? defaultRunCmd;
  const engineVersion = options.engineVersion ?? PACKAGE_VERSION;
  const json = options.json === true;

  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;
  const dbPath = options.dbPath ?? defaultDbPath();
  // §13.8 60s cache for non-critical checks (slice 124). Production
  // uses a process-wide singleton so the harness's every-50-tool-
  // calls re-run hits cached entries; tests inject a fresh cache.
  const cache = options.cache ?? getSharedDoctorCache();
  // Snapshot `now` once for ALL cache-aware checks within this
  // runDoctor invocation. Each check sees the same "now" so a
  // cache entry that expired mid-loop doesn't get retroactively
  // refreshed only for some checks.
  const cacheNow = now();
  // §13.3 platform / kernel block. Order matches the spec's
  // example output: OS, user namespaces, sandbox binary, net
  // filtering, MAC LSM — the kernel-side stack the engine
  // depends on, top to bottom.
  //
  // Critical checks (sandbox, config_dir, data_dir, policy_load,
  // hash_chain, sealing) bypass the cache and ALWAYS run live.
  // Non-critical (platform, user_namespaces, net_filtering,
  // mac_lsm, git) get the 60s cache treatment per §13.8.
  const sandboxResult = sandboxCheck(which, options.exists, options.stat, options.isExecutable); // critical
  const userNsResult = withDoctorCache(
    'user_namespaces',
    () => userNamespacesCheck(readFile),
    cache,
    cacheNow,
  );
  const checks: DoctorCheck[] = [
    withDoctorCache('platform', () => platformCheck(env), cache, cacheNow),
    userNsResult,
    sandboxResult,
    withDoctorCache('net_filtering', () => netFilteringCheck(which, runCmd), cache, cacheNow),
    withDoctorCache('mac_lsm', () => macLsmCheck(which, runCmd), cache, cacheNow),
    configDirCheck(env),
    dataDirCheck(env),
    policyLoadCheck({
      env,
      cwd,
      ...(options.enterprisePath !== undefined ? { enterprisePath: options.enterprisePath } : {}),
      ...(options.userPath !== undefined ? { userPath: options.userPath } : {}),
    }),
    chainCheck({ env, dbPath }),
    mcpCheck({ dbPath }),
    // §13.7 enforcement honesty — re-probes sandbox availability
    // locally (not derived from `sandboxResult`, see the check's
    // header for the reasoning) and the compiled-binary signature.
    // Critical (not cached): availability can change between runs
    // (binary installed/removed, host trust posture). The
    // compiled-binary flag is stable within a process but the
    // probe is cheap so caching adds no value.
    sandboxEnforcementCheck(which, options.exists, options.stat, options.isExecutable),
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
    withDoctorCache('git', () => gitCheck(which), cache, cacheNow),
  ];

  // §13.3 derived footer items.
  //   - Capability ceiling: which sandbox profiles are reachable
  //     given the platform + sandbox-binary + user-namespaces
  //     state. Pure derivation; no extra probing.
  //   - Engine version: read once at module load from
  //     package.json (production) or overridden by tests.
  // Slice 170 (review — wrong-info P1): pre-slice this gated on
  // `sandboxResult.status === 'ok'`. After slice 165, doctor returns
  // `status='warn'` for non-canonical sandbox (Nix/Homebrew install)
  // — the planner still picks the sandboxed profiles, but doctor's
  // ceiling collapsed to `[host]`, falsely claiming the install was
  // downgraded to host-passthrough. Gate on availability (not on
  // the trust-marker warn), so the ceiling reflects the actual
  // engine planner state. `userNsResult` stays strict: its `warn`
  // means "couldn't parse max_user_namespaces" — genuine uncertainty
  // about whether bwrap will start, not a trust-only marker.
  const capabilityCeiling = computeCapabilityCeiling(
    sandboxResult.status !== 'fail',
    userNsResult.status === 'ok',
  );

  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const okCount = checks.filter((c) => c.status === 'ok').length;

  if (json) {
    for (const c of checks) {
      out(`${JSON.stringify({ kind: 'check', ...c })}\n`);
    }
    out(
      `${JSON.stringify({
        kind: 'info',
        engine_version: engineVersion,
        capability_ceiling: capabilityCeiling,
        profile: activeProfile(env),
      })}\n`,
    );
    out(
      `${JSON.stringify({
        kind: 'summary',
        ok: failCount === 0,
        counts: { ok: okCount, warn: warnCount, fail: failCount },
      })}\n`,
    );
    return failCount === 0 ? 0 : 1;
  }

  // Plain text: one block per check, blank line between, footer
  // info, then summary footer.
  const blocks: string[] = [];
  for (const c of checks) {
    blocks.push(renderCheckPlain(c).join('\n'));
  }
  out(`${blocks.join('\n\n')}\n\n`);
  // §13.3 derived info — capability ceiling + engine version.
  // Always rendered (informational, not pass/fail signals).
  out(`capability ceiling: [${capabilityCeiling.join(', ')}]\n`);
  out(`engine version: ${engineVersion}\n`);
  // Profile namespace — only printed when active, so default installs see no
  // extra noise. A non-null value means every dir above is the isolated
  // `forja-<profile>` variant, not the operator's real `forja` state.
  const profile = activeProfile(env);
  if (profile !== null) {
    out(`profile: ${profile} (isolated namespace — not your default forja state)\n`);
  }
  out('\n');
  if (failCount === 0 && warnCount === 0) {
    out('summary: all checks passed\n');
  } else if (failCount === 0) {
    out(`summary: ${warnCount} warning(s) — review before continuing\n`);
  } else {
    out(`summary: ${failCount} failure(s), ${warnCount} warning(s) — engine cannot bootstrap\n`);
  }
  return failCount === 0 ? 0 : 1;
};
