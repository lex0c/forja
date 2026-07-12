import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end tests for the release installer (install.sh). We stand up a fake
// `curl` on PATH that emulates a GitHub release — latest-tag redirect, a `-D`
// header dump with Content-Length, and a slowly-streamed body — then drive the
// real script and assert on the verification chain and the TTY progress bar.
//
// install.sh is POSIX sh and can't be unit-tested from Bun directly, so these
// exercise it as a black box. The TTY case (progress bar) needs a pty, which we
// get from util-linux `script`; it is skipped where `script` isn't available.

const INSTALL_SH = join(import.meta.dir, '..', '..', 'install.sh');
const TAG = 'v9.9.9';
const SIZE = 800_000; // 8 × 100 000-byte chunks, so the bar sweeps several frames
const CHUNK = 100_000;

// Match install.sh's own os/arch → target_id mapping for this host.
function targetId(): string {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${arch}`;
}
const ASSET = `forja-${TAG}-${targetId()}`;

// Body is SIZE zero-bytes; the fixture's asset and the streamed download are
// byte-identical, so the SHA in SHA256SUMS matches what gets installed.
const BODY = Buffer.alloc(SIZE);
const GOOD_SHA = createHash('sha256').update(BODY).digest('hex');

// POSIX-sh fake curl. Handles: `-fsSI` (HEAD, version resolve), `-fsSL … -o`
// (plain fetch, non-TTY + SHA256SUMS) and `-fsSL -D hdr … -o` (TTY download
// with a header dump). A small connect delay before the headers land exercises
// the spinner→proportional transition.
const FAKE_CURL = `#!/bin/sh
url=''; out=''; hdr=''; head=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2; continue ;;
    -D) hdr="$2"; shift 2; continue ;;
    -*I*) head=1; shift; continue ;;
    -*) shift; continue ;;
    http://*|https://*) url="$1"; shift; continue ;;
    *) shift; continue ;;
  esac
done
if [ "$head" = 1 ]; then
  case "$url" in
    */releases/latest) printf 'HTTP/2 302\\r\\nlocation: https://github.com/o/r/releases/tag/${TAG}\\r\\n\\r\\n' ;;
    *) printf 'HTTP/2 200\\r\\ncontent-length: ${SIZE}\\r\\n\\r\\n' ;;
  esac
  exit 0
fi
case "$url" in
  */SHA256SUMS) cat "$FAKE_FIX/SHA256SUMS" > "$out" ;;
  *)
    : > "$out"
    if [ -n "$hdr" ]; then
      sleep 0.12
      printf 'HTTP/2 302\\r\\ncontent-length: 0\\r\\n\\r\\nHTTP/2 200\\r\\ncontent-length: ${SIZE}\\r\\n\\r\\n' > "$hdr"
    fi
    n=0
    while [ "$n" -lt 8 ]; do head -c ${CHUNK} /dev/zero >> "$out"; sleep 0.05; n=$((n+1)); done
    ;;
