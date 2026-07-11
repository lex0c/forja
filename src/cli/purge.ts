// `forja purge` handler. Spec: AGENTIC_CLI.md §2.1.2.
//
// Filesystem-only project-scope reset: removes everything under
// <repoRoot>/.forja/, never touching the global DB
// (~/.local/share/forja/sessions.db) or user-layer configs
// (~/.config/forja/**). Two-phase: bare invocation is dry-run
// (no FS mutation, no DB write); --force executes after writing an
// append-only purge_events audit row to the global DB.
//
// Why filesystem-only: the global DB's sessions / approvals_log /
// memory_events for this cwd remain queryable after the purge —
// `forja --list-sessions --project <cwd>` continues to surface
// historical sessions. The audit chain stays intact because we
// never delete its rows, and `install_id` is preserved (genesis
// hash unchanged). Trade-off declared in §2.1.2.
//
// Hard-coded safeties:
//   1. Init marker required. <repoRoot>/.forja/ must exist AND
//      contain at least one of the 5 init-canonical artifacts
//      (permissions.yaml, config.toml, agents/, skills/, .gitignore).
//      Without this gate, `forja purge` typed in $HOME by accident
//      would happily destroy any `.forja/` that happens to be
//      sitting there.
//   2. Symlink defense. lstat-only on <repoRoot>/.forja/ and on
//      every entry beneath it. Symlinks are never followed; the
//      link itself is unlinked, the target is left alone. Without
//      this, `ln -s ~/shared-state .forja` followed by purge would
//      devastate ~/shared-state.
//   3. Audit before any FS mutation. --force opens the DB,
//      migrates if needed, inserts the audit row, AND ONLY THEN
//      enters the removal walker. If the DB is unwriteable,
//      --force aborts unless --no-audit is explicit (escape hatch
//      for emergencies with the FS reset still possible).

