// Boot-time integration for memory governance defaults (Slice Q).
//
// Asserts:
//   - Fresh repo (no `.agent/`, no user config) boots with both
//     detectors resolved=ON via the hardcoded default.
//   - `HarnessConfig.memorySemanticVerify` + `memoryConflictDetect`
//     reflect the precedence chain (CLI > project > user > default).
//   - `memorySemanticVerifySource` provenance is `'default' |
//     'cli' | 'project-config' | 'user-config'`.
//   - First-boot stderr banner fires once per machine (marker file
//     gate); `--json` mode suppresses it; explicit CLI flag or any
//     config layer touching either key suppresses it.
//   - Banner marker dir defaults to `~/.local/share/forja/` but can
//     be overridden / disabled via `BootstrapInput.governanceBanner
//     MarkerDir` for CI determinism.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../../src/cli/bootstrap.ts';
import { setWritableCacheDirsOverride } from '../../src/permissions/sandbox-cache-dirs.ts';
import { setCachePersistenceOverride } from '../../src/permissions/sandbox-cache-env.ts';
import type { Provider } from '../../src/providers/index.ts';

let workdir: string;
let dbPath: string;
let markerDir: string;
let originalKey: string | undefined;
let originalXdg: string | undefined;
let originalXdgCache: string | undefined;
let stderrChunks: string[];
let originalStderrWrite: typeof process.stderr.write;

const mockProvider: Provider = {
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  // biome-ignore lint/correctness/useYield: never reaches yield
  async *generate() {
    throw new Error('not used');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
};

const captureStderr = () => {
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
};

const restoreStderr = () => {
  process.stderr.write = originalStderrWrite;
};

const stderrJoined = () => stderrChunks.join('');

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-bootstrap-mem-'));
  dbPath = join(workdir, 'sessions.db');
  markerDir = join(workdir, 'marker');
  originalKey = process.env.ANTHROPIC_API_KEY;
  // Pin XDG_CONFIG_HOME to workdir so the loader looks for the
  // user-layer config at `<workdir>/agent/config.toml` (which we
  // never create) instead of the developer's real ~/.config.
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workdir;
  // Persistence toggles default ON → pin the cache home to the workdir so
  // bootstrap's cache mkdir + session tmpdir land here (swept by the
  // afterEach rmSync), not in the dev's real ~/.cache, and emit no stderr
  // the banner assertions would see.
  originalXdgCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = workdir;
  captureStderr();
});

