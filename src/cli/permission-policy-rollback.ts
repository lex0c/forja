// `agent permission policy-rollback <hash> [--target <file>] [--write] [--json]`
// — §12.4 policy archive write surface. Dry-run by default (safety);
// `--write` commits the canonical JSON bytes to the target YAML file
// AND emits an audit row per spec line 756 ("Cada rollback é audit
// event").
//
// The canonical JSON in the archive IS valid YAML (JSON is a subset
// of YAML 1.2), so the write is byte-for-byte — no JSON-to-YAML
// formatter needed. Operators with formatted YAML (comments + custom
// layout) will lose those on rollback; the spec frames rollback as
// an emergency-revert path where preserving format is secondary to
// restoring known-good behavior.
//
// `<hash>` must be the full archive hash (sha256:<64hex>). Truncated
// hashes from `policy-list`'s plain output are rejected — operators
// who want unique-prefix matching can pipe `policy-list --json | jq`
// to find the full hash first.
//
// Audit row shape mirrors slice 8's chain-break-accepted: tool_name
// = 'permission-engine', session_id = a synthetic CLI marker, decision
// = 'allow' (operator authorized by running --write), reason_chain
// captures the from/to hashes and target file.

import { resolve as resolvePath } from 'node:path';
import { type ReasonChainEntry, createSqliteSink, ensureInstallId } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { getPolicyArchive } from '../storage/repos/policy-archive.ts';

export interface RunPermissionPolicyRollbackOptions {
  hash: string;
  // Default `.agent/permissions.yaml` (project-local). Resolved
  // against the runner's cwd unless absolute.
  target?: string;
  // When true, writes the canonical JSON bytes to `target` AND emits
  // an audit row. Without it, the verb is read-only (dry-run).
  write?: boolean;
  json?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  // Test seam: pin the timestamp for the audit row.
  now?: () => number;
  // Test seam: override cwd for relative target resolution.
  cwd?: string;
  // Test seam: file writer (production uses node:fs.writeFileSync).
  writeFile?: (path: string, content: string) => void;
  // Test seam: file reader for the dry-run "current target size"
  // diagnostic. Returns null when the target file doesn't exist.
  readFile?: (path: string) => string | null;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

import { readFileSync, writeFileSync } from 'node:fs';

const defaultWriteFile = (path: string, content: string): void => {
  writeFileSync(path, content, { encoding: 'utf-8' });
};

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
};

const DEFAULT_TARGET = '.agent/permissions.yaml';

export const runPermissionPolicyRollback = async (
  options: RunPermissionPolicyRollbackOptions,
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const write = options.write === true;
  const now = options.now ?? Date.now;
  const cwd = options.cwd ?? process.cwd();
  const writeFile = options.writeFile ?? defaultWriteFile;
  const readFile = options.readFile ?? defaultReadFile;
  const dbPath = options.dbPath ?? defaultDbPath();
  const target = resolvePath(cwd, options.target ?? DEFAULT_TARGET);

  // Establish install context (mirrors verify / grants for error
  // symmetry). When --write is set, we also need the identity for
  // the audit sink genesis hash.
  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message: reason })}\n`);
    } else {
      err(`forja permission policy-rollback: ${reason}\n`);
    }
    return 1;
  }

  let archiveRow: { policy_hash: string; canonical_json: string } | null;
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    archiveRow = getPolicyArchive(db, options.hash);
    if (archiveRow === null) {
      const msg = `no policy archive entry with hash ${options.hash}`;
      if (json) {
        out(
          `${JSON.stringify({ ok: false, error: 'not_found', message: msg, hash: options.hash })}\n`,
        );
      } else {
        err(`forja permission policy-rollback: ${msg}\n`);
      }
      return 1;
    }

    // Read the current target content for the dry-run diagnostic.
    // null when the file doesn't exist (fresh install / typo'd path).
    const currentContent = readFile(target);

    if (!write) {
      // Dry-run: render the planned rollback summary.
      if (json) {
        out(
          `${JSON.stringify({
            ok: true,
            dry_run: true,
            hash: archiveRow.policy_hash,
            target,
            current_bytes: currentContent === null ? null : currentContent.length,
            archive_bytes: archiveRow.canonical_json.length,
          })}\n`,
        );
        return 0;
      }
      out('policy-rollback dry-run:\n');
      out(`  source hash:   ${archiveRow.policy_hash}\n`);
      out(`  target file:   ${target}\n`);
      if (currentContent === null) {
        out('  current file:  (does not exist — will be created on --write)\n');
      } else {
        out(`  current bytes: ${currentContent.length}\n`);
      }
      out(`  archive bytes: ${archiveRow.canonical_json.length}\n`);
      out('\n');
      out('Re-run with --write to overwrite the target file and emit an audit event.\n');
      return 0;
    }

    // --write path: commit the bytes + emit audit row.
    writeFile(target, archiveRow.canonical_json);
    const sink = createSqliteSink({ db, identity });
    const reasonChain: ReasonChainEntry[] = [
      {
        stage: 'policy-rollback',
        note: `to_hash=${archiveRow.policy_hash} target=${target}`,
      },
    ];
    // Slice 143 (API-3): admin row — no pipeline signal.
    sink.emit({
      session_id: 'cli-policy-rollback',
      tool_name: 'permission-engine',
      args: { hash: options.hash, target },
      decision: 'allow',
      policy_hash: archiveRow.policy_hash,
      reason_chain: reasonChain,
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: now(),
    });

    if (json) {
      out(
        `${JSON.stringify({
          ok: true,
          dry_run: false,
          hash: archiveRow.policy_hash,
          target,
          bytes_written: archiveRow.canonical_json.length,
        })}\n`,
      );
      return 0;
    }
    out('policy-rollback committed:\n');
    out(`  source hash:   ${archiveRow.policy_hash}\n`);
    out(`  target file:   ${target}\n`);
    out(`  bytes written: ${archiveRow.canonical_json.length}\n`);
    out('  audit:         emitted (tool_name=permission-engine, stage=policy-rollback)\n');
    return 0;
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'db', message: reason })}\n`);
    } else {
      err(`forja permission policy-rollback: ${reason}\n`);
    }
    return 1;
  }
};