import {
  accessSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  readdirSync,
  rmdirSync,
  type Stats,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { appDirName, projectDirName } from '../config/app-namespace.ts';
import { resolveRepoRoot } from '../memory/paths.ts';
import { ensureInstallId } from '../permissions/install_id.ts';
import type { DB } from '../storage/index.ts';
import { closeDb, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { insertPurgeEvent } from '../storage/repos/purge-events.ts';
import { forjaCommand } from './forja-command.ts';
import { VERSION } from './version.ts';

// The five artifacts `forja init` scaffolds. Their presence (any
// one of them) gates the purge. Order is the same as the init
// orchestrator's DEFAULT_STEPS so the failure message lists them
// in a stable order operators can grep for in docs. `skills` is the
// project_shared/local skill catalog under `.forja/skills/`.
const INIT_MARKERS = [
  'permissions.yaml',
  '.gitignore',
  'config.toml',
  'playbooks',
  'skills',
] as const;

// Top-level categories rendered in the dry-run output. Order is
// chosen for operator legibility: configs first (what `init`
// scaffolded), then operator extensions, then memory, then
// runtime. Anything in `.forja/` not matching one of these falls
// into a generic "other" category so we never silently hide
// surprises from the operator.
interface PurgeCategory {
  // Display name as it appears in the dry-run (relative to .forja/).
  name: string;
  // Absolute path on disk.
  absolutePath: string;
  // 'file' for a regular file or symlink-to-file; 'dir' for a real
  // directory (we don't follow symlinks-to-dirs — those are
  // 'symlink'); 'symlink' for any symlink entry (target ignored).
  kind: 'file' | 'dir' | 'symlink';
  // Aggregated counts. For a 'file'/'symlink' category, files=1
  // dirs=0; for a 'dir' category, sums across all descendants.
  files: number;
  dirs: number;
  bytes: number;
  // Flag for the operator-owned warning on .gitignore.
  operatorOwned: boolean;
}

interface WalkResult {
  // All absolute paths enumerated (files + dirs + symlinks), sorted.
  // Persisted into purge_events.artifacts_present_json as canonical
  // JSON for forensic reconstruction.
  paths: string[];
  // Per-top-level categorization for the dry-run renderer.
  categories: PurgeCategory[];
  // Roll-ups across every category.
  totals: { files: number; dirs: number; bytes: number };
}

export interface RunPurgeOptions {
  cwd: string;
  force: boolean;
  json: boolean;
  noAudit: boolean;
  // Sinks. Production wires to stdout/stderr; tests inject collectors.
  out: (s: string) => void;
  err: (s: string) => void;
  // Test seam — override the global DB path so the suite uses an
  // in-memory or temp file DB instead of the operator's real one.
  dbPath?: string;
  // Test seam — fixed timestamp for audit-row ts. Production reads
  // Date.now() at the moment of insert.
  now?: () => number;
  // Test seam — override the TOCTOU verifier passed to removeTree's
  // walker. Production omits this and the walker uses the real
  // verifySamePostReaddir; tests inject a constant-false verifier
  // (to exercise the PurgeToctouError abort path) or a throwing
  // verifier (to exercise the generic mid-walk catch branch
  // without provoking a real FS permission failure). Symmetric
  // with the dbPath / now seams above.
  _verifierForTest?: (path: string, preStat: Stats) => boolean;
}

interface AuditWritability {
  writable: boolean;
  dbPath: string;
  reason?: string;
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// `.gitignore` is operator-owned post-`init` per MEMORY.md §2.5.
// Purge deletes it anyway (the operator is explicitly resetting
// the project), but the dry-run flags it so an operator who edited
// it confirms intentionally. Distinct from a hard refusal — that
// would frustrate the "as if Forja never ran" goal of the verb.
const OPERATOR_OWNED_NAMES = new Set(['.gitignore']);

// Walks `.forja/` with lstat at every entry. Symlinks are recorded
// as 'symlink' kind (count as files for the dirs/files split) and
// NOT recursed into — their target lives outside our purge root by
// adversarial construction. Real directories are recursed.
const walkAgentDir = (agentDir: string): WalkResult => {
  const paths: string[] = [];
  const categories: PurgeCategory[] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;

  const visitInside = (
    dirAbs: string,
    cat: { files: number; dirs: number; bytes: number },
  ): void => {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      // Permission-denied / vanished mid-walk: best-effort skip.
      // The remove path will surface a clearer error if it hits the
      // same entry; the dry-run shouldn't synthesize fake numbers.
      return;
    }
    entries.sort();
    for (const name of entries) {
      const abs = join(dirAbs, name);
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        // Vanished between readdir and lstat — skip entirely; do
        // NOT push into `paths` (otherwise artifacts_present_json
        // would list an entry that contributed zero to totals,
        // confusing forensic readers).
        continue;
      }
      paths.push(abs);
      if (st.isSymbolicLink()) {
        cat.files += 1;
        cat.bytes += st.size;
        totalFiles += 1;
        totalBytes += st.size;
        continue;
      }
      if (st.isDirectory()) {
        cat.dirs += 1;
        totalDirs += 1;
        visitInside(abs, cat);
        continue;
      }
      // Regular file (or other non-directory non-symlink — block
      // device, fifo. We classify all as files for accounting; the
      // remove path uses unlinkSync which works for everything but
      // dirs).
      cat.files += 1;
      cat.bytes += st.size;
      totalFiles += 1;
      totalBytes += st.size;
    }
  };

  let topLevel: string[];
  try {
    topLevel = readdirSync(agentDir);
  } catch {
    return {
      paths: [],
      categories: [],
      totals: { files: 0, dirs: 0, bytes: 0 },
    };
  }
  topLevel.sort();
  for (const name of topLevel) {
    const abs = join(agentDir, name);
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      // Same posture as the inner loop: skip if it vanished
      // between readdir and lstat. Don't push into `paths`.
      continue;
    }
    paths.push(abs);
    if (st.isSymbolicLink()) {
      categories.push({
        name,
        absolutePath: abs,
        kind: 'symlink',
        files: 1,
        dirs: 0,
        bytes: st.size,
        operatorOwned: OPERATOR_OWNED_NAMES.has(name),
      });
      totalFiles += 1;
      totalBytes += st.size;
      continue;
    }
    if (st.isDirectory()) {
      const cat = { files: 0, dirs: 0, bytes: 0 };
      totalDirs += 1;
      visitInside(abs, cat);
      categories.push({
        name: `${name}/`,
        absolutePath: abs,
        kind: 'dir',
        files: cat.files,
        dirs: cat.dirs + 1,
        bytes: cat.bytes,
        operatorOwned: false,
      });
      continue;
    }
    categories.push({
      name,
      absolutePath: abs,
      kind: 'file',
      files: 1,
      dirs: 0,
      bytes: st.size,
      operatorOwned: OPERATOR_OWNED_NAMES.has(name),
    });
    totalFiles += 1;
    totalBytes += st.size;
  }
  paths.sort();
  return {
    paths,
    categories,
    totals: { files: totalFiles, dirs: totalDirs, bytes: totalBytes },
  };
};