afterEach(() => {
  restoreStderr();
  // Persistence toggles are process-global; bootstrap() sets them
  // (default-ON). Reset so they don't leak into other test files.
  setCachePersistenceOverride(undefined);
  setWritableCacheDirsOverride(undefined);
  rmSync(workdir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCache;
});

describe('bootstrap: memory governance defaults', () => {
  test('fresh repo: detectors default ON via the default source', async () => {
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(true);
    expect(config.memoryConflictDetect).toBe(true);
    expect(config.memorySemanticVerifySource).toBe('default');
    expect(config.memoryConflictDetectSource).toBe('default');
    db.close();
  });

  test('first boot emits banner; second boot stays silent (marker gate)', async () => {
    const args = {
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    } as const;
    const first = await bootstrap(args);
    first.db.close();
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
    expect(existsSync(join(markerDir, '.governance-banner-shown'))).toBe(true);
    // Second boot: marker exists -> banner stays silent.
    stderrChunks = [];
    const second = await bootstrap({
      ...args,
      dbPath: join(workdir, 'sessions2.db'),
    });
    second.db.close();
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
  });

  test('--json mode suppresses banner even on first boot', async () => {
    const { db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
      json: true,
    });
    db.close();
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    // Marker not written when banner was suppressed pre-write — but
    // the gate evaluates suppression BEFORE the marker check, so
    // no marker file should appear either.
    expect(existsSync(join(markerDir, '.governance-banner-shown'))).toBe(false);
  });

  test('explicit CLI override suppresses banner + bumps source to "cli"', async () => {
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
      memorySemanticVerify: false,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('cli');
    // conflict still defaults — but the "both from default" gate
    // fails because verify is from CLI, so banner is suppressed.
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('project config disabling verify suppresses banner + sets source', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = true
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('project-config');
    // conflict_detect_llm = true is explicit in project config —
    // source is 'project-config', not 'default', so banner gate
    // (both-from-default) fails and stays silent.
    expect(config.memoryConflictDetect).toBe(true);
    expect(config.memoryConflictDetectSource).toBe('project-config');
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('user config disabling conflict suppresses banner + sets source', async () => {
    // XDG_CONFIG_HOME points at workdir -> user-layer file lives at
    // <workdir>/agent/config.toml (see userConfigPath in
    // src/config/loaders.ts).
    mkdirSync(join(workdir, 'agent'), { recursive: true });
    writeFileSync(
      join(workdir, 'agent', 'config.toml'),
      `[memory]
conflict_detect_llm = false
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memoryConflictDetect).toBe(false);
    expect(config.memoryConflictDetectSource).toBe('user-config');
    // verify still on; banner suppressed because conflict isn't from default.
    expect(config.memorySemanticVerify).toBe(true);
    expect(config.memorySemanticVerifySource).toBe('default');
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('project wins over user when both touch verify', async () => {
    mkdirSync(join(workdir, 'agent'), { recursive: true });
    writeFileSync(
      join(workdir, 'agent', 'config.toml'),
      `[memory]
verify_semantic_llm = true
`,
    );
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('project-config');
    db.close();
  });

  test('marker dir = null disables marker entirely (banner re-fires)', async () => {
    const args = {
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: null,
    } as const;
    const first = await bootstrap(args);
    first.db.close();
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
    stderrChunks = [];
    const second = await bootstrap({ ...args, dbPath: join(workdir, 'sessions2.db') });
    second.db.close();
    // Marker dir disabled -> banner fires every boot.
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
  });

  test('malformed [memory] value surfaces in BootstrapResult.memoryConfigWarnings', async () => {
    // Post-review fix: loadMemoryConfig records warnings for bad
    // values but bootstrap never propagated them to BootstrapResult.
    // Operator who typed `verify_semantic_llm = "false"` (string
    // instead of boolean) was silently kept on the default-on
    // detector and paid LLM-judge cost with no diagnostic.
    //
    // Pin: malformed value lands a warning AND the field falls back
    // to default (true). Both observations needed — the warning is
    // useless if the field actually opted out silently, and the
    // fallback is the very behavior that makes the warning
    // load-bearing.
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      '[memory]\nverify_semantic_llm = "false"\nconflict_detect_llm = "no"\noverride_detect_llm = 0\n',
    );
    const result = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    try {
      // Each bad value produces a warning; loader didn't silently swallow.
      expect(result.memoryConfigWarnings.length).toBeGreaterThanOrEqual(3);
      const joined = result.memoryConfigWarnings.join('\n');
      expect(joined).toContain('verify_semantic_llm');
      expect(joined).toContain('conflict_detect_llm');
      expect(joined).toContain('override_detect_llm');
      // Fields fell back to defaults (true) — the operator's opt-out
      // attempt did NOT take effect, so the diagnostic is the only
      // path to fix.
      expect(result.config.memorySemanticVerify).toBe(true);
      expect(result.config.memoryConflictDetect).toBe(true);
      expect(result.config.memoryOverrideDetect).toBe(true);
    } finally {
      result.db.close();
    }
  });

  test('loads [memory] from repo-root .agent/config.toml when launched from a subdirectory (post-review)', async () => {
    // Pre-fix: loadMemoryConfig received the raw invocation cwd, so
    // bootstrap from `<repo>/src/sub` read `<repo>/src/sub/.agent/
    // config.toml` (nonexistent) and missed the operator's actual
    // opt-out at `<repo>/.agent/config.toml`. Default-on detectors
    // re-enabled silently, LLM budget burned despite the configured
    // disable.
    //
    // Post-fix: bootstrap hoists `resolveRepoRoot(cwd)` once and
    // passes it to BOTH config loaders + the memory scope-roots
    // construction. Symmetric with the trigger-probe fix
    // documented inline at the registry construction site.
    //
    // Setup: `git init` the workdir so resolveRepoRoot finds the
    // root via `git rev-parse --show-toplevel`. Drop the opt-out
    // config at the root. Bootstrap with cwd = subdir.
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q', workdir], { stdio: 'ignore' });
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      '[memory]\nverify_semantic_llm = false\n',
    );
    const subdir = join(workdir, 'src', 'components');
    mkdirSync(subdir, { recursive: true });
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: subdir, // operator launched from a subdir
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    try {
      // Repo-root opt-out resolved correctly even though bootstrap
      // was launched from a subdir.
      expect(config.memorySemanticVerify).toBe(false);
      expect(config.memorySemanticVerifySource).toBe('project-config');
      // Untouched detectors keep the default (their absent keys
      // shouldn't shadow user/default layers — separate fix
      // `3bfba73`).
      expect(config.memoryConflictDetect).toBe(true);
      expect(config.memoryOverrideDetect).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('bootstrap — auditConfigWarnings propagation', () => {
  // Operator-reported bug: loadRetentionConfig produces warning
  // strings for invalid [audit] / [audit.retention] values, but
  // bootstrap previously consumed only `auditLoaded.config` and
  // dropped `auditLoaded.warnings` on the floor — no field on
  // BootstrapResult carried them. The CLI driver (run.ts) and
  // REPL (repl.ts) renderers had no surface to iterate.
  //
  // Operators typing `[audit.retention].context_pins = "ninety"`
  // (string instead of int) would silently keep the 90-day
  // default. Operators typing `[audit].run_gc_on_stp = true`
  // (typo) would silently NOT enable the Stop-hook gc trigger.
  // Both are deletion-policy decisions; running with unintended
  // retention windows or unintended sweep timing is operationally
  // riskier than the other config loaders' fallback behavior.
  //
  // Fix: BootstrapResult.auditConfigWarnings carries the same
  // strings; run.ts + repl.ts iterate them with the
  // `forja: audit config: ...` prefix. These pins lock the
  // propagation so a future refactor that drops the wire (or
  // re-orders the bootstrap return) lands the failure here.

  test('malformed [audit.retention] value surfaces in BootstrapResult.auditConfigWarnings + falls back to defaults', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      [
        '[audit.retention]',
        'context_pins = "ninety"', // string instead of int days
        'bg_processes = -1', // non-positive
        'recap_cache = "not-a-duration"', // unparseable TTL string
      ].join('\n'),
    );
    const result = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    try {
      // Each bad value produced a warning, and the field surface
      // carries all three.
      expect(result.auditConfigWarnings.length).toBeGreaterThanOrEqual(3);
      const joined = result.auditConfigWarnings.join('\n');
      expect(joined).toContain('context_pins');
      expect(joined).toContain('bg_processes');
      expect(joined).toContain('recap_cache');
      // Bad values fell back to defaults — the operator's intended
      // override did NOT take effect. Without the warnings being
      // propagated, the operator would be silently running with
      // unintended retention windows.
      expect(result.config.auditRetention?.context_pins_days).toBe(90);
      expect(result.config.auditRetention?.bg_processes_days).toBe(30);
      expect(result.config.auditRetention?.recap_cache_ttl_ms).toBe(60 * 60 * 1000);
    } finally {
      result.db.close();
    }
  });

  test('typo under [audit].* (sibling of [audit.retention]) surfaces a warning', async () => {
    // Operator typed `run_gc_on_stp` (missing 'o') — the typo
    // guard in parseLayer should fire AND the actual flag should
    // default to false (Stop-hook gc trigger remains off).
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      '[audit]\nrun_gc_on_stp = true\n', // typo: missing the second 'o'
    );
    const result = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    try {
      expect(result.auditConfigWarnings.length).toBeGreaterThan(0);
      const joined = result.auditConfigWarnings.join('\n');
      expect(joined).toContain('run_gc_on_stp');
      expect(joined).toContain('not a known audit key');
      // The intended toggle did NOT take effect — runGcOnStop is
      // still its default (false). The warning is the operator's
      // only signal that the Stop-hook gc trigger they thought
      // they enabled is actually not enabled.
      expect(result.config.auditRetention?.runGcOnStop).toBe(false);
    } finally {
      result.db.close();
    }
  });

  test('clean [audit] config produces an empty auditConfigWarnings array (no false positives)', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      [
        '[audit]',
        'run_gc_on_stop = true',
        '',
        '[audit.retention]',
        'context_pins = 30',
        'recap_cache = "5m"',
      ].join('\n'),
    );
    const result = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    try {
      expect(result.auditConfigWarnings).toEqual([]);
      expect(result.config.auditRetention?.runGcOnStop).toBe(true);
      expect(result.config.auditRetention?.context_pins_days).toBe(30);
      expect(result.config.auditRetention?.recap_cache_ttl_ms).toBe(5 * 60 * 1000);
    } finally {
      result.db.close();
    }
  });
});
