// History first-run privacy banner. Spec: HISTORY.md §3.2.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeEmitHistoryBanner } from '../../src/cli/history-banner.ts';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';

interface Harness {
  cwd: string;
  events: UIEvent[];
  warns: string[];
  emit: () => boolean;
}

const makeHarness = (cwd: string): Harness => {
  const bus = createBus();
  const events: UIEvent[] = [];
  bus.onAny((e) => events.push(e));
  const warns: string[] = [];
  return {
    cwd,
    events,
    warns,
    emit: () =>
      maybeEmitHistoryBanner({
        bus,
        cwd,
        now: () => 1,
        warn: (m) => warns.push(m),
        // Tests must not be susceptible to the developer's shell
        // having FORJA_NO_HISTORY set; the env path is exercised
        // explicitly below.
        ignoreEnv: true,
      }),
  };
};

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'forja-history-banner-'));
  delete process.env.FORJA_NO_HISTORY;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.FORJA_NO_HISTORY;
});

describe('maybeEmitHistoryBanner — first-run path', () => {
  test('emits two info lines AND writes ack marker', () => {
    const h = makeHarness(cwd);
    expect(h.emit()).toBe(true);
    const infos = h.events.filter((e) => e.type === 'info');
    expect(infos).toHaveLength(2);
    expect((infos[0] as Extract<UIEvent, { type: 'info' }>).message).toContain('.agent/forja.db');
    expect((infos[0] as Extract<UIEvent, { type: 'info' }>).message).toContain('entry cap');
    expect((infos[1] as Extract<UIEvent, { type: 'info' }>).message).toContain('/history off');
    expect((infos[1] as Extract<UIEvent, { type: 'info' }>).message).toContain('/history clear');
    expect(existsSync(join(cwd, '.agent', 'forja-history-acked'))).toBe(true);
  });

  test('runs are idempotent: second invocation suppresses banner', () => {
    const h = makeHarness(cwd);
    expect(h.emit()).toBe(true);
    expect(h.emit()).toBe(false);
    const infos = h.events.filter((e) => e.type === 'info');
    expect(infos).toHaveLength(2); // first emit only
  });

  test('creates .agent/ when missing (early-stage projects)', () => {
    // tmp dir starts without .agent — the banner must mkdir -p.
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
    const h = makeHarness(cwd);
    h.emit();
    expect(existsSync(join(cwd, '.agent'))).toBe(true);
  });
});

describe('maybeEmitHistoryBanner — suppression rules', () => {
  test('existing ack marker suppresses the banner', () => {
    mkdirSync(join(cwd, '.agent'), { recursive: true });
    writeFileSync(join(cwd, '.agent', 'forja-history-acked'), '');
    const h = makeHarness(cwd);
    expect(h.emit()).toBe(false);
    expect(h.events.filter((e) => e.type === 'info')).toHaveLength(0);
  });

  test('.agent/no-history marker (per-project disable) suppresses the banner', () => {
    mkdirSync(join(cwd, '.agent'), { recursive: true });
    writeFileSync(join(cwd, '.agent', 'no-history'), '');
    const h = makeHarness(cwd);
    expect(h.emit()).toBe(false);
    // ack marker is NOT created — operator never saw the disclosure;
    // future boots that re-enable persistence (by deleting no-history)
    // should still get the first-run banner.
    expect(existsSync(join(cwd, '.agent', 'forja-history-acked'))).toBe(false);
  });

  test('FORJA_NO_HISTORY env (without ignoreEnv) suppresses the banner', () => {
    process.env.FORJA_NO_HISTORY = '1';
    const bus = createBus();
    const events: UIEvent[] = [];
    bus.onAny((e) => events.push(e));
    const result = maybeEmitHistoryBanner({
      bus,
      cwd,
      now: () => 1,
      warn: () => undefined,
      // ignoreEnv intentionally NOT set — we want the env probe live.
    });
    expect(result).toBe(false);
    expect(events).toHaveLength(0);
    expect(existsSync(join(cwd, '.agent', 'forja-history-acked'))).toBe(false);
  });
});

describe('maybeEmitHistoryBanner — failure paths', () => {
  test('marker-write failure emits a warn but still emits the banner this boot', () => {
    // Force a write failure: replace `.agent` with a regular file
    // so mkdir/writeFile both throw EEXIST/ENOTDIR.
    writeFileSync(join(cwd, '.agent'), '');
    const h = makeHarness(cwd);
    expect(h.emit()).toBe(true);
    const infos = h.events.filter((e) => e.type === 'info');
    expect(infos).toHaveLength(2); // banner still surfaced
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain('forja-history-acked');
  });
});
