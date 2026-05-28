// Cross-platform build orchestrator (PERFORMANCE.md §18.1, §18.5).
//
// For each target in `TARGETS`, runs `bun build --compile --minify
// --sourcemap=external --target=<bun-target> --outfile=dist/agent-<id>`.
//
// Sourcemap handling: under `--compile`, Bun emits the external
// sourcemap as `<dist>/index.js.map` (filename derived from the entry,
// not the outfile). Sequential builds for different targets would
// overwrite the same file — only the last target's sourcemap would
// survive. After each successful build we rename it to
// `<dist>/<asset>.map` so each target keeps its own.
//
// CLI flags:
//   --target=<id>       restrict to one target (repeatable)
//   --dist=<path>       override output dir (default: dist)
//   --entry=<path>      override entry (default: src/cli/index.ts)
//   --no-minify         disable --minify (debug builds)
//   --no-sourcemap      omit sourcemap (smaller artifact, no debug)
//
// Cross-compile note: Bun's `--target=bun-<os>-<arch>` produces a
// binary for that platform from any host. The runner only needs Bun
// itself + write access to `dist/`; no per-OS toolchain.
//
// Bun does NOT yet emit a stable, identical binary across two runs
// at the same SHA (timestamps in the embedded loader). Reproducible
// build verification (Slice D) handles that with SOURCE_DATE_EPOCH +
// retry tolerance — this orchestrator just builds.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { arch as nodeArch, platform as nodePlatform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { type BuildTarget, TARGETS, assetName, findTarget } from './targets.ts';

// Bun --compile emits the external sourcemap as
// `<entry-basename-without-ext>.js.map` next to the outfile, not as
// `<outfile>.map`. Centralized so the orchestrator and any consumer
// asking "where is target X's sourcemap?" agree.
export const sourcemapName = (entry: string): string => {
  const base = basename(entry).replace(/\.[^.]+$/, '');
  return `${base}.js.map`;
};

export const targetSourcemapName = (target: BuildTarget): string => `${assetName(target)}.map`;

export interface BuildOptions {
  distDir: string;
  entry: string;
  minify: boolean;
  sourcemap: boolean;
  // Optional override of which targets to build. Empty / undefined
  // means all `TARGETS`.
  ids: readonly string[];
  // Test seam: invokes Bun. Returns the exit code; stdout/stderr go
  // to the parent process inheritedly.
  spawn?: (cmd: string, args: readonly string[]) => { status: number | null };
}

const defaultSpawn = (cmd: string, args: readonly string[]): { status: number | null } =>
  spawnSync(cmd, [...args], { stdio: 'inherit' });