esac
exit 0
`;

type Fixture = { root: string; bin: string; prefix: string; env: Record<string, string> };

function makeFixture(sumsSha: string, assetName = ASSET): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'forja-install-'));
  const fix = join(root, 'fix');
  const bin = join(root, 'bin');
  const prefix = join(root, 'prefix');
  mkdirSync(fix);
  mkdirSync(bin);
  mkdirSync(prefix);
  writeFileSync(join(fix, 'asset'), BODY);
  writeFileSync(join(fix, 'SHA256SUMS'), `${sumsSha}  ${assetName}\n`);
  const curl = join(bin, 'curl');
  writeFileSync(curl, FAKE_CURL);
  chmodSync(curl, 0o755);
  // Prepend the fake curl so it shadows the real one; coreutils/sh come from
  // the inherited PATH.
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_FIX: fix,
    FORJA_PREFIX: prefix,
  } as Record<string, string>;
  return { root, bin, prefix, env };
}

function runPlain(fx: Fixture) {
  const r = Bun.spawnSync({
    cmd: ['sh', INSTALL_SH, '--repo', 'o/r'],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...fx.env, FORJA_NO_PROGRESS: '1' },
  });
  return {
    code: r.exitCode,
    stderr: new TextDecoder().decode(r.stderr),
    installed: Bun.file(join(fx.prefix, 'forja')).size > 0,
  };
}

function installedSha(fx: Fixture): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(join(fx.prefix, 'forja')))
      .digest('hex');
  } catch {
    return null;
  }
}

describe('install.sh — verification chain (plain / non-TTY)', () => {
  test('happy path installs the verified binary and logs the full digest', () => {
    const fx = makeFixture(GOOD_SHA);
    try {
      const r = runPlain(fx);
      expect(r.code).toBe(0);
      expect(r.installed).toBe(true);
      expect(installedSha(fx)).toBe(GOOD_SHA);
      // Finding #3: the full digest must be auditable from a captured log.
      expect(r.stderr).toContain(`sha256 ${GOOD_SHA}`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('hash mismatch is fail-closed: nonzero exit, nothing installed', () => {
    const wrong = '0'.repeat(64);
    const fx = makeFixture(wrong);
    try {
      const r = runPlain(fx);
      expect(r.code).not.toBe(0);
      expect(r.installed).toBe(false);
      expect(r.stderr).toContain('hash mismatch');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('asset absent from SHA256SUMS refuses to install', () => {
    // SHA256SUMS lists a different target, so this host finds no matching asset.
    const fx = makeFixture(GOOD_SHA, 'forja-v9.9.9-solaris-sparc');
    try {
      const r = runPlain(fx);
      expect(r.code).not.toBe(0);
      expect(r.installed).toBe(false);
      expect(r.stderr).toContain('refusing to install');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// The progress bar only renders on a TTY; drive the script under a pty via
// util-linux `script`. Skipped when `script` is unavailable or on non-Linux
// (BSD/macOS `script` has an incompatible CLI).
const hasScript = process.platform === 'linux' && Bun.which('script') !== null;

describe.if(hasScript)('install.sh — TTY progress bar', () => {
  test('download bar goes proportional (regression: render_dl var scope)', () => {
    const fx = makeFixture(GOOD_SHA);
    const typescript = join(fx.root, 'ts.out');
    // install.sh disables the rich UI (colors + bar) under NO_COLOR,
    // FORJA_NO_PROGRESS, or TERM=dumb — and this test asserts on the rich UI.
    // The pty from `script` satisfies `[ -t 2 ]`, but if the host/CI exports any
    // of those, install.sh would emit only plain lines and the assertions below
    // would spuriously fail. Strip them and pin a capable TERM so the test is
    // deterministic regardless of the ambient environment.
    const richEnv: Record<string, string> = { ...fx.env, TERM: 'xterm-256color' };
    delete richEnv.NO_COLOR;
    delete richEnv.FORJA_NO_PROGRESS;
    try {
      const r = Bun.spawnSync({
        cmd: ['script', '-qec', `sh '${INSTALL_SH}' --repo o/r`, typescript],
        stdout: 'ignore',
        stderr: 'ignore',
        env: richEnv,
      });
      expect(r.exitCode).toBe(0);
      expect(fx.prefix && installedSha(fx)).toBe(GOOD_SHA);

      // Split on CR so each in-place bar redraw is its own line.
      const frames = readFileSync(typescript, 'latin1').split(/\r/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the whole point of stripping ANSI
      const ansi = /\x1b\[[0-9?]*[a-zA-Z]/g;
      const pct = new Set<string>();
      let sawSpinner = false;
      for (const f of frames) {
        const line = f.replace(ansi, '');
        if (!line.includes('Download binary')) continue;
        if (line.includes('downloading')) sawSpinner = true;
        const m = line.match(/(\d+)%\s+[\d.]+ [KMG]?B \/ [\d.]+ [KMG]?B/);
        const p = m?.[1];
        if (p) pct.add(p);
      }
      // Before the headers arrive the bar must show the spinner…
      expect(sawSpinner).toBe(true);
      // …and once the total is known it must advance through several distinct
      // percentages up to 100 — the var-scope bug froze it (never proportional).
      expect(pct.size).toBeGreaterThanOrEqual(3);
      expect(pct.has('100')).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// Exercise the shasum(1) hashing branch (macOS ships shasum, not sha256sum).
// Force it with a restricted PATH: the coreutils the script needs (symlinked)
// plus a `shasum` shim, but deliberately NO `sha256sum` so detection falls
// through. The shim delegates to the real sha256sum by absolute path.
const COREUTILS = [
  'sh',
  'awk',
  'uname',
  'mktemp',
  'wc',
  'tr',
  'mkdir',
  'mv',
  'chmod',
  'rm',
  'cat',
  'head',
  'sleep',
];
const sha256sumBin = Bun.which('sha256sum');
const coreutilPaths = COREUTILS.map((u) => [u, Bun.which(u)] as const);
const canForceShasum = sha256sumBin !== null && coreutilPaths.every(([, p]) => p !== null);

describe.if(canForceShasum)('install.sh — shasum (macOS) hashing branch', () => {
  test('detects and verifies via shasum when sha256sum is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'forja-install-shasum-'));
    const fix = join(root, 'fix');
    const bin = join(root, 'bin');
    const prefix = join(root, 'prefix');
    mkdirSync(fix);
    mkdirSync(bin);
    mkdirSync(prefix);
    writeFileSync(join(fix, 'asset'), BODY);
    writeFileSync(join(fix, 'SHA256SUMS'), `${GOOD_SHA}  ${ASSET}\n`);
    for (const [u, p] of coreutilPaths) symlinkSync(p as string, join(bin, u));
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    // `shasum -a 256 FILE` → real sha256sum's "<hash>  FILE"; install.sh takes $1.
    const shim = `#!/bin/sh\nf=''\nwhile [ $# -gt 0 ]; do case "$1" in -a) shift 2 ;; *) f="$1"; shift ;; esac; done\nexec '${sha256sumBin}' "$f"\n`;
    writeFileSync(join(bin, 'shasum'), shim);
    chmodSync(join(bin, 'shasum'), 0o755);
    try {
      const r = Bun.spawnSync({
        cmd: ['sh', INSTALL_SH, '--repo', 'o/r'],
        stdout: 'pipe',
        stderr: 'pipe',
        // Restricted PATH (no sha256sum); HOME set so tilde()/`set -u` are happy.
        env: {
          PATH: bin,
          FAKE_FIX: fix,
          FORJA_PREFIX: prefix,
          FT: TAG,
          FORJA_NO_PROGRESS: '1',
          HOME: root,
        },
      });
      const stderr = new TextDecoder().decode(r.stderr);
      expect(stderr).toContain('shasum'); // step 1 reports the detected hash tool
      expect(r.exitCode).toBe(0);
      const installed = createHash('sha256')
        .update(readFileSync(join(prefix, 'forja')))
        .digest('hex');
      expect(installed).toBe(GOOD_SHA);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