const hasInitMarker = (agentDir: string): boolean => {
  for (const marker of INIT_MARKERS) {
    if (existsSync(join(agentDir, marker))) return true;
  }
  return false;
};

// TOCTOU defense: between the pre-readdir lstat and the readdir
// itself, an adversary with concurrent FS access could replace the
// directory with a symlink to an external path. Because readdirSync
// follows symlinks, the walker would then list (and subsequently
// delete) entries from the symlink target — outside `.forja/`,
// defeating the top-of-walk symlink defense.
//
// This helper re-runs lstat AFTER readdir and verifies the path
// still points at the same real directory. Identity check requires
// BOTH `dev` AND `ino` to match — inode numbers are only unique
// per filesystem, so a cross-device swap (e.g., adversary mounts a
// crafted FS at the path with a directory whose ino collides with
// the original) would pass an ino-only check. The dev+ino pair is
// the kernel-level unique identifier across all mounts.
//
// Residual race: adversary can still swap between this re-stat and
// the per-child walkRemove call. That window is much narrower
// (microseconds between two FS syscalls in the same process) and
// requires winning a tight scheduling race; documented but not
// closed by this fix. A fully race-free walk requires fd-based
// directory iteration (opendir over an O_NOFOLLOW fd) which Node's
// public fs API doesn't expose — would need OS-level primitives.
export const verifySamePostReaddir = (path: string, preStat: Stats): boolean => {
  let stAfter: Stats;
  try {
    stAfter = lstatSync(path);
  } catch {
    // Vanished between readdir and this lstat — treat as not-same
    // (don't recurse into a path that's no longer there).
    return false;
  }
  return (
    stAfter.isDirectory() &&
    !stAfter.isSymbolicLink() &&
    stAfter.ino === preStat.ino &&
    stAfter.dev === preStat.dev
  );
};

// Thrown when verifySamePostReaddir reports a concurrent FS swap
// during the walk. Carries the offending path AND the partial
// removal counts captured up to the abort point, so runPurge can
// distinguish the two operational shapes:
//
//   - partial == {0,0,0}: TOCTOU triggered before ANY removal (e.g.,
//     race against the root `.forja/` itself). FS state unchanged.
//   - partial > 0: TOCTOU triggered mid-walk after some children
//     were already removed. FS is in a partial state.
//
// Operator action differs: in the second case, the project is
// genuinely half-purged; in the first case, the project is intact
// but the audit row already landed (because runPurge writes audit
// BEFORE entering the removal walker).
//
// Previously walkRemove only emitted a stderr line and returned —
// which meant a root-level TOCTOU swallowed the abort signal,
// removeTree returned {0,0,0}, and runPurge reported success
// (exit 0) despite removing nothing. That silent-success bug
// violated --force semantics. The throw discipline here surfaces
// every TOCTOU detection as a real failure (exit 1) regardless of
// where in the walk it triggers.
export class PurgeToctouError extends Error {
  readonly path: string;
  readonly partial: { files: number; dirs: number; bytes: number };
  constructor(path: string, partial: { files: number; dirs: number; bytes: number }) {
    super(
      `refusing to descend into ${path} — concurrent FS modification detected (lstat/readdir TOCTOU)`,
    );
    this.name = 'PurgeToctouError';
    this.path = path;
    this.partial = partial;
  }
}

