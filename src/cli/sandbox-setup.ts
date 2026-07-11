// `forja sandbox setup [--json]` — §13 guided sandbox bootstrap.
//
// Follow-on to slice 43's `forja doctor`. When doctor reports
// `sandbox: warn` (no bwrap on Linux, or sandbox-exec genuinely
// missing on macOS), this surface tells the operator HOW to fix it.
// Per spec §13.1 "detect, don't distribute" — never auto-installs;
// only prints the recommended command + a verification step.
//
// Coverage:
//   - Linux: parse /etc/os-release for distro → map ID to package
//     manager command. Falls back to a generic message when the
//     distro is unrecognized.
//   - macOS: sandbox-exec is built-in; surface the path-broken
//     case (which sandbox-exec returns null even though the binary
//     ships).
//   - Other: clear "not supported" with a documentation pointer.
//
// JSON mode emits a single envelope describing the platform +
// recommendation. Plain mode is operator-readable text. Exit 0 on
// recommendation rendered (even when sandbox is already installed —
// the verb is informational, not a gate); exit 1 only on internal
// failure (file read errors, etc).
//
// DEFERRED (REVIEW_NOTES.md R9 P0 #10 / slice 125 decision-C):
// Spec PERMISSION_ENGINE.md §13.4 describes a dual-confirm
// interactive menu ([1] Show / [2] Run install + --yes + writes
// `ci_mode_acknowledged` / [3] Continue unsafe + writes
// `unsafe_mode_acknowledged_at` / [4] Cancel). This implementation
// is INFO-ONLY — it never offers to RUN the install nor mutates
// the policy. Slice 91's `--i-know-what-im-doing` marker is the
// existing acknowledgment surface (see welcome.ts for the full
// deferred-decision rationale).

import { readFileSync } from 'node:fs';
import { arch as nodeArch, platform as nodePlatform } from 'node:os';
import { detectSandboxAvailability } from '../permissions/index.ts';
import { forjaCommand } from './forja-command.ts';

export interface RunSandboxSetupOptions {
  json?: boolean;
  // Test seam for `which()` so unit tests can simulate missing
  // binaries deterministically.
  which?: (cmd: string) => string | null;
  // Slice 154 (review — PATH-shim resistance): test seams for the
  // canonical-first resolver in detectSandboxAvailability. Pin
  // `exists` to deterministic answers so tests don't depend on
  // the host having /usr/bin/bwrap (or NOT having it). `stat` is
  // forwarded but the cli rarely needs it directly.
  exists?: (path: string) => boolean;
  stat?: (path: string) => { uid: number; mode: number } | null;
  // Test seam for the /etc/os-release file. Production reads from
  // disk; tests pin to a fixed string.
  readOsRelease?: () => string | null;
  // Test seam for platform / arch so a Linux runner can pin a
  // macOS scenario and vice versa.
  platform?: NodeJS.Platform;
  arch?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface DistroInfo {
  id: string;
  pretty: string;
  // The exact install command operators should run. Empty when the
  // distro is unknown (caller renders a generic fallback).
  installCommand: string;
}

const DISTRO_INSTALL: Record<string, string> = {
  ubuntu: 'sudo apt install bubblewrap',
  debian: 'sudo apt install bubblewrap',
  pop: 'sudo apt install bubblewrap',
  mint: 'sudo apt install bubblewrap',
  fedora: 'sudo dnf install bubblewrap',
  rhel: 'sudo dnf install bubblewrap',
  centos: 'sudo dnf install bubblewrap',
  rocky: 'sudo dnf install bubblewrap',
  almalinux: 'sudo dnf install bubblewrap',
  opensuse: 'sudo zypper install bubblewrap',
  'opensuse-leap': 'sudo zypper install bubblewrap',
  'opensuse-tumbleweed': 'sudo zypper install bubblewrap',
  sles: 'sudo zypper install bubblewrap',
  arch: 'sudo pacman -S bubblewrap',
  manjaro: 'sudo pacman -S bubblewrap',
  endeavouros: 'sudo pacman -S bubblewrap',
  alpine: 'sudo apk add bubblewrap',
  gentoo: 'sudo emerge -av sys-apps/bubblewrap',
  void: 'sudo xbps-install bubblewrap',
  nixos: 'nix-env -iA nixpkgs.bubblewrap',
};

// Parse /etc/os-release into a flat key→value map. Tolerates the
// quoted values the spec allows (`ID="ubuntu"` or `ID=ubuntu` are
// both valid). Comments + blank lines skipped.
const parseOsRelease = (content: string): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
};

