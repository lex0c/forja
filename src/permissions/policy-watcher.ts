// File-watch wire-up for hot reload. Consumes the engine's
// `reloadPolicy()` primitive: when any of the policy YAML files
// on disk changes, re-resolve the hierarchy + push the new Policy
// to the engine.
//
// Watched paths (per `paths.ts`):
//   - Enterprise: /etc/agent/permissions.yaml (or %PROGRAMDATA% on Windows)
//   - User:       ~/.config/agent/permissions.yaml (or XDG/APPDATA)
//   - Project:    <cwd>/.agent/permissions.yaml
//
// Only EXISTING paths are watched. Files created mid-session won't
// trigger reloads until the next bootstrap; closing that gap would
// require watching the parent directory + filtering by basename,
// which adds complexity for a rare scenario (operators typically
// create policy files via `agent init`, not mid-session).
//
// Events are debounced (default 100ms) — most editors fire multiple
// fs events for a single save (truncate + write, atomic rename,
// inode change). Without debouncing, a single Ctrl-S becomes 3-5
// reloads in rapid succession.
//
// On debounced fire:
//   1. resolvePolicy() — re-walks the hierarchy + revalidates.
//   2. Check lockConflicts — if any, emit reloadFailed (the lower
//      layer attempted to override a locked field; reject the reload
//      and keep the old policy).
//   3. engine.reloadPolicy() — atomic swap.
//   4. Emit onReload (success) or onReloadFailed (engine-side rejection).
//
// `resolvePolicy()` throws on malformed YAML / schema errors; the
// thrown error becomes an onReloadFailed call. Old policy stays
// authoritative — failed reloads never corrupt enforcement state.
//
// Test seams: every dependency on the host (fs.watch, setTimeout,
// existsSync) is injectable. Production callers leave them
// undefined; tests pin specific scenarios deterministically.

