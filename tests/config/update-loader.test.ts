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

  test('interval accepts durations and a large bare-ms number (>= the 1min floor)', () => {
    for (const [body, expected] of [
      ['interval = "30m"', 30 * 60 * 1000],
      ['interval = "90s"', 90 * 1000],
      ['interval = 3600000', 3_600_000],
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
      expect(r.config.check).toBeUndefined();
      expect(r.warnings[0]).toContain('[update].check must be a boolean');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('garbage / bare-unit / decimal / zero intervals are rejected + warned', () => {
    for (const bad of ['soon', 'h', 'm', 's', '1.5h', '0', '0h']) {
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

  test('implausibly small interval (bare number is ms) is rejected + warned', () => {
    // `interval = 24` means 24ms via parseTtlMs — almost certainly a "24h" typo;
    // accepting it would probe GitHub on nearly every boot.
    for (const body of ['interval = 24', 'interval = "500ms"', 'interval = 5000']) {
      const cwd = makeTempCwd();
      try {
        writeProjectUpdate(cwd, `[update]\n${body}\n`);
        const r = load(cwd);
        expect(r.config.intervalMs).toBeUndefined();
        expect(r.warnings[0]).toContain('implausibly small');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  test('unknown / misspelled key warns and is ignored (opt-out typo not silent)', () => {
    // `chek = false` (typo) or `enabled = false` (recap's key) must not vanish —
    // with check default-on, a silent drop keeps the probe running.
    for (const body of ['chek = false', 'enabled = false', 'interval_ms = 3600000']) {
      const cwd = makeTempCwd();
      try {
        writeProjectUpdate(cwd, `[update]\n${body}\n`);
        const r = load(cwd);
        expect(r.config.check).toBeUndefined();
        expect(r.warnings.some((w) => w.includes('not a known update key'))).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});