export const buildArgs = (
  target: BuildTarget,
  opts: Pick<BuildOptions, 'distDir' | 'entry' | 'minify' | 'sourcemap'>,
): string[] => {
  const out = join(opts.distDir, assetName(target));
  const args = [
    'build',
    opts.entry,
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${out}`,
  ];
  if (opts.minify) args.push('--minify');
  if (opts.sourcemap) args.push('--sourcemap=external');
  return args;
};

export interface BuildResult {
  target: BuildTarget;
  status: number | null;
}

// Resolve a list of target ids into full BuildTarget records. Unknown
// ids throw — silent filtering would let a typo (`--target=lnux-x64`)
// produce a no-op "built 0 target(s)" success and mask the operator's
// mistake. Empty `ids` resolves to all `TARGETS`.
export const resolveIds = (ids: readonly string[]): BuildTarget[] => {
  if (ids.length === 0) return [...TARGETS];
  const out: BuildTarget[] = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (t === undefined) throw new Error(`unknown target: ${id}`);
    out.push(t);
  }
  return out;
};

export const runBuild = (opts: BuildOptions): BuildResult[] => {
  const spawn = opts.spawn ?? defaultSpawn;
  const subset = resolveIds(opts.ids);

  if (!existsSync(opts.distDir)) mkdirSync(opts.distDir, { recursive: true });

  const results: BuildResult[] = [];
  for (const target of subset) {
    // Wipe the prior asset so a failed build doesn't leave a stale
    // binary that the next pipeline step (size gate, checksums)
    // would treat as the current run's output. Same for the
    // per-target sourcemap (the renamed copy from a previous run).
    const out = join(opts.distDir, assetName(target));
    const targetMap = join(opts.distDir, targetSourcemapName(target));
    if (existsSync(out)) rmSync(out, { force: true });
    if (existsSync(targetMap)) rmSync(targetMap, { force: true });

    const args = buildArgs(target, opts);
    const { status } = spawn('bun', args);
    results.push({ target, status });
    if (status !== 0) {
      process.stderr.write(`build failed for ${target.id} (exit ${status})\n`);
      continue;
    }

    // Rename the entry-derived sourcemap to a per-target name so the
    // next target's build doesn't overwrite this one. Skip silently
    // if --no-sourcemap was requested (the file simply isn't there).
    if (opts.sourcemap) {
      const emitted = join(opts.distDir, sourcemapName(opts.entry));
      if (existsSync(emitted)) renameSync(emitted, targetMap);
    }
  }
  return results;
};

interface ParsedArgs {
  ids: string[];
  distDir: string;
  entry: string;
  minify: boolean;
  sourcemap: boolean;
  smoke: boolean;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const out: ParsedArgs = {
    ids: [],
    distDir: 'dist',
    entry: 'src/cli/index.ts',
    minify: true,
    sourcemap: true,
    smoke: true,
  };
  for (const a of argv) {
    if (a.startsWith('--target=')) out.ids.push(a.slice('--target='.length));
    else if (a.startsWith('--dist=')) out.distDir = a.slice('--dist='.length);
    else if (a.startsWith('--entry=')) out.entry = a.slice('--entry='.length);
    else if (a === '--no-minify') out.minify = false;
    else if (a === '--no-sourcemap') out.sourcemap = false;
    else if (a === '--no-smoke') out.smoke = false;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bun run scripts/build-targets.ts [--target=<id>...] [--dist=<path>] [--entry=<path>] [--no-minify] [--no-sourcemap] [--no-smoke]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
};

// Post-build smoke test (§13.7 enforcement validation). For each
// target binary that happens to match the build host's platform +
// arch (the only kind we can actually exec on this machine), spawn
// it with `FORJA_BROKER_WORKER=1` + a stdin BrokerRequest and verify
// the worker self-exec dispatch returns the canonical broker
// response envelope.
//
// What this catches: a regression that breaks the env-driven worker
// dispatch in compiled binaries (e.g., import.meta.dir prefix
// changes in a Bun upgrade, accidental reorder in src/cli/index.ts
// that pushes the env check after parseArgs, removal of the
// dynamic import of worker.ts that drops the module from the
// embedded asset graph). Without this hook, the regression ships to
// the release artifact and operators discover it via "broker spawn
// not working" reports.
//
// Cross-compile targets (darwin from linux, windows from anywhere)
// are skipped — we can't exec them on this host. CI matrix runners
// where each OS builds its own native target give full coverage.
//
// The smoke runs against the JUST-BUILT binary in `distDir`; the
// path is `<distDir>/agent-<target.id><target.ext>`. Skipped if the
// file is missing (build failure upstream already returned non-zero
// in `runBuild`).
export interface SmokeResult {
  target: BuildTarget;
  // `'ok'` — binary ran and produced the expected response shape.
  // `'skipped'` — cross-compile target (can't exec on this host).
  // `'failed'` — binary ran but produced wrong output or exited
  //   non-zero.
  // `'missing'` — binary file not on disk (upstream build failure).
  status: 'ok' | 'skipped' | 'failed' | 'missing';
  reason?: string;
}

const HOST_OS: BuildTarget['os'] = ((): BuildTarget['os'] => {
  const p = nodePlatform();
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'windows';
  // Unrecognized host (BSD, etc.) — smoke skipped for every target.
  return 'linux';
})();

const HOST_ARCH: BuildTarget['arch'] = nodeArch() === 'arm64' ? 'arm64' : 'x64';

const SMOKE_REQUEST = JSON.stringify({
  toolName: '__echo__',
  args: { smoke: true },
  capabilities: [],
  sandboxProfile: null,
});

const SMOKE_TIMEOUT_MS = 10_000;

export const smokeTestBinary = async (
  binPath: string,
  target: BuildTarget,
): Promise<SmokeResult> => {
  if (!existsSync(binPath)) {
    return { target, status: 'missing', reason: `binary not found at ${binPath}` };
  }
  if (target.os !== HOST_OS || target.arch !== HOST_ARCH) {
    return {
      target,
      status: 'skipped',
      reason: `cross-compile: host=${HOST_OS}-${HOST_ARCH}, target=${target.os}-${target.arch}`,
    };
  }
  const abortCtrl = new AbortController();
  const timeoutHandle = setTimeout(() => abortCtrl.abort(), SMOKE_TIMEOUT_MS);
  try {
    // Spawn with FORJA_BROKER_WORKER=1 to enter worker mode; the
    // binary's index.ts entry detects the flag before parseArgs and
    // routes to runWorkerProcess. Stdin carries the BrokerRequest;
    // stdout returns the BrokerResponse envelope.
    const proc = Bun.spawn([binPath], {
      env: { ...process.env, FORJA_BROKER_WORKER: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: abortCtrl.signal,
    });
    proc.stdin.write(SMOKE_REQUEST);
    proc.stdin.end();
    const stdoutText = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { target, status: 'failed', reason: `binary exited ${exitCode}` };
    }
    // Validate the response shape: __echo__ reflects the toolName +
    // args verbatim. Anything else means the dispatch hit a different
    // code path (parseArgs took over, REPL gate rejected, etc.).
    let parsed: { ok?: unknown; stdout?: unknown };
    try {
      parsed = JSON.parse(stdoutText.trim());
    } catch (e) {
      return {
        target,
        status: 'failed',
        reason: `stdout was not JSON: ${(e as Error).message} (got ${stdoutText.slice(0, 200)})`,
      };
    }
    if (parsed.ok !== true || typeof parsed.stdout !== 'string') {
      return {
        target,
        status: 'failed',
        reason: `unexpected response shape: ${stdoutText.slice(0, 200)}`,
      };
    }
    const innerEcho = JSON.parse(parsed.stdout) as { toolName?: unknown };
    if (innerEcho.toolName !== '__echo__') {
      return {
        target,
        status: 'failed',
        reason: `echo payload mismatch: toolName=${String(innerEcho.toolName)}`,
      };
    }
    return { target, status: 'ok' };
  } catch (e) {
    return { target, status: 'failed', reason: (e as Error).message };
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  let results: BuildResult[];
  try {
    results = runBuild(parsed);
  } catch (e) {
    // resolveIds throws on unknown --target ids. Convert to a clean
    // exit-2 so CI surfaces the typo before downstream steps run.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const failed = results.filter((r) => r.status !== 0);
  if (failed.length > 0) {
    process.stderr.write(`${failed.length}/${results.length} target build(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`built ${results.length} target(s) into ${parsed.distDir}\n`);

  // §13.7 post-build smoke. Only runs on successful builds; only
  // exercises targets that match the host platform+arch (others are
  // structurally unrunnable from this machine). Failures here block
  // the release because the binary built but the spawn-broker path
  // is broken — exactly the regression class smoke is here to
  // catch. `--no-smoke` skips for debugging.
  if (!parsed.smoke) return;
  const successful = results.filter((r) => r.status === 0);
  if (successful.length === 0) return;
  const smokeResults: SmokeResult[] = [];
  for (const r of successful) {
    const binPath = resolve(parsed.distDir, assetName(r.target));
    smokeResults.push(await smokeTestBinary(binPath, r.target));
  }
  for (const s of smokeResults) {
    const label = `smoke ${s.target.id}`;
    if (s.status === 'ok') {
      process.stdout.write(`${label}: ok\n`);
    } else if (s.status === 'skipped') {
      process.stdout.write(`${label}: skipped (${s.reason ?? 'cross-compile'})\n`);
    } else {
      process.stderr.write(`${label}: ${s.status} (${s.reason ?? 'no detail'})\n`);
    }
  }
  const smokeFailures = smokeResults.filter((s) => s.status === 'failed' || s.status === 'missing');
  if (smokeFailures.length > 0) {
    process.stderr.write(
      `${smokeFailures.length}/${smokeResults.length} smoke test(s) failed; spawn-broker path may be broken\n`,
    );
    process.exit(1);
  }
};

if (import.meta.main) await main();
