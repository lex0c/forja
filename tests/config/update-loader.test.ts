import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUpdateConfig } from '../../src/config/loaders.ts';

const makeTempCwd = (): string => mkdtempSync(join(tmpdir(), 'forja-update-cfg-'));

const writeProjectUpdate = (cwd: string, body: string): void => {
  mkdirSync(join(cwd, '.forja'), { recursive: true });
  writeFileSync(join(cwd, '.forja', 'config.toml'), body);
};

// HOME: '/none' isolates the test from the dev's real ~/.config user layer.
const load = (cwd: string) => loadUpdateConfig({ cwd, env: { HOME: '/none' } });

describe('loadUpdateConfig', () => {
  test('no [update] section → empty config, no warnings', () => {
    const cwd = makeTempCwd();
    try {
      const r = load(cwd);
      expect(r.config.check).toBeUndefined();
      expect(r.config.intervalMs).toBeUndefined();
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('check=true + interval="24h" parse', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectUpdate(cwd, '[update]\ncheck = true\ninterval = "24h"\n');
      const r = load(cwd);
      expect(r.config.check).toBe(true);
      expect(r.config.intervalMs).toBe(24 * 60 * 60 * 1000);
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('interval accepts m/s suffixes and a bare number of ms', () => {
    for (const [body, expected] of [
      ['interval = "30m"', 30 * 60 * 1000],
      ['interval = "90s"', 90 * 1000],
      ['interval = 5000', 5000],
    ] as const) {
      const cwd = makeTempCwd();
      try {
        writeProjectUpdate(cwd, `[update]\n${body}\n`);
        expect(load(cwd).config.intervalMs).toBe(expected);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  test('non-boolean check warns and is ignored', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectUpdate(cwd, '[update]\ncheck = "yes"\n');
      const r = load(cwd);
      expect(r.config.check).toBeUndefined();
      expect(r.warnings[0]).toContain('[update].check must be a boolean');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('check = "false" (string opt-out typo) is ignored + warned, not silently kept on', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectUpdate(cwd, '[update]\ncheck = "false"\n');
      const r = load(cwd);
      // Ignored → check stays undefined → the boot treats it as default-ON. The
      // warning (surfaced via BootstrapResult.updateConfigWarnings) is what tells
      // the operator the opt-out did not take and the probe is still enabled.
      expect(r.config.check).toBeUndefined();
      expect(r.warnings[0]).toContain('[update].check must be a boolean');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('garbage interval warns and is ignored', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectUpdate(cwd, '[update]\ninterval = "soon"\n');
      const r = load(cwd);
      expect(r.config.intervalMs).toBeUndefined();
      expect(r.warnings[0]).toContain('[update].interval');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bare-unit / decimal / zero intervals are rejected (regression: were silently 0)', () => {
    for (const bad of ['h', 'm', 's', '1.5h', '0', '0h']) {
      const cwd = makeTempCwd();
      try {
        writeProjectUpdate(cwd, `[update]\ninterval = "${bad}"\n`);
        const r = load(cwd);
        expect(r.config.intervalMs).toBeUndefined();
        expect(r.warnings[0]).toContain('[update].interval');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  test('interval accepts an ms suffix (shared parseTtlMs)', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectUpdate(cwd, '[update]\ninterval = "500ms"\n');
      expect(load(cwd).config.intervalMs).toBe(500);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
