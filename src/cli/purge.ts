// `agent purge` handler. Spec: AGENTIC_CLI.md §2.1.2.
//
// Filesystem-only project-scope reset: removes everything under
// <repoRoot>/.agent/, never touching the global DB
// (~/.local/share/forja/sessions.db) or user-layer configs
// (~/.config/agent/**). Two-phase: bare invocation is dry-run
// (no FS mutation, no DB write); --force executes after writing an
// append-only purge_events audit row to the global DB.
//
// Why filesystem-only: the global DB's sessions / approvals_log /
// memory_events for this cwd remain queryable after the purge —
// `agent --list-sessions --project <cwd>` continues to surface
// historical sessions. The audit chain stays intact because we
// never delete its rows, and `install_id` is preserved (genesis
// hash unchanged). Trade-off declared in §2.1.2.
//
// Hard-coded safeties:
//   1. Init marker required. <repoRoot>/.agent/ must exist AND
//      contain at least one of the 4 init-canonical artifacts
//      (permissions.yaml, config.toml, agents/, .gitignore).
//      Without this gate, `agent purge` typed in $HOME by accident
//      would happily destroy any `.agent/` that happens to be
//      sitting there.
//   2. Symlink defense. lstat-only on <repoRoot>/.agent/ and on
//      every entry beneath it. Symlinks are never followed; the
//      link itself is unlinked, the target is left alone. Without
//      this, `ln -s ~/shared-state .agent` followed by purge would
//      devastate ~/shared-state.
//   3. Audit before any FS mutation. --force opens the DB,
//      migrates if needed, inserts the audit row, AND ONLY THEN
//      enters the removal walker. If the DB is unwriteable,
//      --force aborts unless --no-audit is explicit (escape hatch
//      for emergencies with the FS reset still possible).

import { type Stats, existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoRoot } from '../memory/paths.ts';
import { ensureInstallId } from '../permissions/install_id.ts';
import { migrate, openDb } from '../storage/index.ts';
import type { DB } from '../storage/index.ts';
import { defaultDbPath } from '../storage/index.ts';
import { insertPurgeEvent } from '../storage/repos/purge-events.ts';
import { VERSION } from './version.ts';

// The four artifacts `agent init` scaffolds. Their presence (any
// one of them) gates the purge. Order is the same as the init
// orchestrator's DEFAULT_STEPS so the failure message lists them
// in a stable order operators can grep for in docs.
const INIT_MARKERS = ['permissions.yaml', '.gitignore', 'config.toml', 'agents'] as const;

// Top-level categories rendered in the dry-run output. Order is
// chosen for operator legibility: configs first (what `init`
// scaffolded), then operator extensions, then memory, then
// runtime. Anything in `.agent/` not matching one of these falls
// into a generic "other" category so we never silently hide
// surprises from the operator.
interface PurgeCategory {
  // Display name as it appears in the dry-run (relative to .agent/).
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

// Walks `.agent/` with lstat at every entry. Symlinks are recorded
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

// Removes a tree rooted at `target`, lstat-aware. Symlinks are
// unlinked (the link itself, not its target). Real directories are
// recursed then rmdir'd. Other entries are unlinked.
//
// Returns the actually-removed counts so the force path can
// confirm the dry-run numbers (typically identical; differs only
// when the FS changes between enumeration and removal).
const removeTree = (target: string): { files: number; dirs: number; bytes: number } => {
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
// path: open + migrate + close. Migrate is idempotent (a 64-rev
// chain on first install, a no-op on subsequent runs). A throw at
// open / migrate is the signal that audit cannot proceed.
//
// We deliberately do NOT keep the DB open here — the caller may
// not need it (dry-run, --no-audit). Keep the open scope tight.
const probeAuditWritability = (dbPath: string): AuditWritability => {
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
        db.close();
      } catch {
        // ignore close error after probe — we got our answer
      }
    }
  }
};