// Options for `removeTree`. The verifier is exposed as an override
// purely for tests — production omits it and the walker uses the
// real `verifySamePostReaddir`. A racy TOCTOU can't be reproduced
// deterministically in a unit test without injection, so this seam
// lets the abort path be pinned without flaky scheduling.
export interface RemoveTreeOptions {
  verifier?: (path: string, preStat: Stats) => boolean;
}

// Removes a tree rooted at `target`, lstat-aware. Symlinks are
// unlinked (the link itself, not its target). Real directories are
// recursed then rmdir'd. Other entries are unlinked.
//
// Throws `PurgeToctouError` (which the caller MUST catch and
// surface as exit 1) when the verifier detects a concurrent FS
// modification during the walk. See class header for the
// partial-state semantics.
//
// Returns the actually-removed counts so the force path can
// confirm the dry-run numbers (typically identical; differs only
// when the FS changes between enumeration and removal).
//
// Exported for tests; runPurge is the only production caller.
export const removeTree = (
  target: string,
  options: RemoveTreeOptions = {},
): { files: number; dirs: number; bytes: number } => {
  const verifier = options.verifier ?? verifySamePostReaddir;
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const walkRemove = (path: string): void => {
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      bytes += st.size;
      files += 1;
      unlinkSync(path);
      return;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        entries = [];
      }
      // TOCTOU re-check: confirm the path is still the same real
      // directory we lstat'd above. If a concurrent process swapped
      // it for a symlink between lstat and readdir, ABORT THE
      // ENTIRE WALK — readdirSync follows symlinks, so the entries
      // listed might belong to an external target. Recursing would
      // delete files outside `.forja/`.
      //
      // Throw (don't merely return) so the caller sees a real
      // failure regardless of where in the tree this triggers. The
      // partial counts captured up to this point let runPurge tell
      // the operator whether the FS is intact (root abort) or
      // half-purged (mid-tree abort).
      if (!verifier(path, st)) {
        throw new PurgeToctouError(path, { files, dirs, bytes });
      }
      for (const name of entries) walkRemove(join(path, name));
      rmdirSync(path);
      dirs += 1;
      return;
    }
    bytes += st.size;
    files += 1;
    unlinkSync(path);
  };
  walkRemove(target);
  return { files, dirs, bytes };
};

// Check whether the global DB is writable for audit. Production
// (--force) path: open + migrate + close. Migrate is idempotent
// (a 64-rev chain on first install, a no-op on subsequent runs).
// A throw at open / migrate is the signal that audit cannot
// proceed.
//
// We deliberately do NOT keep the DB open here — the caller may
// not need it (--no-audit). Keep the open scope tight.
//
// MUTATING: this probe opens (creating the DB file if absent) and
// runs migrate. ONLY use on the --force path. Dry-run must call
// `probeAuditWritabilityNonMutating` below instead.
const probeAuditWritabilityMutating = (dbPath: string): AuditWritability => {
  let db: DB | null = null;
  try {
    db = openDb(dbPath);
    migrate(db);
    return { writable: true, dbPath };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { writable: false, dbPath, reason };
  } finally {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore close error after probe — we got our answer
      }
    }
  }
};