import { existsSync, watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { PermissionEngine } from './engine.ts';
import type { LockConflict, ResolveOptions } from './hierarchy.ts';
import { type ReloadPolicyResult, resolvePolicy } from './index.ts';
import { enterprisePolicyPath, projectPolicyPath, userPolicyPath } from './paths.ts';
import { mergeTrustedHosts } from './risk-score.ts';

export interface PolicyWatcher {
  close(): void;
}

export interface WatchAndReloadOptions {
  engine: PermissionEngine;
  resolveOptions: ResolveOptions;
  // Fired AFTER a successful reload. `result.oldHash` / `result.newHash`
  // carry the hash transition; consumers (audit emitter, /perms render)
  // use these to log + display.
  onReload?: (result: Extract<ReloadPolicyResult, { ok: true }>) => void;
  // Fired when the reload failed at ANY stage: resolvePolicy threw
  // (malformed YAML / schema error), lockConflicts present, or
  // engine.reloadPolicy returned ok:false. Single callback so
  // consumers get a uniform diagnostic surface.
  onReloadFailed?: (reason: string) => void;
  // Debounce window. Most editors fire 2-5 fs events per save; the
  // default coalesces them. Set lower for tests.
  debounceMs?: number;
  // Test seams — production callers omit. Each replaces ONE host
  // dependency so unit tests don't touch real disk / wallclock.
  watcher?: (path: string, cb: () => void) => { close: () => void };
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  exists?: (path: string) => boolean;
}

// Discover the three policy paths from a ResolveOptions object.
// Mirrors what `loadLayers` in hierarchy.ts does at startup, minus
// the file reads — we only need PATHS to wire up watchers.
const discoverPolicyPaths = (opts: ResolveOptions): string[] => {
  const out: string[] = [];
  const env = opts.env ?? process.env;
  // Enterprise: honor explicit null (test seam) by skipping.
  if (opts.enterprisePath !== null) {
    const p = opts.enterprisePath ?? enterprisePolicyPath(undefined, env);
    if (p !== null) out.push(p);
  }
  // User: same null-disable convention.
  if (opts.userPath !== null) {
    const p = opts.userPath ?? userPolicyPath(env);
    if (p !== null) out.push(p);
  }
  // Project: always derived from cwd; no disable knob.
  out.push(projectPolicyPath(opts.cwd));
  return out;
};

const formatLockConflicts = (conflicts: readonly LockConflict[]): string => {
  return conflicts
    .map((c) => `${c.section} locked by ${c.lockedBy}, attempted by ${c.attemptedBy}`)
    .join('; ');
};

// Watch the PARENT DIRECTORY + filter by basename instead of
// watching the file inode directly. `fs.watch(path, cb)` against
// the file itself fails on atomic rename saves (vim with
// `backupcopy=no`, IntelliJ "safe save", VS Code default): the
// file's inode is replaced, the OS's inotify / FSEvents
// subscription stays attached to the OLD (unlinked) inode, and
// every subsequent save hits the new inode that nobody is
// watching. Operator edits policy, expects the reload audit row,
// sees nothing, doesn't know the engine is still enforcing stale
// rules.
//
// Dir-watch + basename filter survives rename: the dir's inode is
// stable; rename + create + delete events all land on the dir
// watcher; we filter to the ONE filename we care about. Standard
// pattern, supported by both inotify (Linux) and FSEvents (macOS).
//
// Intermediate-state caveat: during a rename save the file
// briefly doesn't exist (tmp → renamed-to-final). reloadNow's
// resolvePolicy throws ENOENT on read → onReloadFailed fires with
// the diagnostic. The debounce coalesces follow-up events; the
// final state (file fully written) reloads cleanly. The brief
// failure is a known noisy edge but not a security or correctness
// concern.
const defaultWatcher = (path: string, cb: () => void): { close: () => void } => {
  const dir = dirname(path);
  const base = basename(path);
  const w = fsWatch(dir, (_event, filename) => {
    // filename can be null (very rare; observed on some FUSE
    // mounts when the underlying signal lacks an entry). Treat as
    // "something happened in this dir we care about" — fire the
    // callback. Debouncing dedupes if the next event names our
    // file.
    if (filename === null || filename === base) cb();
  });
  return { close: () => w.close() };
};

export const watchAndReload = (options: WatchAndReloadOptions): PolicyWatcher => {
  const debounceMs = options.debounceMs ?? 100;
  const watcher = options.watcher ?? defaultWatcher;
  const exists = options.exists ?? existsSync;
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const paths = discoverPolicyPaths(options.resolveOptions);
  const handles: Array<{ close: () => void }> = [];
  let pendingTimer: unknown = null;

  const reloadNow = (): void => {
    try {
      const resolved = resolvePolicy(options.resolveOptions);
      if (resolved.lockConflicts.length > 0) {
        options.onReloadFailed?.(`lock conflicts: ${formatLockConflicts(resolved.lockConflicts)}`);
        return;
      }
      // Forward the freshly-resolved per-section provenance
      // alongside the policy. Without this, every subsequent
      // audit row's `source.layer` and `/perms why` output would
      // point at the construction-time hierarchy — wrong after
      // the first YAML edit that moves a section between layers.
      //
      // Compute the freshly-merged `trustedHosts` list from the
      // new policy and forward too. Without this, an operator who
      // edits `fetch_url.trusted_hosts` (adds an internal CDN,
      // removes a no-longer-trusted host) sees the policy hash
      // advance but the risk-scorer keeps using the construction-
      // time list until process restart — `untrusted_egress`
      // would silently fire (or fail to fire) against the OLD set.
      // Same `mergeTrustedHosts(DEFAULT_TRUSTED_HOSTS, policy.tools
      // .fetch_url?.trusted_hosts ?? [])` idiom bootstrap-engine
      // uses for the construction-time wire.
      const newTrustedHosts = mergeTrustedHosts(
        resolved.policy.tools.fetch_url?.trusted_hosts ?? [],
      );
      const result = options.engine.reloadPolicy(
        resolved.policy,
        resolved.provenance,
        newTrustedHosts,
      );
      if (result.ok) {
        options.onReload?.(result);
      } else {
        options.onReloadFailed?.(result.reason);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      options.onReloadFailed?.(`policy resolve failed: ${reason}`);
    }
  };

  const onFsEvent = (): void => {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
    }
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      reloadNow();
    }, debounceMs);
  };

  for (const path of paths) {
    if (!exists(path)) continue;
    try {
      handles.push(watcher(path, onFsEvent));
    } catch (e) {
      // fs.watch can throw on platforms with no inotify support or
      // on weird filesystems. Surface as a non-fatal warning via
      // onReloadFailed; the engine still works, just without hot
      // reload on this path.
      options.onReloadFailed?.(
        `cannot watch ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    close: () => {
      if (pendingTimer !== null) {
        clearTimer(pendingTimer);
        pendingTimer = null;
      }
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // Watcher already closed or filesystem went away. Best-
          // effort cleanup; no useful diagnostic to emit.
        }
      }
      handles.length = 0;
    },
  };
};
