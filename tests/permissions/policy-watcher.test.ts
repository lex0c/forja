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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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

  // Slice 139 C4: provenance staleness post-reload. Pre-fix the
  // watcher discarded resolved.provenance, so every audit row's
  // source.layer and `/perms why` output kept pointing at the
  // construction-time hierarchy — even after the operator moved
  // a section between layers (added an enterprise YAML, edited
  // session YAML, etc.). Fix: forward resolved.provenance to
  // engine.reloadPolicy as the second argument.
  test('forwards resolved provenance to engine.reloadPolicy (slice 139 C4)', () => {
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
    writeFileSync(
      projectFile,
      'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["initial"]\n',
    );

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    // Spy on reloadPolicy to capture the args the watcher passes.
    const reloadCalls: Array<{
      hasProvenance: boolean;
      provenanceBash: string | undefined;
    }> = [];
    const original = eng.reloadPolicy.bind(eng);
    eng.reloadPolicy = ((newPolicy, newProvenance) => {
      reloadCalls.push({
        hasProvenance: newProvenance !== undefined,
        provenanceBash: newProvenance?.bash,
      });
      return original(newPolicy, newProvenance);
    }) as typeof eng.reloadPolicy;

    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    fake.trigger(projectFile);
    timer.fire();
    expect(reloadCalls.length).toBe(1);
    expect(reloadCalls[0]?.hasProvenance).toBe(true);
    // The project-local YAML defines the `bash` section, so its
    // provenance layer is 'project'.
    expect(reloadCalls[0]?.provenanceBash).toBe('project');
  });

  test('forwards merged trustedHosts to engine.reloadPolicy on YAML edit', () => {
    // Pre-fix: trustedHosts was captured at engine construction
    // (`engine.ts:1278`) and never re-derived on reload. Operator
    // edits `fetch_url.trusted_hosts` → policy hash advances and
    // `source.layer` updates, but the risk-scorer keeps using the
    // construction-time list. The watcher now computes
    // `mergeTrustedHosts(newPolicy.tools.fetch_url?.trusted_hosts
    // ?? [])` and forwards as the 3rd arg of reloadPolicy. This
    // test pins the wire by spying on the call.
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
    writeFileSync(
      projectFile,
      'defaults:\n  mode: strict\ntools:\n  fetch_url:\n    trusted_hosts:\n      - "internal.cdn.example.com"\n',
    );

    const eng = createPermissionEngine(policy({}), { cwd: CWD_FALLBACK });
    const reloadCalls: Array<{ trustedHosts: readonly string[] | undefined }> = [];
    const original = eng.reloadPolicy.bind(eng);
    eng.reloadPolicy = ((newPolicy, newProvenance, newTrustedHosts) => {
      reloadCalls.push({ trustedHosts: newTrustedHosts });
      return original(newPolicy, newProvenance, newTrustedHosts);
    }) as typeof eng.reloadPolicy;

    const fake = makeFakeWatcher();
    const timer = makeSyncTimer();
    watchAndReload({
      engine: eng,
      resolveOptions: { cwd: tmp, enterprisePath: null, userPath: null },
      watcher: fake.watcher,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    fake.trigger(projectFile);
    timer.fire();
    expect(reloadCalls.length).toBe(1);
    expect(reloadCalls[0]?.trustedHosts).toBeDefined();
    // Merged list = DEFAULT_TRUSTED_HOSTS (github.com + 5 public
    // registries) + the policy-supplied internal host. Spot-check
    // both endpoints rather than exact-length so a future bump to
    // DEFAULT_TRUSTED_HOSTS doesn't break this pin.
    expect(reloadCalls[0]?.trustedHosts).toContain('github.com');
    expect(reloadCalls[0]?.trustedHosts).toContain('internal.cdn.example.com');
  });

  test('successive reloads: each one fires its own callback', () => {
    const projectFile = join(tmp, '.forja', 'permissions.yaml');
    mkdirSync(join(tmp, '.forja'), { recursive: true });
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

// Slice 166 (review — Batch D, second item): the production
// `defaultWatcher` watches the PARENT DIR + filters by basename so
// atomic-rename saves keep the watcher alive across inode swaps.
// Pre-slice `fs.watch(path, cb)` attached to the file's inode; vim
// (backupcopy=no) / IntelliJ "safe save" / VS Code default all
// replace the inode on save and the old watcher was orphaned.
//
// This test uses the REAL `fsWatch` to validate the integration
// (Bun's fs.watch is the production path). The fake watcher tests
// above remain the regression net for the watcher dispatch logic.
describe('watchAndReload — atomic-rename save survives the watcher (slice 166)', () => {
  test('replacing the policy file via rename triggers the dir watcher', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forja-policy-watch-rename-'));
    try {
      const projectDir = join(tmp, 'proj');
      const agentDir = join(projectDir, '.forja');
      mkdirSync(agentDir, { recursive: true });
      const policyPath = join(agentDir, 'permissions.yaml');
      writeFileSync(policyPath, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v1"]\n');
      const engine = createPermissionEngine(policy({}), { cwd: projectDir });
      const reloads: Array<{ oldHash: string; newHash: string }> = [];
      const failures: string[] = [];
      // Production defaultWatcher (no `watcher` seam). Real fs.watch
      // on the parent dir.
      const watcher = watchAndReload({
        engine,
        resolveOptions: { cwd: projectDir, enterprisePath: null, userPath: null },
        debounceMs: 50,
        onReload: (r) => reloads.push({ oldHash: r.oldHash, newHash: r.newHash }),
        onReloadFailed: (r) => failures.push(r),
      });
      try {
        // Simulate atomic-rename save: write a sibling tmp file,
        // then rename over the original. Inode of policyPath
        // changes. Pre-slice the watcher would miss subsequent
        // saves; post-slice the parent-dir watcher fires every
        // event in the directory.
        const tmpPath = join(agentDir, 'permissions.yaml.tmp');
        const { renameSync } = await import('node:fs');
        writeFileSync(tmpPath, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v2"]\n');
        // Let the kernel's inotify deliver the IN_CREATE event for
        // the tmp file before the rename happens. Without this
        // pause Bun's fs.watch dispatcher races the rename and only
        // surfaces the first event.
        await new Promise((resolve) => setTimeout(resolve, 50));
        renameSync(tmpPath, policyPath);
        // Poll for the reload: inotify + Bun event-loop ticking +
        // 50ms debounce can take a non-trivial wall-clock window.
        // Bounded retry instead of a single sleep so the test
        // doesn't fight transient scheduling jitter on CI.
        for (let i = 0; i < 30 && reloads.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(reloads.length).toBeGreaterThanOrEqual(1);
        // No reload-failed callbacks expected on a clean save.
        expect(failures).toEqual([]);
        const firstReloadCount = reloads.length;
        // Second save proves the watcher didn't orphan post-rename.
        writeFileSync(tmpPath, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v3"]\n');
        await new Promise((resolve) => setTimeout(resolve, 50));
        renameSync(tmpPath, policyPath);
        for (let i = 0; i < 30 && reloads.length === firstReloadCount; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(reloads.length).toBeGreaterThan(firstReloadCount);
      } finally {
        watcher.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('events for unrelated siblings in the same dir are filtered out', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'forja-policy-watch-sibling-'));
    try {
      const projectDir = join(tmp, 'proj');
      const agentDir = join(projectDir, '.forja');
      mkdirSync(agentDir, { recursive: true });
      const policyPath = join(agentDir, 'permissions.yaml');
      writeFileSync(policyPath, 'defaults:\n  mode: strict\ntools:\n  bash:\n    allow: ["v1"]\n');
      const engine = createPermissionEngine(policy({}), { cwd: projectDir });
      const reloads: Array<{ oldHash: string; newHash: string }> = [];
      const watcher = watchAndReload({
        engine,
        resolveOptions: { cwd: projectDir, enterprisePath: null, userPath: null },
        debounceMs: 50,
        onReload: (r) => reloads.push({ oldHash: r.oldHash, newHash: r.newHash }),
      });
      try {
        // Touch a sibling file in the same dir. The watcher fires
        // (dir-level event) but the basename filter drops it —
        // no reload.
        writeFileSync(join(agentDir, 'unrelated.txt'), 'noise');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(reloads.length).toBe(0);
      } finally {
        watcher.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