// Non-mutating writability probe for the dry-run path. Critical
// invariant: `forja purge` (without --force) must NEVER create the
// DB file, mutate its schema, or apply migrations. The dry-run
// header literally promises "nothing will be modified" — any DB
// side-effect violates that contract.
//
// Strategy: check existence + parent directory writability via
// fs.access (W_OK). When the DB file already exists, we assume it
// was writable last time (the actual write attempt during --force
// surfaces real failures). When the file doesn't exist yet, we
// check the parent dir is writable so --force can create it.
//
// Trade-off: a chmod 0444 DB file with a writable parent reports
// writable=true here but fails at --force. Acceptable — the
// real failure surfaces with a clear message at force time, and
// dry-run avoiding the mutation is the load-bearing property.
const probeAuditWritabilityNonMutating = (dbPath: string): AuditWritability => {
  if (existsSync(dbPath)) {
    // DB exists. Probe parent writability as a soft signal — a
    // tightened parent dir (rare) would be the most likely
    // reason the next write fails.
    try {
      accessSync(dirname(dbPath), fsConstants.W_OK);
      return { writable: true, dbPath };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { writable: false, dbPath, reason };
    }
  }
  // DB doesn't exist yet — --force will create it. Need writable
  // parent (or grandparent reachable via openDb's mkdir-on-create).
  const parent = dirname(dbPath);
  if (existsSync(parent)) {
    try {
      accessSync(parent, fsConstants.W_OK);
      return { writable: true, dbPath };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { writable: false, dbPath, reason };
    }
  }
  // Parent doesn't exist. --force's openDb path will mkdir
  // recursively; assume writable unless we can prove otherwise.
  // The actual mkdir-then-open at force time surfaces failures.
  return { writable: true, dbPath };
};

const renderHumanDryRun = (report: DryRunReport, out: (s: string) => void): void => {
  out('forja purge — DRY RUN (nothing will be modified)\n\n');
  out(`Project root: ${report.repoRoot}\n`);
  out(`Scope:        ${report.scope}/\n\n`);
  if (report.categories.length === 0) {
    out('  (.forja/ is empty)\n\n');
  } else {
    out('Will remove:\n');
    for (const c of report.categories) {
      const suffix =
        c.kind === 'dir'
          ? `${c.files} files, ${formatBytes(c.bytes)}`
          : c.kind === 'symlink'
            ? `symlink, ${formatBytes(c.bytes)}`
            : formatBytes(c.bytes);
      const flag = c.operatorOwned ? '   [operator-owned — confirm before --force]' : '';
      // Align: name padded to 50 chars then size.
      const namePad = c.name.length < 48 ? c.name.padEnd(48) : `${c.name} `;
      out(`  ${report.scope}/${namePad}${suffix}${flag}\n`);
    }
    out(
      `Total: ${report.totals.files} files, ${report.totals.dirs} directories, ${formatBytes(report.totals.bytes)}\n\n`,
    );
  }
  out('Preserved (will NOT be touched):\n');
  for (const p of report.preserved) {
    out(`  ${p}\n`);
  }
  out('\n');
  if (report.audit.writable) {
    out(`Audit will be recorded in purge_events at: ${report.audit.dbPath}\n\n`);
  } else {
    out(
      `WARNING: global DB at ${report.audit.dbPath} is not writable (${report.audit.reason ?? 'unknown'}).\n`,
    );
    out(
      '         --force will abort unless --no-audit is passed (purge proceeds without audit row).\n\n',
    );
  }
  out(`To execute:\n  ${report.command}\n`);
};

const renderHumanForce = (report: ForceReport, out: (s: string) => void): void => {
  out('forja purge — done\n\n');
  out(`Project root: ${report.repoRoot}\n`);
  out(`Scope:        ${report.scope}/\n\n`);
  out(
    `Removed: ${report.removed.files} files, ${report.removed.dirs} directories, ${formatBytes(report.removed.bytes)}\n`,
  );
  if (report.auditId !== null) {
    out(`Audit row:  purge_events.id = ${report.auditId}\n`);
  } else {
    out('Audit row:  none (--no-audit)\n');
  }
};

interface DryRunReport {
  mode: 'dry-run';
  repoRoot: string;
  scope: string;
  categories: PurgeCategory[];
  totals: { files: number; dirs: number; bytes: number };
  preserved: string[];
  audit: AuditWritability;
  command: string;
}

interface ForceReport {
  mode: 'force';
  repoRoot: string;
  scope: string;
  removed: { files: number; dirs: number; bytes: number };
  auditId: number | null;
  auditWritable: boolean;
}