const detectLinuxDistro = (readOsRelease: () => string | null): DistroInfo => {
  const content = readOsRelease();
  if (content === null) {
    return {
      id: 'unknown',
      pretty: 'Linux (unknown distribution)',
      installCommand: '',
    };
  }
  const fields = parseOsRelease(content);
  const id = (fields.ID ?? 'unknown').toLowerCase();
  const pretty = fields.PRETTY_NAME ?? fields.NAME ?? `Linux (${id})`;
  let installCommand = DISTRO_INSTALL[id] ?? '';
  if (installCommand === '' && fields.ID_LIKE !== undefined) {
    // ID_LIKE is space-separated. Try each parent in order.
    for (const parent of fields.ID_LIKE.split(/\s+/)) {
      const cmd = DISTRO_INSTALL[parent.toLowerCase()];
      if (cmd !== undefined) {
        installCommand = cmd;
        break;
      }
    }
  }
  return { id, pretty, installCommand };
};

const defaultReadOsRelease = (): string | null => {
  try {
    return readFileSync('/etc/os-release', 'utf-8');
  } catch {
    return null;
  }
};

interface Recommendation {
  platform: NodeJS.Platform;
  arch: string;
  status: 'install' | 'already-installed' | 'unsupported' | 'path-broken';
  distro?: DistroInfo;
  installCommand?: string;
  message: string;
}

const computeRecommendation = (opts: RunSandboxSetupOptions): Recommendation => {
  const platform = opts.platform ?? nodePlatform();
  const arch = opts.arch ?? nodeArch();
  const which = opts.which ?? ((cmd: string) => Bun.which(cmd));
  // Slice 154 (review): forward optional canonical-first seams.
  const detectOpts: Parameters<typeof detectSandboxAvailability>[0] = { which };
  if (opts.exists !== undefined) detectOpts.exists = opts.exists;
  if (opts.stat !== undefined) detectOpts.stat = opts.stat;
  const availability = detectSandboxAvailability(detectOpts);

  if (availability.available) {
    return {
      platform,
      arch,
      status: 'already-installed',
      message: `${availability.tool ?? 'sandbox'} is already installed. Run '${forjaCommand('doctor')}' to verify the full health check.`,
    };
  }

  if (platform === 'linux') {
    const distro = detectLinuxDistro(opts.readOsRelease ?? defaultReadOsRelease);
    if (distro.installCommand !== '') {
      return {
        platform,
        arch,
        status: 'install',
        distro,
        installCommand: distro.installCommand,
        message: `bubblewrap (provides bwrap) is the sandbox runtime on Linux. Install it via your distribution's package manager.`,
      };
    }
    return {
      platform,
      arch,
      status: 'install',
      distro,
      message: `Distribution '${distro.id}' is not in the recommendation table. Install bubblewrap via your system's package manager; the binary should land as /usr/bin/bwrap on $PATH.`,
    };
  }

  if (platform === 'darwin') {
    // macOS ships sandbox-exec; absence almost always means $PATH
    // is broken (the binary lives at /usr/bin/sandbox-exec and is
    // present on every supported macOS version).
    return {
      platform,
      arch,
      status: 'path-broken',
      message:
        'sandbox-exec is built into macOS at /usr/bin/sandbox-exec. If `which sandbox-exec` returns nothing, your $PATH is broken — re-source ~/.zshrc (or your shell rc) and verify /usr/bin is included.',
    };
  }

  return {
    platform,
    arch,
    status: 'unsupported',
    message: `Platform '${platform}' has no sandbox runtime support in Forja v2. Linux (bwrap) and macOS (sandbox-exec) are the only supported targets.`,
  };
};

const renderPlain = (r: Recommendation): string => {
  const lines: string[] = [];
  lines.push(`Platform: ${r.platform} ${r.arch}`);
  if (r.distro !== undefined) {
    lines.push(`Distro:   ${r.distro.pretty} (${r.distro.id})`);
  }
  lines.push('');
  if (r.status === 'already-installed') {
    lines.push(r.message);
    return lines.join('\n');
  }
  if (r.status === 'install' && r.installCommand !== undefined) {
    lines.push(r.message);
    lines.push('');
    lines.push('Recommended install:');
    lines.push(`  ${r.installCommand}`);
    lines.push('');
    lines.push('After install, verify with:');
    lines.push('  forja doctor');
    return lines.join('\n');
  }
  if (r.status === 'install') {
    // Unknown distro — generic message, no command.
    lines.push(r.message);
    lines.push('');
    lines.push('After install, verify with:');
    lines.push('  forja doctor');
    return lines.join('\n');
  }
  // path-broken / unsupported — just the message; nothing to run.
  lines.push(r.message);
  return lines.join('\n');
};

export const runSandboxSetup = async (options: RunSandboxSetupOptions = {}): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  void err;
  const json = options.json === true;
  let recommendation: Recommendation;
  try {
    recommendation = computeRecommendation(options);
  } catch (e) {
    const reason = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'internal', message: reason })}\n`);
    } else {
      err(`forja sandbox setup: ${reason}\n`);
    }
    return 1;
  }

  if (json) {
    out(`${JSON.stringify({ ok: true, ...recommendation })}\n`);
    return 0;
  }
  out(`${renderPlain(recommendation)}\n`);
  return 0;
};