const renderHumanDryRun = (report: DryRunReport, out: (s: string) => void): void => {
  out('forja purge — DRY RUN (nothing will be modified)\n\n');
  out(`Project root: ${report.repoRoot}\n`);
  out(`Scope:        ${report.scope}/\n\n`);
  if (report.categories.length === 0) {
    out('  (.agent/ is empty)\n\n');
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
const PRESERVED_PATHS = [
  '~/.local/share/forja/sessions.db    (global DB; sessions for this cwd remain queryable)',
  '~/.config/agent/**                  (user-layer config + memory)',
  '~/.local/share/forja/install_id     (install identity; audit chain genesis)',
];

export const runPurge = async (options: RunPurgeOptions): Promise<number> => {
  const { cwd, force, json, noAudit, out, err } = options;
  const repoRoot = resolveRepoRoot(cwd);
  const agentDir = join(repoRoot, '.agent');

  // Gate 1: directory exists.
  if (!existsSync(agentDir)) {
    err(
      `forja purge: ${agentDir} does not exist — nothing to purge (run 'agent init' to scaffold it first)\n`,
    );
    return 1;
  }

  // Gate 2: symlink defense. lstat (NOT stat) so we see the link,
  // not what it points to. Refusing here is the right move — any
  // symlink shape at <repoRoot>/.agent suggests the operator
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

  // Gate 3: init marker. Avoids "operator typed `agent purge` in
  // $HOME by accident" and "this .agent/ was planted by another
  // tool". Permissive: any ONE of the four markers is enough.
  if (!hasInitMarker(agentDir)) {
    err(
      `forja purge: ${agentDir} has no init markers — run 'agent init' first or remove .agent/ manually if you didn't initialize this project\n`,
    );
    err(`  (looked for: ${INIT_MARKERS.map((m) => join(agentDir, m)).join(', ')})\n`);
    return 1;
  }

  // Enumerate everything we WOULD remove. Used by both dry-run
  // (render) and force (compare against actual removal).
  const walk = walkAgentDir(agentDir);

  // Probe DB writability. Dry-run uses the answer to warn; force
  // uses it to decide whether to abort.
  const dbPath = options.dbPath ?? defaultDbPath();
  const audit = probeAuditWritability(dbPath);

  // ────────────────────────────────────────────────────────────
  // Dry-run path
  // ────────────────────────────────────────────────────────────
  if (!force) {
    const report: DryRunReport = {
      mode: 'dry-run',
      repoRoot,
      scope: agentDir,
      categories: walk.categories,
      totals: walk.totals,
      preserved: PRESERVED_PATHS,
      audit,
      command: 'agent purge --force',
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

  // Audit gate. If the operator opted out via --no-audit, we
  // proceed without a row but warn loudly so it shows up in
  // captured stderr (CI logs, troubleshooting).
  let auditId: number | null = null;
  if (!audit.writable && !noAudit) {
    err(
      `forja purge: cannot write audit row to DB (${audit.reason ?? 'unknown'}); pass --no-audit to bypass\n`,
    );
    return 1;
  }
  if (audit.writable) {
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
      if (noAudit) {
        err(
          `forja purge: audit write failed (${reason}); proceeding because --no-audit was passed\n`,
        );
      } else {
        err(`forja purge: audit write failed (${reason}); aborting before FS removal\n`);
        return 1;
      }
    }
  } else {
    // noAudit must be true (verified above) — proceed without row.
    err(
      `forja purge: --no-audit set; skipping audit row (db reason: ${audit.reason ?? 'unknown'})\n`,
    );
  }

  // Atomic-ish FS removal. We remove the contents of `.agent/`
  // first, then remove the directory itself last. Removing
  // contents-first means a kill mid-walk leaves a partial state
  // but the parent dir still exists — recoverable. Removing
  // parent-first would leave orphan subtrees with no way to find
  // them via the project root.
  let removed: { files: number; dirs: number; bytes: number };
  try {
    removed = removeTree(agentDir);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    err(`forja purge: FS removal failed mid-walk: ${reason}\n`);
    err('  (audit row was already written; the project is in a partial state)\n');
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

// Stat → human kind for the error message when `.agent` is neither
// a directory nor a symlink (very rare, but possible: a regular
// file named `.agent`, a fifo, a device node).
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
        db.close();
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
