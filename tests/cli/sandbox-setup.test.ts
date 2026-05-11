import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/cli/args.ts';
import { runSandboxSetup } from '../../src/cli/sandbox-setup.ts';

const captured = () => {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
};

const NEVER_WHICH = (_cmd: string): string | null => null;
const ALWAYS_WHICH = (cmd: string): string | null => `/usr/bin/${cmd}`;

describe('parseArgs — agent sandbox setup', () => {
  test('verb is recognized', () => {
    const r = parseArgs(['sandbox', 'setup']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.sandbox?.verb).toBe('setup');
      expect(r.args.sandbox?.json).toBe(false);
    }
  });

  test('--json captured', () => {
    const r = parseArgs(['sandbox', 'setup', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.sandbox?.json).toBe(true);
      expect(r.args.json).toBe(true);
    }
  });

  test('missing verb fails parse', () => {
    const r = parseArgs(['sandbox']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('setup');
  });

  test('unknown verb fails parse', () => {
    const r = parseArgs(['sandbox', 'unknown']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('unknown verb');
  });

  test('unknown flag rejected', () => {
    const r = parseArgs(['sandbox', 'setup', '--foo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('--foo');
  });
});

describe('runSandboxSetup', () => {
  test('already installed → "already installed" message + exit 0', async () => {
    const out = captured();
    const code = await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: ALWAYS_WHICH, // bwrap found
      readOsRelease: () => 'ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04"\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('already installed');
    expect(text).toContain('agent doctor');
  });

  test('linux missing bwrap on ubuntu → apt install command', async () => {
    const out = captured();
    const code = await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () =>
        'ID=ubuntu\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04 LTS"\nID_LIKE=debian\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('Ubuntu 22.04 LTS');
    expect(text).toContain('ubuntu');
    expect(text).toContain('sudo apt install bubblewrap');
    expect(text).toContain('agent doctor');
  });

  test('linux missing bwrap on fedora → dnf install command', async () => {
    const out = captured();
    await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => 'ID=fedora\nPRETTY_NAME="Fedora Linux 39 (Workstation)"\n',
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('sudo dnf install bubblewrap');
  });

  test('linux missing bwrap on arch → pacman install command', async () => {
    const out = captured();
    await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => 'ID=arch\nPRETTY_NAME="Arch Linux"\n',
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('sudo pacman -S bubblewrap');
  });

  test('linux with unknown ID falls back via ID_LIKE chain', async () => {
    // A boutique Ubuntu derivative not in the mapping. ID_LIKE=ubuntu
    // → ubuntu → apt. Verifies the multi-step fallback.
    const out = captured();
    await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => 'ID=myforkos\nID_LIKE="ubuntu debian"\nPRETTY_NAME="MyForkOS 1.0"\n',
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('myforkos');
    expect(text).toContain('sudo apt install bubblewrap');
  });

  test('linux with completely unknown distro → generic fallback message', async () => {
    const out = captured();
    await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => 'ID=exoticdistro\nPRETTY_NAME="ExoticDistro Linux"\n',
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('exoticdistro');
    expect(text).toContain('not in the recommendation table');
    expect(text).toContain('package manager');
    // No specific install command rendered.
    expect(text).not.toContain('sudo apt');
    expect(text).not.toContain('sudo dnf');
  });

  test('linux without /etc/os-release → unknown distro', async () => {
    const out = captured();
    await runSandboxSetup({
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => null,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('Linux (unknown distribution)');
  });

  test('macos missing sandbox-exec → path-broken message', async () => {
    const out = captured();
    const code = await runSandboxSetup({
      platform: 'darwin',
      arch: 'arm64',
      which: NEVER_WHICH,
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('built into macOS');
    expect(text).toContain('$PATH');
  });

  test('unsupported platform → clear unsupported message', async () => {
    const out = captured();
    await runSandboxSetup({
      platform: 'freebsd' as NodeJS.Platform,
      arch: 'x64',
      which: NEVER_WHICH,
      out: out.write,
      err: captured().write,
    });
    const text = out.lines.join('');
    expect(text).toContain('freebsd');
    expect(text).toContain('no sandbox runtime support');
  });

  test('--json: emits a single envelope with platform + status + command', async () => {
    const out = captured();
    const code = await runSandboxSetup({
      json: true,
      platform: 'linux',
      arch: 'x64',
      which: NEVER_WHICH,
      readOsRelease: () => 'ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04 LTS"\n',
      out: out.write,
      err: captured().write,
    });
    expect(code).toBe(0);
    const env = JSON.parse(out.lines.join('').trim());
    expect(env.ok).toBe(true);
    expect(env.platform).toBe('linux');
    expect(env.arch).toBe('x64');
    expect(env.status).toBe('install');
    expect(env.installCommand).toBe('sudo apt install bubblewrap');
    expect(env.distro.id).toBe('ubuntu');
  });

  test('--json: already-installed status surfaces correctly', async () => {
    const out = captured();
    await runSandboxSetup({
      json: true,
      platform: 'linux',
      arch: 'x64',
      which: ALWAYS_WHICH,
      readOsRelease: () => 'ID=ubuntu\n',
      out: out.write,
      err: captured().write,
    });
    const env = JSON.parse(out.lines.join('').trim());
    expect(env.status).toBe('already-installed');
  });
});
