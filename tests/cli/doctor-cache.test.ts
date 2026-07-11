// Slice 124 — PERMISSION_ENGINE.md §13.8 60s cache for
// non-critical doctor checks. Covers both the unit primitive
// (`withDoctorCache` + `createInMemoryDoctorCache`) and the
// integration into `runDoctor` (non-critical checks cache;
// critical checks bypass).

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DOCTOR_CACHE_TTL_MS,
  NON_CRITICAL_CHECK_NAMES,
  createInMemoryDoctorCache,
  isCacheable,
  resetSharedDoctorCache,
  withDoctorCache,
} from '../../src/cli/doctor-cache.ts';
import { runDoctor } from '../../src/cli/doctor.ts';

const okCheck = (name: string, detail = 'ok'): { name: string; status: 'ok'; detail: string } => ({
  name,
  status: 'ok',
  detail,
});

describe('isCacheable', () => {
  test('returns true for the canonical non-critical check names', () => {
    for (const name of ['platform', 'user_namespaces', 'net_filtering', 'mac_lsm', 'git']) {
      expect(isCacheable(name)).toBe(true);
    }
  });

  test('returns false for critical checks (sandbox, policy_load, hash_chain, fs, sealing)', () => {
    for (const name of [
      'sandbox',
      'policy_load',
      'hash_chain',
      'sealing',
      'config_dir',
      'data_dir',
    ]) {
      expect(isCacheable(name)).toBe(false);
    }
  });

  test('NON_CRITICAL_CHECK_NAMES is the source of truth (no other set diverges)', () => {
    // If a future slice forgets to update NON_CRITICAL_CHECK_NAMES
    // alongside isCacheable, this fence makes the divergence loud.
    for (const name of NON_CRITICAL_CHECK_NAMES) {
      expect(isCacheable(name)).toBe(true);
    }
  });
});

describe('createInMemoryDoctorCache', () => {
  test('get returns null for an unset name', () => {
    const c = createInMemoryDoctorCache();
    expect(c.get('platform', 0)).toBeNull();
  });

  test('set then get within TTL returns the cached check', () => {
    const c = createInMemoryDoctorCache();
    const check = okCheck('platform');
    c.set('platform', check, 60_000, 1_000);
    expect(c.get('platform', 1_500)).toBe(check);
  });

  test('get past expiresAt returns null AND drops the entry', () => {
    const c = createInMemoryDoctorCache();
    c.set('platform', okCheck('platform'), 60_000, 1_000);
    // At exactly the TTL boundary, the entry is expired (now >= expiresAt).
    expect(c.get('platform', 1_000 + 60_000)).toBeNull();
    // Subsequent get with a "now" inside what WOULD have been the
    // TTL still returns null because the expired entry was dropped.
    expect(c.get('platform', 1_000)).toBeNull();
  });

  test('clear empties the cache', () => {
    const c = createInMemoryDoctorCache();
    c.set('platform', okCheck('platform'), 60_000, 1_000);
    c.set('mac_lsm', okCheck('mac_lsm'), 60_000, 1_000);
    c.clear();
    expect(c.get('platform', 1_500)).toBeNull();
    expect(c.get('mac_lsm', 1_500)).toBeNull();
  });

  test('different names are independent', () => {
    const c = createInMemoryDoctorCache();
    c.set('platform', okCheck('platform', 'p'), 60_000, 1_000);
    c.set('mac_lsm', okCheck('mac_lsm', 'm'), 60_000, 1_000);
    expect(c.get('platform', 1_500)?.detail).toBe('p');
    expect(c.get('mac_lsm', 1_500)?.detail).toBe('m');
  });
});