// Paths the operator should know are explicitly preserved. Shown in
// every dry-run regardless of whether they exist — making the
// contract observable (the operator doesn't need to grep for
// "what's NOT touched").
//
// A function (not a const) so the user-level segment is resolved at call time
// — under `--profile dev` the dry-run names `~/.local/share/forja-dev/...` and
// `~/.config/forja-dev/**`, matching where this run's state actually lives
// (purge only ever touches the project `.forja[-<profile>]/` dir).
const preservedPaths = (): string[] => {
  const app = appDirName();
  return [
    `~/.local/share/${app}/sessions.db    (global DB; sessions for this cwd remain queryable)`,
    `~/.config/${app}/**                  (user-layer config + memory)`,
    `~/.local/share/${app}/install_id     (install identity; audit chain genesis)`,
  ];
};

export const runPurge = async (options: RunPurgeOptions): Promise<number> => {
  const { cwd, force, json, noAudit, out, err } = options;
  const repoRoot = resolveRepoRoot(cwd);
  const agentDir = join(repoRoot, projectDirName());

  // Gate 1: directory exists.
  if (!existsSync(agentDir)) {
    err(
      `forja purge: ${agentDir} does not exist — nothing to purge (run '${forjaCommand('init')}' to scaffold it first)\n`,
    );
    return 1;
  }

  // Gate 2: symlink defense. lstat (NOT stat) so we see the link,
  // not what it points to. Refusing here is the right move — any
  // symlink shape at <repoRoot>/.forja suggests the operator
  // deliberately wired the project to share state from elsewhere,
  // and we will not silently destroy that target.
  let agentSt: Stats;
  try {
    agentSt = lstatSync(agentDir);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    err(`forja purge: cannot stat ${agentDir}: ${reason}\n`);
    return 1;
  }
  if (agentSt.isSymbolicLink()) {
    err(
      `forja purge: ${agentDir} is a symlink — refusing to follow. Remove the link manually if intended.\n`,
    );
    return 1;
  }
  if (!agentSt.isDirectory()) {
    err(`forja purge: ${agentDir} is not a directory (kind: ${describeStat(agentSt)})\n`);
    return 1;
  }

  // Gate 3: init marker. Avoids "operator typed `forja purge` in
  // $HOME by accident" and "this .forja/ was planted by another
  // tool". Permissive: any ONE of the five markers is enough.
  if (!hasInitMarker(agentDir)) {
    err(
      `forja purge: ${agentDir} has no init markers — run '${forjaCommand('init')}' first or remove ${projectDirName()}/ manually if you didn't initialize this project\n`,
    );
    err(`  (looked for: ${INIT_MARKERS.map((m) => join(agentDir, m)).join(', ')})\n`);
    return 1;
  }

  // Enumerate everything we WOULD remove. Used by both dry-run
  // (render) and force (compare against actual removal).
  const walk = walkAgentDir(agentDir);

  // Probe DB writability. Three-way gate:
  //
  //   1. --no-audit set → SKIP the probe entirely. Synthesize an
  //      audit object describing the opt-out. Critical for fresh
  //      installs: operator opting out of audit logging shouldn't
  //      have their `~/.local/share/forja/sessions.db` created
  //      as a side effect of the probe. Same load-bearing
  //      "no DB dependency" property the operator expects when
  //      they pass --no-audit.
  //
  //   2. Force + audit wanted → mutating probe (open + migrate).
  //      We need the schema in place for the upcoming audit row
  //      write anyway.
  //
  //   3. Dry-run + audit observable → non-mutating probe (pure
  //      FS check). Dry-run must not create the file or apply
  //      migrations; warning if the parent dir isn't writable
  //      so the operator gets feedback before opting into
  //      --force.
  const dbPath = options.dbPath ?? defaultDbPath();
  const audit: AuditWritability = noAudit
    ? { writable: false, dbPath, reason: 'skipped (--no-audit; DB not probed)' }
    : force
      ? probeAuditWritabilityMutating(dbPath)
      : probeAuditWritabilityNonMutating(dbPath);

  // ────────────────────────────────────────────────────────────
  // Dry-run path
  // ────────────────────────────────────────────────────────────
  if (!force) {
    // Suggested command must be directly executable AND hit the SAME namespace
    // the dry-run reported. `forjaCommand` re-prefixes the active `--profile`
    // (else a bare `forja purge --force` would purge the canonical `.forja/`,
    // not the `.forja-<profile>/` just previewed). `--no-audit` is preserved
    // because an operator who ran it (DB broken — the emergency the flag exists
    // for) must not be handed a `--force` that re-hits the audit gate.
    const command = forjaCommand(`purge --force${noAudit ? ' --no-audit' : ''}`);
    const report: DryRunReport = {
      mode: 'dry-run',
      repoRoot,
      scope: agentDir,
      categories: walk.categories,
      totals: walk.totals,
      preserved: preservedPaths(),
      audit,
      command,
    };
    if (json) {
      out(`${JSON.stringify(serializeDryRun(report))}\n`);
    } else {
      renderHumanDryRun(report, out);
    }
    return 0;
  }

  // ────────────────────────────────────────────────────────────
  // Force path
  // ────────────────────────────────────────────────────────────

  // Audit gate. `--no-audit` is the PRIMARY opt-out — when set,
  // we skip the audit-row write entirely regardless of DB
  // writability. Pre-fix, this branch only fired when the DB was
  // unwritable, meaning `forja purge --force --no-audit` on a
  // healthy DB still wrote a row (operator-reported bug:
  // contradicts the documented "opt out of audit logging" intent).
  //
  // Default path (no --no-audit): we MUST write the audit row.
  // If the DB is unwritable, abort before any FS removal so the
  // operator either fixes the DB or explicitly opts out via
  // --no-audit. If the write itself fails (race between probe and
  // insert), same abort posture — never silently remove without
  // the forensic trail.
  let auditId: number | null = null;
  if (noAudit) {
    // Probe was skipped entirely (DB not touched). Single uniform
    // message — operator who passed --no-audit knows the DB state
    // wasn't even queried.
    err('forja purge: --no-audit set; audit row skipped (DB not probed)\n');
  } else {
    if (!audit.writable) {
      err(
        `forja purge: cannot write audit row to DB (${audit.reason ?? 'unknown'}); pass --no-audit to bypass\n`,
      );
      return 1;
    }
    try {
      auditId = writeAuditRow({
        dbPath,
        repoRoot,
        artifacts: walk.paths,
        totals: walk.totals,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      err(`forja purge: audit write failed (${reason}); aborting before FS removal\n`);
      return 1;
    }
  }

  // Atomic-ish FS removal. We remove the contents of `.forja/`
  // first, then remove the directory itself last. Removing
  // contents-first means a kill mid-walk leaves a partial state
  // but the parent dir still exists — recoverable. Removing
  // parent-first would leave orphan subtrees with no way to find
  // them via the project root.
  let removed: { files: number; dirs: number; bytes: number };
  try {
    removed = removeTree(
      agentDir,
      options._verifierForTest !== undefined ? { verifier: options._verifierForTest } : {},
    );
  } catch (e) {
    // TOCTOU aborts get a distinct rendering so the operator
    // doesn't conflate "another process raced us" with the more
    // mundane FS errors (EBUSY, EACCES mid-walk). Carries the
    // partial-state counts so an operator inspecting the project
    // can compare against the audit row's "what was here" snapshot.
    if (e instanceof PurgeToctouError) {
      const auditNote = !options.noAudit && audit.writable;
      err(`forja purge: ${e.message}; aborting at ${e.path}\n`);
      const hasPartial = e.partial.files > 0 || e.partial.dirs > 0;
      if (hasPartial) {
        err(
          `  Partial state: ${e.partial.files} file(s) / ${e.partial.dirs} dir(s) / ${formatBytes(e.partial.bytes)} removed before the abort\n`,
        );
      } else {
        err('  No files were removed (TOCTOU detected before any removal)\n');
      }
      if (auditNote) {
        err(`  Audit row was already written (id=${auditId ?? 'unknown'})\n`);
      }
      err(
        '  INVESTIGATE: another process modified the filesystem during the walk. Identify and stop it before retrying purge.\n',
      );
      return 1;
    }
    // Generic FS failure (EBUSY, EACCES, ENOSPC mid-walk, etc.).
    // The audit message is gated on whether a row was actually
    // written: under --no-audit the probe was skipped entirely
    // (line ~720) and no row exists, so claiming otherwise would
    // send incident-response investigators chasing a nonexistent
    // DB entry. Same gating discipline as the TOCTOU branch above.
    const reason = e instanceof Error ? e.message : String(e);
    err(`forja purge: FS removal failed mid-walk: ${reason}\n`);
    err('  The project is in a partial state\n');
    if (!noAudit && audit.writable) {
      err(`  Audit row was already written (id=${auditId ?? 'unknown'})\n`);
    }
    return 1;
  }

  const forceReport: ForceReport = {
    mode: 'force',
    repoRoot,
    scope: agentDir,
    removed,
    auditId,
    auditWritable: audit.writable,
  };
  if (json) {
    out(`${JSON.stringify(serializeForce(forceReport))}\n`);
  } else {
    renderHumanForce(forceReport, out);
  }
  return 0;
};

// Stat → human kind for the error message when `.forja` is neither
// a directory nor a symlink (very rare, but possible: a regular
// file named `.forja`, a fifo, a device node).
const describeStat = (st: Stats): string => {
  if (st.isFile()) return 'regular file';
  if (st.isBlockDevice()) return 'block device';
  if (st.isCharacterDevice()) return 'character device';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  return 'unknown';
};

interface WriteAuditRowInput {
  dbPath: string;
  repoRoot: string;
  artifacts: string[];
  totals: { files: number; dirs: number; bytes: number };
  now?: () => number;
}

// Encapsulates the open → migrate → insert → close lifecycle for
// the audit row. Failures bubble up to runPurge so it can decide
// whether to honor --no-audit. The DB is closed in `finally` so
// even thrown errors don't leak the handle into the FS removal
// path that follows.
const writeAuditRow = (input: WriteAuditRowInput): number => {
  let db: DB | null = null;
  try {
    db = openDb(input.dbPath);
    migrate(db);
    const identity = ensureInstallId({ env: process.env });
    const ts = (input.now ?? Date.now)();
    // Sorted paths so canonical JSON is byte-stable across
    // invocations enumerating the same tree. Helpful for future
    // forensic comparison ("did this purge remove the same files
    // as that one?").
    const sorted = [...input.artifacts].sort();
    const row = insertPurgeEvent(db, {
      ts,
      install_id: identity.install_id,
      cwd: input.repoRoot,
      artifacts_present_json: JSON.stringify(sorted),
      bytes_present: input.totals.bytes,
      files_present: input.totals.files,
      dirs_present: input.totals.dirs,
      forja_version: VERSION,
    });
    return row.id;
  } finally {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore close error — the insert (if it succeeded) is
        // already committed; the close failure is informational
        // only.
      }
    }
  }
};

// Public serializers for --json output. Pure data, no rendering —
// the human renderers above format the same fields. Tests assert
// against these shapes directly.
export const serializeDryRun = (report: DryRunReport): object => ({
  mode: report.mode,
  repoRoot: report.repoRoot,
  scope: report.scope,
  categories: report.categories.map((c) => ({
    name: c.name,
    absolutePath: c.absolutePath,
    kind: c.kind,
    files: c.files,
    dirs: c.dirs,
    bytes: c.bytes,
    operatorOwned: c.operatorOwned,
  })),
  totals: report.totals,
  preserved: report.preserved,
  audit: {
    writable: report.audit.writable,
    dbPath: report.audit.dbPath,
    ...(report.audit.reason !== undefined ? { reason: report.audit.reason } : {}),
  },
  command: report.command,
});

export const serializeForce = (report: ForceReport): object => ({
  mode: report.mode,
  repoRoot: report.repoRoot,
  scope: report.scope,
  removed: report.removed,
  auditId: report.auditId,
  auditWritable: report.auditWritable,
});

// Re-exports for tests pinning behavior at module boundary.
// Public surface is intentionally narrow: the runner, the
// init-marker constant (for test fixtures), and the serializers.
export { INIT_MARKERS };
