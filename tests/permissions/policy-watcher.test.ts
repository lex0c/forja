import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import { watchAndReload } from '../../src/permissions/policy-watcher.ts';
import type { Policy } from '../../src/permissions/types.ts';

const policy = (p: Partial<Policy>): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

// Synchronous "timer" — tests fire it manually to advance the
// debounce window. Replaces setTimeout/clearTimeout so the watcher
// doesn't depend on real wall-clock during unit tests.
const makeSyncTimer = () => {
  let pending: (() => void) | null = null;
  const setTimer = (cb: () => void) => {
    pending = cb;
    return 'handle';
  };
  const clearTimer = () => {
    pending = null;
  };
  const fire = () => {
    const cb = pending;
    pending = null;
    cb?.();
  };
  return { setTimer, clearTimer, fire, pending: () => pending };
};

// Synchronous fs.watch replacement — exposes a `trigger` function
// that callers invoke to fake a filesystem event for a given path.
const makeFakeWatcher = () => {
  const cbs = new Map<string, () => void>();
  const closed = new Set<string>();
  const watcher = (path: string, cb: () => void) => {
    cbs.set(path, cb);
    return {
      close: () => {
        closed.add(path);
        cbs.delete(path);
      },
    };
  };
  const trigger = (path: string) => {
    cbs.get(path)?.();
  };
  return { watcher, trigger, watched: () => [...cbs.keys()], closed };
};

describe('watchAndReload', () => {
  let tmp: string;
  const CWD_FALLBACK = '/work/proj';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forja-watcher-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('successful reload: onReload fires with hash transition', async () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["ls *"]\n');

    const eng = createPermissionEngine(policy({ defaults: { mode: 'strict' } }), {
      cwd: CWD_FALLBACK,
    });
    const oldHash = eng.policy() && `sha256:${eng.policy().defaults.mode}`; // not used; for diff later
    expect(oldHash).toBeDefined();

    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const reloads: Array<{ oldHash: string; newHash: string }> = [];
    const failures: string[] = [];
    const w = watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReload: (r) => reloads.push({ oldHash: r.oldHash, newHash: r.newHash }),
      onReloadFailed: (r) => failures.push(r),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    // Trigger a synthetic fs event on the project file.
    fake.trigger(projectFile);
    // Debounce hasn't elapsed yet — no reload should have fired.
    expect(reloads.length).toBe(0);
    // Advance the timer (debounced callback).
    timer.fire();
    expect(reloads.length).toBe(1);
    expect(failures).toEqual([]);
    expect(reloads[0]?.oldHash).not.toBe(reloads[0]?.newHash);
    // Engine now reflects the YAML file's policy.
    expect(eng.policy().tools.bash?.allow).toEqual(['ls *']);

    w.close();
  });

  test('debounce: multiple rapid events coalesce into one reload', async () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const reloads: number[] = [];
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReload: () => reloads.push(1),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    // Fire 5 events in rapid succession (editor save = N events).
    fake.trigger(projectFile);
    fake.trigger(projectFile);
    fake.trigger(projectFile);
    fake.trigger(projectFile);
    fake.trigger(projectFile);
    expect(reloads.length).toBe(0);
    // One debounced fire collapses them all.
    timer.fire();
    expect(reloads.length).toBe(1);
  });

  test('only existing paths are watched (non-existent paths skipped silently)', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    // No file created at any of the discovered paths → watcher
    // skips everything.
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    expect(fake.watched()).toEqual([]);
  });

  test('only existing paths: project file present → only that one watched', () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    expect(fake.watched()).toEqual([projectFile]);
  });

  test('malformed YAML on disk: onReloadFailed with parse diagnostic, engine unchanged', () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults: { mode: strict\n  unclosed-mapping');

    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['ls *'] } } }), {
      cwd: CWD_FALLBACK,
    });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const reloads: unknown[] = [];
    const failures: string[] = [];
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReload: (r) => reloads.push(r),
      onReloadFailed: (r) => failures.push(r),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    fake.trigger(projectFile);
    timer.fire();
    expect(reloads.length).toBe(0);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('policy resolve failed');
    // Engine state untouched.
    expect(eng.policy().tools.bash?.allow).toEqual(['ls *']);
  });

  test('lock conflicts: onReloadFailed, engine unchanged', () => {
    // user file locks sandbox; project file tries to override → conflict.
    const userFile = join(tmp, 'user-policy.yaml');
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(userFile, 'sandbox:\n  required: true\n  locked: true\n');
    writeFileSync(projectFile, 'sandbox:\n  required: false\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const failures: string[] = [];
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: userFile },
      onReloadFailed: (r) => failures.push(r),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    // Project file change triggers reload; lock conflict rejects.
    fake.trigger(projectFile);
    timer.fire();
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('lock conflicts');
    expect(failures[0]).toContain('sandbox');
  });

  test('close() cleans up all watchers + cancels pending timer', () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const reloads: unknown[] = [];
    const w = watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReload: (r) => reloads.push(r),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    // Schedule a pending reload.
    fake.trigger(projectFile);
    expect(timer.pending()).not.toBeNull();
    // Close cleans both watchers + pending timer.
    w.close();
    expect(fake.closed.has(projectFile)).toBe(true);
    expect(timer.pending()).toBeNull();
    // Even if a stray fire happened after close (defensive), the
    // pre-cleared timer means no reload fires.
    timer.fire();
    expect(reloads.length).toBe(0);
  });

  test('watcher throws on subscribe: onReloadFailed surfaces the error, other paths still set up', () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const timer = makeSyncTimer();
    const failures: string[] = [];
    const watcher = (path: string, cb: () => void) => {
      if (path === projectFile) {
        throw new Error('inotify exhausted');
      }
      return { close: () => {}, _cb: cb };
    };
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReloadFailed: (r) => failures.push(r),
      watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('cannot watch');
    expect(failures[0]).toContain('inotify exhausted');
  });

  test('successive reloads: each one fires its own callback', () => {
    const projectFile = join(tmp, '.agent', 'permissions.yaml');
    mkdirSync(join(tmp, '.agent'), { recursive: true });
    writeFileSync(projectFile, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v1"]\n');

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    const reloads: Array<{ oldHash: string; newHash: string }> = [];
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      onReload: (r) => reloads.push({ oldHash: r.oldHash, newHash: r.newHash }),
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    fake.trigger(projectFile);
    timer.fire();
    expect(reloads.length).toBe(1);

    // Edit the file to a NEW shape and trigger again.
    writeFileSync(projectFile, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v2"]\n');
    fake.trigger(projectFile);
    timer.fire();
    expect(reloads.length).toBe(2);
    // Each reload picks up the new bytes.
    expect(reloads[1]?.oldHash).toBe(reloads[0]?.newHash);
    expect(reloads[1]?.newHash).not.toBe(reloads[1]?.oldHash);
  });
});