describe('withDoctorCache', () => {
  test('cacheable name + fresh entry → returns cached without re-running', () => {
    const c = createInMemoryDoctorCache();
    let runs = 0;
    const run = (): { name: string; status: 'ok'; detail: string } => {
      runs += 1;
      return okCheck('platform');
    };
    withDoctorCache('platform', run, c, 1_000);
    withDoctorCache('platform', run, c, 1_500);
    withDoctorCache('platform', run, c, 1_999);
    expect(runs).toBe(1);
  });

  test('cacheable name + expired entry → re-runs and caches fresh', () => {
    const c = createInMemoryDoctorCache();
    let runs = 0;
    const run = (): { name: string; status: 'ok'; detail: string } => {
      runs += 1;
      return okCheck('platform');
    };
    withDoctorCache('platform', run, c, 0);
    expect(runs).toBe(1);
    // Past TTL: re-runs.
    withDoctorCache('platform', run, c, DOCTOR_CACHE_TTL_MS + 1);
    expect(runs).toBe(2);
  });

  // Slice 124 (§13.8): the "always live" contract for critical
  // checks means withDoctorCache MUST bypass the cache even when
  // an entry exists. Critical checks (sandbox, policy_load,
  // hash_chain, fs writable, sealing) detect ACTIVE state
  // changes — caching would silently mask them.
  test('critical (non-cacheable) name → always re-runs, never caches', () => {
    const c = createInMemoryDoctorCache();
    let runs = 0;
    const run = (): { name: string; status: 'ok'; detail: string } => {
      runs += 1;
      return okCheck('sandbox');
    };
    withDoctorCache('sandbox', run, c, 0);
    withDoctorCache('sandbox', run, c, 1_000);
    withDoctorCache('sandbox', run, c, 2_000);
    expect(runs).toBe(3);
    // Internal sanity: no entry was ever written for the critical name.
    expect(c.get('sandbox', 0)).toBeNull();
  });
});

