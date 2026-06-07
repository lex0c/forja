// `agent cache clear` CLI handler.
//
// Operator surface for the opt-in persistent dependency caches at
// `forjaCachePersistBase()` = ~/.cache/forja/cache (build/dep caches: npm,
// Go, pip, …). The cache env-var redirect (`sandbox-cache-env.ts`) only
// exists INSIDE the sandbox, so the operator's native cleanup commands run
// on the host (`npm cache clean`, `go clean -cache`, …) never reach this
// tree — it accumulates "invisibly". This command makes it reclaimable.
//
// Clears ONLY the cache/ subtree. The sibling ~/.cache/forja/tmp/sessions/
// dirs are LIVE bwrap /tmp bind sources for ACTIVE sessions (shared_tmp,
// default on); deleting one mid-session makes the runner's
// `--bind <src> /tmp` fail (only --bind-try tolerates a missing source),
// breaking every sandboxed tool in that session until restart. So tmp/ is
// never touched — a `cache clear` from one terminal is safe while another
// session runs.
//
// Two-phase like `agent gc` / `agent purge`: bare invocation is a dry-run
// that reports the size; `--force` removes. `--json` emits one NDJSON line.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { forjaCacheDir, forjaCachePersistBase } from '../storage/paths.ts';

export interface RunCacheClearOptions {
  force: boolean;
  json: boolean;
  // Output sink (test seam). Defaults to stdout.
  out?: (line: string) => void;
  // Cache ROOT override (test seam). Production omits → `forjaCacheDir()`.
  // The command clears the `cache/` subtree under this root; the sibling
  // `tmp/` (live session binds) is never touched.
  cacheDir?: string;
}

// Recursively sum file sizes under `dir`. A missing dir reads as empty
// (the cache may simply never have been created). Symlinks are NOT followed
// (statSync on a dirent we know is a file; we never recurse into symlinked
// dirs because `withFileTypes` reports the link itself as non-directory).
const dirSize = (dir: string): { bytes: number; files: number } => {
  let bytes = 0;
  let files = 0;
  try {
    // Inline the readdir so TS infers `Dirent` from the withFileTypes
    // overload directly — a `ReturnType<typeof readdirSync>` annotation
    // resolves to the Buffer overload and mistypes `e.name`. A missing or
    // unreadable dir throws here → caught → contributes nothing.
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        const sub = dirSize(p);
        bytes += sub.bytes;
        files += sub.files;
      } else if (e.isFile()) {
        try {
          bytes += statSync(p).size;
          files += 1;
        } catch {
          // raced unlink / unreadable — skip, it contributes nothing.
        }
      }
    }
  } catch {
    // missing or unreadable dir — empty contribution.
  }
  return { bytes, files };
};

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
};

export const runCacheClear = (opts: RunCacheClearOptions): number => {
  const out = opts.out ?? ((l) => process.stdout.write(`${l}\n`));
  const root = opts.cacheDir ?? forjaCacheDir();
  // Clear ONLY the dependency-cache subtree, never the sibling tmp/ (live
  // session bind sources — see the file header). The subtree name is derived
  // from paths.ts (relative segment) so it can't drift from
  // forjaCachePersistBase().
  const dir = join(root, relative(forjaCacheDir(), forjaCachePersistBase()));
  const { bytes, files } = dirSize(dir);

  if (!opts.force) {
    if (opts.json) {
      out(JSON.stringify({ dir, bytes, files, mode: 'dry-run', removed: false }));
    } else {
      out(`forja cache: ${dir}`);
      out(`  ${fmtBytes(bytes)} across ${files} file(s)`);
      out('  (dry-run) re-run with --force to remove — active-session /tmp is preserved');
    }
    return 0;
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.json) {
      out(JSON.stringify({ dir, bytes, files, mode: 'force', removed: false, error: msg }));
    } else {
      out(`forja cache: failed to remove ${dir}: ${msg}`);
    }
    return 1;
  }

  if (opts.json) {
    out(JSON.stringify({ dir, bytes, files, mode: 'force', removed: true }));
  } else {
    out(`forja cache: removed ${fmtBytes(bytes)} (${files} file(s)) from ${dir}`);
  }
  return 0;
};