describe('runDoctor — §13.8 cache integration (slice 124)', () => {
  const env = { PATH: process.env.PATH };

  beforeEach(() => {
    resetSharedDoctorCache();
  });

  const seamsAllOk = {
    readFile: (path: string): string | null =>
      path === '/proc/sys/user/max_user_namespaces' ? '15000\n' : null,
  };

  const collectChecks = (out: { lines: string[] }): Array<Record<string, unknown>> => {
    return out.lines
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.kind === 'check');
  };

  const captured = (): { lines: string[]; write: (s: string) => void } => {
    const lines: string[] = [];
    return { lines, write: (s) => lines.push(s) };
  };

  test('second runDoctor within 60s reuses cached non-critical checks', async () => {
    let macLsmCalls = 0;
    let userNsReads = 0;
    let nftCalls = 0;
    const cache = createInMemoryDoctorCache();
    const sharedSeams = {
      readFile: (path: string): string | null => {
        if (path === '/proc/sys/user/max_user_namespaces') {
          userNsReads += 1;
          return '15000\n';
        }
        return null;
      },
      runCmd: (cmd: string, _args: readonly string[]): string | null => {
        if (cmd === 'aa-status') {
          macLsmCalls += 1;
          return '';
        }
        if (cmd === 'nft') {
          nftCalls += 1;
          return 'nftables v1.0.9\n';
        }
        return null;
      },
      which: (cmd: string) => {
        if (cmd === 'getenforce') return null;
        return `/usr/bin/${cmd}`;
      },
    };
    // Pin `now` so the TTL window is deterministic.
    const t0 = 1_000_000;
    const t1 = t0 + 30_000; // 30s later — well within 60s TTL.

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t0,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    expect(macLsmCalls).toBe(1);
    expect(userNsReads).toBe(1);
    expect(nftCalls).toBe(1);

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t1,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    // Non-critical checks were CACHED — no second probe.
    expect(macLsmCalls).toBe(1);
    expect(userNsReads).toBe(1);
    expect(nftCalls).toBe(1);
  });

  test('past 60s the cache expires and the probes re-run', async () => {
    let macLsmCalls = 0;
    const cache = createInMemoryDoctorCache();
    const sharedSeams = {
      readFile: seamsAllOk.readFile,
      runCmd: (cmd: string, _args: readonly string[]): string | null => {
        if (cmd === 'aa-status') {
          macLsmCalls += 1;
          return '';
        }
        if (cmd === 'nft') return 'nftables v1.0.9\n';
        return null;
      },
      which: (cmd: string) => {
        if (cmd === 'getenforce') return null;
        return `/usr/bin/${cmd}`;
      },
    };
    const t0 = 1_000_000;
    const t1 = t0 + DOCTOR_CACHE_TTL_MS + 1; // past TTL.

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t0,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    expect(macLsmCalls).toBe(1);

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t1,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    // Cache expired → probe re-ran.
    expect(macLsmCalls).toBe(2);
  });

  // §13.8 critical-check contract: sandbox binary presence, fs
  // writability — these detect active state changes and MUST
  // bypass the cache. Pin that they're called on every runDoctor
  // even within the TTL window.
  //
  // Slice 154 (review): instrument the `exists` seam instead of
  // `which`. Pre-slice the detect probe called `which('bwrap')`
  // every time; pos-slice it tries canonical `/usr/bin/bwrap`
  // first via `exists()` and SKIPS the `which` call when canonical
  // wins. The cache-bypass contract is the same either way — the
  // probe runs — but the test must instrument the path it
  // actually takes.
  test('critical checks (sandbox, config_dir) re-run on every call regardless of cache', async () => {
    let sandboxProbeCount = 0;
    const cache = createInMemoryDoctorCache();
    const sharedSeams = {
      readFile: seamsAllOk.readFile,
      runCmd: (cmd: string, _args: readonly string[]): string | null => {
        if (cmd === 'nft') return 'nftables v1.0.9\n';
        return null;
      },
      which: (cmd: string) => {
        if (cmd === 'getenforce' || cmd === 'aa-status') return null;
        return `/usr/bin/${cmd}`;
      },
      // Slice 154: instrument the canonical-first probe. Every
      // sandboxCheck call hits `exists('/usr/bin/bwrap')` (and
      // /usr/bin/sandbox-exec on darwin).
      exists: (p: string): boolean => {
        if (p === '/usr/bin/bwrap' || p === '/usr/bin/sandbox-exec') {
          sandboxProbeCount += 1;
          return true;
        }
        return p.startsWith('/usr/bin/');
      },
    };
    const t0 = 1_000_000;
    const t1 = t0 + 30_000; // within TTL.

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t0,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    const firstCount = sandboxProbeCount;
    expect(firstCount).toBeGreaterThan(0);

    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t1,
      engineVersion: '0.0.0',
      ...sharedSeams,
      out: captured().write,
    });
    // sandbox check ran AGAIN — canonical-first probe re-invoked.
    expect(sandboxProbeCount).toBeGreaterThan(firstCount);
  });

  // Pin that the cache stores the actual check results, not a
  // stale reference — flipping the underlying state (e.g.,
  // `aa-status` newly reports failure) AFTER the TTL must show
  // up in the next runDoctor's check output.
  test('cached result reflects the state at cache time, not at read time', async () => {
    let firstCallReturnsOk = true;
    const cache = createInMemoryDoctorCache();
    const seams = {
      readFile: seamsAllOk.readFile,
      runCmd: (cmd: string, _args: readonly string[]): string | null => {
        if (cmd === 'aa-status') return firstCallReturnsOk ? '' : null;
        if (cmd === 'nft') return 'nftables v1.0.9\n';
        return null;
      },
      which: (cmd: string) => {
        if (cmd === 'getenforce') return null;
        return `/usr/bin/${cmd}`;
      },
    };
    const t0 = 1_000_000;
    const t1 = t0 + 30_000;
    const t2 = t0 + DOCTOR_CACHE_TTL_MS + 1;

    const out1 = captured();
    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t0,
      engineVersion: '0.0.0',
      ...seams,
      out: out1.write,
    });
    const macLsm1 = collectChecks(out1).find((c) => c.name === 'mac_lsm');
    expect(macLsm1?.status).toBe('ok');

    // Flip the underlying state. Inside TTL — should still see
    // the cached 'ok' result.
    firstCallReturnsOk = false;
    const out2 = captured();
    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t1,
      engineVersion: '0.0.0',
      ...seams,
      out: out2.write,
    });
    const macLsm2 = collectChecks(out2).find((c) => c.name === 'mac_lsm');
    expect(macLsm2?.status).toBe('ok');

    // Past TTL — cache expires, re-probes, surfaces the new
    // failure state.
    const out3 = captured();
    await runDoctor({
      json: true,
      env,
      cache,
      now: () => t2,
      engineVersion: '0.0.0',
      ...seams,
      out: out3.write,
    });
    const macLsm3 = collectChecks(out3).find((c) => c.name === 'mac_lsm');
    expect(macLsm3?.status).toBe('warn');
  });
});
