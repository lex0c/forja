import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRetentionConfig } from '../audit/config-loader.ts';
import {
  type Broker,
  type SandboxRunner,
  createBashHandler,
  createInProcessBroker,
  createSpawnBroker,
} from '../broker/index.ts';
import {
  DEFAULT_CACHE_PERSISTENCE,
  DEFAULT_SHARED_TMP,
  loadBudgetConfig,
  loadEffortConfig,
  loadMemoryConfig,
  loadProvidersConfig,
  loadRecapConfig,
  loadSandboxConfig,
} from '../config/loaders.ts';
import { createSqliteFailureSink } from '../failures/index.ts';
import { DEFAULT_EFFORT } from '../harness/effort.ts';
import type { HarnessConfig, RunBudget } from '../harness/index.ts';
import {
  type HookConfigWarning,
  resolveHookConfig,
  resolveHookPaths,
  resolveHookShell,
} from '../hooks/index.ts';
import {
  computeSharedFingerprint,
  createMemoryRegistry,
  evaluateBootTriggers,
  gcExpiredMemories,
  gcPurgeExpiredTombstones,
  gcStaleInvalidatedMemories,
  getSharedTrust,
  probeSharedTrust,
  resolveRepoRoot,
  resolveScopeRoots,
} from '../memory/index.ts';
import type { ProbeSharedTrustResult } from '../memory/index.ts';
import { createSqliteOutcomeSink } from '../outcomes/index.ts';
import {
  type ApprovalPosture,
  type LockConflict,
  type SandboxAvailability,
  type SandboxTmpdir,
  acquireSandboxTmpdir,
  bootstrapPermissionEngine,
  detectSandboxAvailability,
  generateUlid,
  maybeWrapSandboxArgv,
  preflightPermissionEngine,
} from '../permissions/index.ts';
import { setWritableCacheDirsOverride } from '../permissions/sandbox-cache-dirs.ts';
import { setCachePersistenceOverride } from '../permissions/sandbox-cache-env.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { Provider } from '../providers/index.ts';
import { resolveProviderFromId } from '../providers/resolve.ts';
import type { SystemSegment } from '../providers/types.ts';
import { scrubEnv } from '../sanitize/index.ts';
import { redactSecrets } from '../sanitize/secrets.ts';
import {
  createSkillCatalog,
  resolveScopeRoots as resolveSkillScopeRoots,
} from '../skills/index.ts';
import { type DB, closeDb, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { forjaCachePersistBase } from '../storage/paths.ts';
import {
  GOVERNANCE_PROPOSAL_TTL_MS,
  expirePendingProposals,
} from '../storage/repos/memory-governance.ts';
import {
  MEMORY_PROVENANCE_RETENTION_MS,
  pruneMemoryProvenance,
} from '../storage/repos/memory-provenance.ts';
import {
  MEMORY_VERIFY_ATTEMPTS_RETENTION_MS,
  pruneVerifyAttempts,
} from '../storage/repos/memory-verify-attempts.ts';
import {
  hashPromptContent,
  recordPromptVersion,
  resolveAuthor,
} from '../storage/repos/prompt-versions.ts';
import { setRecapCacheTtlOverride } from '../storage/repos/recap-cache.ts';
import { type SubagentSet, loadSubagents, validateSubagentSet } from '../subagents/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { isTrusted, trustListPath } from '../trust/index.ts';
import { composeWithConstraints } from './constraints-prompt.ts';
import { composeWithEnvironment } from './environment-prompt.ts';
import { probeGitContext } from './git-context.ts';
import { composeWithIdentity } from './identity-prompt.ts';
import { localIsoDate } from './local-date.ts';
import { assembleMemorySection, composeSystemPrompt } from './memory-prompt.ts';
import { composeWithOutputStyle } from './output-style-prompt.ts';
import { composeWithParallelHint } from './parallel-prompt.ts';
import { composeWithPlaybookHint } from './playbook-prompt.ts';
import { assembleProjectContext, composeWithProjectContext } from './project-context.ts';
import { composeWithResponseFormat } from './response-format.ts';
import { assembleSkillCatalogSection } from './skills-prompt.ts';
import { composeWithToolErgonomics } from './tool-ergonomics-prompt.ts';

// Re-export from the dependency-free home so existing import sites
// keep working. New code should prefer `src/providers/default-model.ts`
// directly — importing it doesn't drag in this module's full
// transitive closure (storage, providers, hooks, ...) on lighter
// paths like `agent init`.
export { DEFAULT_MODEL } from '../providers/default-model.ts';
import { DEFAULT_MODEL } from '../providers/default-model.ts';

export interface BootstrapInput {
  prompt: string;
  modelId?: string;
  // `--no-recap` global flag: forces `recapEnabled=false` regardless
  // of `[recap].enabled` config.
  noRecap?: boolean;
  cwd?: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  // Initial approval posture seed (AGENTIC_CLI §8). CLI `--autonomous`
  // routes here; bootstrap forwards it to bootstrapPermissionEngine →
  // EngineOptions.approvalPosture. Absent ⇒ supervised (the safe
  // default). Distinct from the execution profile.
  approvalPosture?: ApprovalPosture;
  // Caller-supplied system prompt. Layered as the most-specific
  // chunk beneath the playbook / ergonomics / parallelism stack.
  systemPrompt?: string;
  // Sampling temperature plumbed straight to HarnessConfig.
  // Evals set this to 0 for deterministic runs.
  temperature?: number;
  // Resume mode (AGENTIC_CLI §2.1): when set, the harness skips
  // createSession and continues the named session by reloading
  // its persisted messages and appending `prompt` as the new
  // user turn. Caller (CLI run.ts) is responsible for resolving
  // `last` aliases before constructing this — bootstrap takes a
  // concrete id only.
  resumeFromSessionId?: string;
  // Test seam: when set, skip the registry lookup and use this provider.
  providerOverride?: Provider;
  // Test seam: override the DB path (default: defaultDbPath()).
  dbPath?: string;
  // Test seams for the permission hierarchy. `null` disables the
  // corresponding layer entirely (e.g., tests that don't want to
  // touch /etc/agent or ~/.config/agent).
  enterprisePolicyPath?: string | null;
  userPolicyPath?: string | null;
  // Test seams for subagent discovery. `null` disables the
  // corresponding scope; absent uses the default path. Mirrors
  // the permission-layer test seams above.
  userAgentsDir?: string | null;
  projectAgentsDir?: string | null;
  // Test seam for trust-list discovery. Mirrors the REPL's
  // `trustListPathOverride`:
  //   - undefined → use `trustListPath()` (production default)
  //   - null      → trust storage unavailable (cwd treated as
  //                 untrusted, fail-closed)
  //   - string    → use this path (test fixtures isolate from the
  //                 user's real `~/.config/agent/trusted_dirs.json`)
  // The resolved value drives `HarnessConfig.isCwdTrusted`, which
  // memory_write's trust gate consumes (spec MEMORY.md §7.2.1).
  trustListPathOverride?: string | null;
  // Operator-supplied override to continue boot under a known-broken
  // audit chain (PERMISSION_ENGINE.md §7.2). Default false: a broken
  // chain refuses the engine. When true, a `chain-break-accepted`
  // audit row is emitted before the engine accepts new decisions —
  // the override itself is audited.
  acceptBrokenChain?: boolean;
  // Operator-supplied flag enabling the `host` sandbox profile
  // (PERMISSION_ENGINE.md §6.5). When true AND the resolved
  // capabilities include `host-passthrough`, the sandbox planner
  // may pick `host` as a fallback when no restricted profile
  // covers. Without this flag, `host` is pruned from the candidate
  // set unconditionally.
  sandboxHost?: boolean;
  // Test seam — pins the `detectSandboxAvailability` result instead
  // of probing the host. Production callers never pass this; tests
  // that exercise both branches of the default-broker resolver
  // (sandbox-present → spawn, sandbox-absent → in-process) inject a
  // synthetic SandboxAvailability so the verdict doesn't depend on
  // the runner host's state. Same posture as `enterprisePolicyPath`/
  // `userPolicyPath`: production omits, tests can pin.
  sandboxAvailabilityOverride?: SandboxAvailability;
  // §13.7 broker mode (slice 87). Explicit override; when omitted,
  // bootstrap picks dynamically: `'spawn'` when the host has a
  // working sandbox tool (`detectSandboxAvailability().available`),
  // `'in-process'` otherwise. Rationale: a host with bwrap/
  // sandbox-exec installed should get enforcement by default —
  // operators that need lower per-call latency override with
  // `--broker in-process` explicitly. `'spawn'` wires
  // `createSpawnBroker` (worker via `bun run worker.ts` on source
  // checkouts, self-exec via `process.execPath + FORJA_BROKER_WORKER=1`
  // on compiled binaries); `'in-process'` wires the degenerate
  // in-process broker (bash exec stays in main, same behavior as
  // pre-§13.7). Operator override always wins over the dynamic
  // default — the value here is treated as load-bearing intent
  // even when the resolved default would have differed.
  brokerMode?: 'in-process' | 'spawn';
  // S11 opt-in for the LLM-judge semantic verifier (MEMORY.md §11.x).
  // Default false; threaded straight through to HarnessConfig.
  // memorySemanticVerify. The CLI run.ts surfaces this from
  // `args.memoryVerifyLlm`; programmatic callers (tests) pass it
  // directly.
  memorySemanticVerify?: boolean;
  // S13 opt-in for the LLM-judge conflict detector. Independent of
  // memorySemanticVerify. CLI surfaces from `args.memoryConflictLlm`.
  memoryConflictDetect?: boolean;
  // S3 opt-in for the LLM-judge override detector. Independent of
  // memorySemanticVerify + memoryConflictDetect. CLI surfaces from
  // `args.memoryOverrideLlm` (S3.5 follow-up wires the flag).
  memoryOverrideDetect?: boolean;
  // Slice Q — suppress operator-facing stderr banners when the CLI
  // is producing structured NDJSON. The boot banner for the default-
  // ON governance detectors fires when both resolve via default;
  // setting this to `true` suppresses it unconditionally, mirroring
  // the existing "stderr is for logs" stack rule (CLAUDE.md). When
  // omitted, the banner emits per its own gating logic.
  json?: boolean;
  // Slice Q — directory for the first-boot banner marker
  // (~/.local/share/forja/.governance-banner-shown by default).
  // The banner is suppressed once the marker exists. Tests pass an
  // isolated tmp dir to avoid polluting the operator's real state.
  // `null` disables the marker entirely (banner fires every boot
  // when other gates pass — useful for CI environments that scrape
  // first-boot output deterministically).
  governanceBannerMarkerDir?: string | null;
  // Shared-corpus trust modal callback (MEMORY.md §6.5.2
  // `trust_revoked` detector, S5/T5.2). Fired by `probeSharedTrust`
  // when the operator previously confirmed trust for this scope-
  // root but the corpus' SHA-256 has since diverged. Caller (REPL
  // boot) wraps `modalManager.askSharedTrust` in a thin adapter.
  // When undefined, the probe is SKIPPED entirely — bootstrap
  // doesn't seed, doesn't prompt, doesn't bulk-invalidate. Use
  // case: tests / headless invocations that don't have a TUI and
  // shouldn't be silently auto-accepting drifted corpora. Production
  // REPL always passes the modal callback; an explicit
  // `() => Promise.resolve('yes')` is the way to opt into "auto-
  // accept" semantics with an audit trail (the probe records the
  // reconfirmed transition with a real timestamp).
  askSharedTrust?: (args: {
    path: string;
    mode: import('../memory/index.ts').SharedTrustModalMode;
    corpusFiles: readonly { name: string; bytes: number }[];
  }) => Promise<'yes' | 'no' | 'cancel'>;
}

// §13.7 sandbox-enforcement snapshot — captured at bootstrap time so
// the REPL boot banner (and any future operator-facing surface) can
// report "is bash actually being wrapped?" without re-running the
// probe or duplicating the resolver. Mirrors the verdict that
// `doctor`'s `sandbox_enforcement` check would compute from the
// same `sandboxAvail` + `resolvedBrokerMode` state.
//
// `active` is true iff the broker is going to wrap bash spawns at
// runtime — that requires BOTH a working sandbox tool AND
// spawn-mode. Every other combination produces `active: false`
// with a `reason` that distinguishes:
//   - 'no-tool'             → sandbox binary absent; broker default
//                             fell back to in-process.
//   - 'operator-override'   → sandbox available, operator forced
//                             `--broker in-process` explicitly.
//   - 'degraded-passthrough'→ operator forced `--broker spawn` but
//                             sandbox binary missing; spawn runs
//                             unwrapped (the runner's degraded
//                             passthrough path; see
//                             sandbox-runner.ts:660-668).
export interface SandboxEnforcementSnapshot {
  active: boolean;
  tool: 'bwrap' | 'sandbox-exec' | null;
  reason: 'active' | 'no-tool' | 'operator-override' | 'degraded-passthrough';
}

export interface BootstrapResult {
  config: HarnessConfig;
  db: DB;
  modelId: string;
  // SHA256 hex of the assembled system prompt, recorded in
  // `prompt_versions` (AUDIT.md §1.3). Undefined only when no
  // prompt was assembled (test fixtures bypassing composition);
  // the production path always sets it. Harness consumers stamp
  // this on every `messages.prompt_hash` / `tool_calls.prompt_hash`
  // row so the §1.3.5 join queries can trace any audit row back to
  // the exact prompt that produced it.
  systemPromptHash?: string;
  // Which layers contributed to the effective policy. `'default'`
  // means no layer file was found anywhere — engine falls back to
  // strict + empty rules.
  policyLayers: ('enterprise' | 'user' | 'project' | 'session')[];
  // Lock conflicts surfaced by the hierarchy resolver. Empty in the
  // happy path; non-empty when a lower layer tried to override a
  // section that a higher layer locked. Caller (CLI run.ts) prints
  // these as warnings to stderr.
  lockConflicts: LockConflict[];
  // Subagent definitions discovered under user/project scopes. The
  // CLI surfaces shadows on stderr as warnings; the runtime uses
  // `byName` for resolution. Empty when no .md files are found
  // anywhere.
  subagents: SubagentSet;
  // Per-layer warnings emitted by the hooks loader (spec
  // AGENTIC_CLI.md §10.4): missing matcher fields, unknown event
  // names, locked-section conflicts, parse errors. Empty in the
  // happy path. CLI driver renders them on stderr alongside the
  // policy lockConflicts warnings.
  hookWarnings: readonly HookConfigWarning[];
  // Warnings from the memory governance config loader
  // (`.agent/config.toml [memory]` keys). Loader degrades to
  // defaults (currently default-ON) on bad values rather than
  // aborting boot — without this surface, an operator who writes
  // `verify_semantic_llm = "false"` (string instead of boolean)
  // would silently keep the default-on detector running and pay
  // the LLM-judge cost without diagnostic. CLI driver renders
  // these on stderr alongside the hook warnings.
  memoryConfigWarnings: readonly string[];
  // Warnings from the providers + budget config loaders
  // (`.agent/config.toml [providers|budget]`). Same fail-soft
  // posture as the others: bad value → warning + degrade, not
  // a hard abort.
  providersConfigWarnings: readonly string[];
  budgetConfigWarnings: readonly string[];
  // Warnings from the `[recap]` loader (unknown render_model, bad
  // enabled type → warning + ignore).
  recapConfigWarnings: readonly string[];
  // Warnings from the `[effort].level` loader (unknown level →
  // warn + fall back to DEFAULT_EFFORT). Same fail-soft posture.
  effortConfigWarnings: readonly string[];
  // §13.7 enforcement state at boot — surfaces "is bash being
  // wrapped?" for the REPL banner + any future operator-facing
  // surface that needs to mirror what doctor reports. See
  // `SandboxEnforcementSnapshot` for the discriminator.
  sandboxEnforcement: SandboxEnforcementSnapshot;
  // Warnings from the audit / retention config loader
  // (`.agent/config.toml [audit]` and `[audit.retention]`). Loader
  // degrades to defaults on bad values rather than aborting boot —
  // without this surface, an operator who typed
  // `[audit.retention].context_pins = "ninety"` (string instead
  // of integer days) would silently keep the 90-day default, OR
  // an operator who typed `[audit].run_gc_on_stp = true` (typo)
  // would silently NOT enable the Stop-hook gc trigger. Both
  // are deletion-policy decisions; running with unintended
  // retention windows is operationally risky in a way that
  // demands the same diagnostic visibility as the other config
  // loaders. CLI driver renders these on stderr alongside the
  // memory / hook / providers / budget warnings.
  auditConfigWarnings: readonly string[];
  // Warnings from the `[sandbox] writable_cache_dirs` loader — an
  // entry dropped for being non-string / absolute / containing `..`
  // (sanitizeWritableCacheDirs). Surfaced so an operator whose entry
  // was silently ignored (and is now wondering why their build still
  // can't write its cache) sees why, on the same stderr banner.
  sandboxConfigWarnings: readonly string[];
  // Final state of the permission engine after bootstrap walked
  // init → loading-policy → validating-chain → ready/refusing.
  // When this is `refusing`, the engine is a deny-everything stub
  // and the CLI driver MUST short-circuit to a non-zero exit
  // (run.ts handles the dispatch).
  permissionState: import('../permissions/index.ts').EngineState;
  // Reason supplied to the refusing transition (when state is
  // `refusing`). Caller surfaces it on stderr.
  permissionRefusingReason?: string;
  // Audit chain integrity result captured at bootstrap (§7.2). The
  // CLI driver renders an explicit "chain ok / broken at seq N"
  // line so the operator sees the state on every boot.
  permissionChain: import('../permissions/index.ts').VerifyResult;
  // Per-installation identity (`~/.config/agent/install_id`) bound
  // to the active audit chain. The CLI surfaces this in
  // diagnostics so operators can correlate logs across machines.
  installIdentity: import('../permissions/index.ts').InstallIdentity;
  // Outcome of the shared-corpus trust probe (S5/T5.2). Undefined
  // when:
  //   - `askSharedTrust` was not supplied (headless / tests), or
  //   - the cwd was not trusted at boot (operator must first
  //     confirm cwd trust before shared-trust kicks in), or
  //   - bootstrap aborted before the memory subsystem finished
  //     initializing (rare — try-block early throw).
  // Present in the production REPL path. Callers render warnings on
  // `revoked` and may surface a count on `reconfirmed` so the
  // operator sees the trust action they just took echoed back.
  sharedTrustProbe?: import('../memory/trust-corpus-probe.ts').ProbeSharedTrustResult;
}

// Build a HarnessConfig from environment + cwd + args. This is the main
// entry-shaped wiring: read API key from env (the adapter does it), open
// the DB, migrate, register builtins, load policy from `.agent/permissions.yaml`
// if present, instantiate the provider from the registry. Any failure
// (unknown model, missing API key) bubbles up — the caller decides whether
// to print to stderr and exit 1.
export const bootstrap = async (input: BootstrapInput): Promise<BootstrapResult> => {
  const cwd = input.cwd ?? process.cwd();
  // Resolve home ONCE and thread through every consumer (slice 109,
  // R8 #323). Pre-slice the preflight and bootstrap stages each
  // computed home independently via a `input.home ?? env.HOME ??
  // process.env.HOME ?? input.cwd` fallback chain. On $HOME-unset
  // hosts (containers, CI workers, systemd one-shots) the chain
  // landed on cwd — making `~/.bashrc` resolve to `<cwd>/.bashrc`,
  // which broke every §11 tilde-rooted protected-path check
  // (the classifier looks for HOME-prefixed paths; cwd-prefixed
  // paths never match).
  //
  // `os.homedir()` is the canonical resolver: handles platform-
  // specific lookups (USERPROFILE on Windows, $HOME on Unix), with
  // the same cwd fallback the engine accepts when no home is
  // discoverable. Threaded explicitly into both preflight and
  // bootstrap so the engine sees a single resolved home value.
  const home = homedir();

  // Resolve everything that *can throw* before opening the DB, so a
  // policy YAML error or unknown model doesn't leak a SQLite handle
  // (and the WAL files that come with it).
  let provider: Provider;
  // Build the registry once and share it across the executor and the
  // providers-config loader. Creating independent default registries
  // would double the model-table import cost for no benefit.
  const registry = createDefaultRegistry();

  // Resolve project config root EARLY (needed by the providers
  // loader before model resolution). `resolveRepoRoot` walks up
  // from cwd looking for a git root and falls back to cwd when
  // none is found — so `<repo>/.agent/config.toml` resolves the
  // same way whether the operator invoked from the repo root or
  // a subdirectory. Without this resolve, a `<repo>/.agent/
  // config.toml [providers] model = "..."` would be invisible when
  // the operator ran `agent` from a subdir, and the boot would
  // silently use DEFAULT_MODEL. Reused below for [memory] / [budget]
  // loaders — same file, same path resolution.
  const projectConfigCwd = resolveRepoRoot(cwd);

  // [providers] model — pin per-project. Resolution chain:
  //   CLI flag (input.modelId) > project [providers].model
  //                            > user    [providers].model
  //                            > DEFAULT_MODEL.
  // Unknown ids in the config file degrade to a warning + null
  // (caller falls back to DEFAULT_MODEL); the CLI override is
  // strict and throws below if registry.get returns null.
  const providersLoaded = loadProvidersConfig({ cwd: projectConfigCwd, registry });
  const modelId = input.modelId ?? providersLoaded.config.model ?? DEFAULT_MODEL;

  if (input.providerOverride !== undefined) {
    provider = input.providerOverride;
  } else {
    const resolved = resolveProviderFromId(registry, modelId);
    if (!resolved.ok) {
      // Strict here (unlike the config-file degrade-to-default path):
      // a CLI override or resolved config model that can't be built is
      // a hard boot error. `unknown` lists the registry; `factory-error`
      // (e.g. missing API key) propagates the SDK message — the headless
      // recap path keys its deterministic-fallback whitelist on it.
      throw new Error(
        resolved.kind === 'unknown'
          ? `unknown model: ${modelId}. Known: ${resolved.knownIds.join(', ')}`
          : resolved.message,
      );
    }
    provider = resolved.provider;
  }

  // [budget] config — resolves before the harness builds its
  // RunBudget. Per-key merge: project [budget].max_steps wins
  // over user, both override DEFAULT_BUDGET in code. CLI flags
  // (input.budget) win over both layers. Loader degrades to
  // defaults on bad values rather than aborting boot.
  //
  // `projectConfigCwd` was resolved above (early in this function —
  // see the long comment near the providers loader). The same
  // repo-rooted cwd is reused here so [memory] / [budget] all read
  // the SAME `.agent/config.toml` the providers loader already
  // consumed. When `agent` is launched from a subdirectory, raw cwd
  // would miss the repo-rooted file entirely — the operator would
  // set `verify_semantic_llm = false` at `<repo>/.agent/config.toml`
  // and bootstrap would still resolve detectors via default + spend
  // LLM budget. resolveRepoRoot falls back to cwd when not in a git
  // repo, matching the historical "config lives where the operator
  // invoked from" behavior for non-repo workflows. Loaders are
  // non-fatal: malformed sections degrade to defaults, warnings
  // surface on stderr via
  // BootstrapResult.{memory,providers,budget}Warnings.
  const budgetLoaded = loadBudgetConfig({ cwd: projectConfigCwd });
  const effortLoaded = loadEffortConfig({ cwd: projectConfigCwd });
  // [recap] config — `render_model` (validated against the registry)
  // + `enabled` master switch. CLI `--no-recap` overrides config to
  // off; otherwise project [recap] wins over user, then default-on.
  const recapLoaded = loadRecapConfig({ cwd: projectConfigCwd, registry });

  // Slice Q — invert S11/S13 LLM-judge default to ON. The loader
  // walks the same `.agent/config.toml` + `~/.config/agent/config.toml`
  // pair as [budget]; project field wins. `userHadField` /
  // `projectHadField` per-field provenance signals drive the
  // first-run banner emission below: banner fires ONLY when both
  // detectors resolved to ON via DEFAULT (no layer explicitly named
  // the field, no CLI override).
  const memoryLoaded = loadMemoryConfig({ cwd: projectConfigCwd });
  // [audit] config — picks up `run_gc_on_stop` + `[audit.retention]`
  // windows. Threaded into HarnessConfig.auditRetention so the
  // session-end loop knows whether to fire the built-in gc trigger
  // (AGENTIC_CLI §2.1.3 Stop hook integration). Loader degrades to
  // defaults on misconfig; warnings surface via the same stderr
  // banner machinery as the other config loaders.
  const auditLoaded = loadRetentionConfig({ cwd: projectConfigCwd });
  // Wire the resolved recap_cache TTL into the cache writer's
  // effective default. Without this, operators who set
  // `[audit.retention].recap_cache = "5m"` (or any non-default
  // value) see the config parsed + surfaced in `gc --json` output
  // but the actual writes from /recap + auto-display still use
  // the 1h hardcoded default — silently ineffective config.
  // Single-call wire here keeps the threading out of every cache
  // writer's call signature.
  setRecapCacheTtlOverride(auditLoaded.config.recap_cache_ttl_ms);

  // [sandbox] writable_cache_dirs — the $HOME-relative cache dirs the
  // cwd-rw / cwd-rw-net sandbox profiles expose as writable tmpfs so
  // build toolchains (go/cargo/npm/…) don't hit EROFS on a read-only
  // $HOME. Sanitized by the loader; wired into the runner via a single
  // module-level override so every spawn site (broker bash, bg bash,
  // grep) picks it up without threading. `undefined` (no config) leaves
  // the runner on DEFAULT_WRITABLE_CACHE_DIRS; an explicit `[]` disables
  // the carve-out. Warnings surface via the same stderr banner as the
  // other config loaders.
  const sandboxLoaded = loadSandboxConfig({ cwd: projectConfigCwd });
  setWritableCacheDirsOverride(sandboxLoaded.config.writableCacheDirs);
  // Opt-in persistent dedicated cache (`[sandbox] cache_persistence`). Set
  // the same module-level override the runner reads, so every spawn site
  // (broker bash, bg bash, grep) picks it up without threading. When on,
  // host-create the dedicated cache base so the runner's `--bind` source
  // exists (an absent bind source aborts the spawn). Failure degrades to
  // the ephemeral `~/.cache` tmpfs — warn, don't crash.
  const cachePersist = sandboxLoaded.config.cachePersistence ?? DEFAULT_CACHE_PERSISTENCE;
  setCachePersistenceOverride(cachePersist);
  if (cachePersist) {
    try {
      mkdirSync(forjaCachePersistBase(), { recursive: true, mode: 0o700 });
    } catch (e) {
      process.stderr.write(
        `forja: could not create persistent cache dir (${e instanceof Error ? e.message : String(e)}); caches will be ephemeral this session\n`,
      );
    }
  }

  // First-run banner. Fires once per machine when:
  //   (a) both detectors resolve to ON,
  //   (b) the resolution came from the hardcoded default (no config
  //       layer touched the field, no CLI override),
  //   (c) we're not in `--json` mode (stack rule: NDJSON consumers
  //       expect predictable stderr; one-line banner pollutes
  //       structured log capture),
  //   (d) the per-machine marker file doesn't exist yet (or marker
  //       was disabled via input.governanceBannerMarkerDir=null).
  //
  // subagent-child.ts has its own boot path; this function is only
  // reached by top-level operator runs, so the banner is naturally
  // suppressed for subagents.
  //
  // Design decision — emit ONE banner covering both detectors,
  // suppress when ANY layer touched EITHER field (not per-detector
  // independent banners):
  //   - Rationale: an operator who already wrote `[memory]
  //     verify_semantic_llm = false` is signaling awareness of the
  //     memory governance subsystem. Emitting the conflict-half of
  //     a per-detector banner on their next boot would be noise
  //     ("we know, we configured it").
  //   - Counter-argument (rejected): a per-detector banner would
  //     warn when only ONE detector is silently on. We accept that
  //     trade-off: configured operators read `/memory governance
  //     status` (Slice Q surfaces source-labels there); unconfigured
  //     operators get the canonical single-line advisory once.
  //   - Edge: if an operator config-disables only one field, the
  //     banner suppresses entirely — even though the OTHER field
  //     came from default. This is intentional. The status command
  //     and docs/MEMORY.md §11.4 cover the operator's information
  //     path from that point on.
  const verifyFromDefault =
    input.memorySemanticVerify === undefined &&
    !memoryLoaded.projectHadField.verifySemanticLlm &&
    !memoryLoaded.userHadField.verifySemanticLlm;
  const conflictFromDefault =
    input.memoryConflictDetect === undefined &&
    !memoryLoaded.projectHadField.conflictDetectLlm &&
    !memoryLoaded.userHadField.conflictDetectLlm;
  const overrideFromDefault =
    input.memoryOverrideDetect === undefined &&
    !memoryLoaded.projectHadField.overrideDetectLlm &&
    !memoryLoaded.userHadField.overrideDetectLlm;
  const resolvedVerify = input.memorySemanticVerify ?? memoryLoaded.config.verifySemanticLlm;
  const resolvedConflict = input.memoryConflictDetect ?? memoryLoaded.config.conflictDetectLlm;
  const resolvedOverride = input.memoryOverrideDetect ?? memoryLoaded.config.overrideDetectLlm;
  const shouldShowBanner =
    verifyFromDefault &&
    conflictFromDefault &&
    overrideFromDefault &&
    resolvedVerify &&
    resolvedConflict &&
    resolvedOverride &&
    input.json !== true;
  if (shouldShowBanner) {
    // Per-machine marker: when input.governanceBannerMarkerDir is
    // explicitly null the marker is disabled (banner re-emits every
    // boot — useful for CI / determinism). Otherwise default to
    // `~/.local/share/forja/`. mkdirSync+writeFile errors degrade
    // silently to "no marker, emit anyway" — better than refusing
    // the banner on a wonky filesystem.
    const markerDir =
      input.governanceBannerMarkerDir === undefined
        ? join(homedir(), '.local', 'share', 'forja')
        : input.governanceBannerMarkerDir;
    let markerExists = false;
    if (markerDir !== null) {
      try {
        const markerFs = await import('node:fs');
        const markerPath = join(markerDir, '.governance-banner-shown');
        markerExists = markerFs.existsSync(markerPath);
        if (!markerExists) {
          markerFs.mkdirSync(markerDir, { recursive: true });
          markerFs.writeFileSync(markerPath, `${Date.now()}\n`);
        }
      } catch {
        // Best-effort. If we can't write the marker, banner fires —
        // worse to suppress when the operator never saw it.
      }
    }
    if (!markerExists) {
      process.stderr.write(
        'memory: governance LLM detectors enabled by default (verify=on, conflict=on, override=on). Disable: /memory governance disable verify|conflict|override|all\n',
      );
    }
  }

  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

  // Subagent discovery (spec §11.1). Loaded eagerly here so a
  // malformed definition fails fast — at bootstrap time the user
  // gets a clear error path, instead of a runtime tool failure
  // mid-conversation. The loader throws on bad frontmatter; we let
  // it propagate (same convention as policy YAML errors).
  const subagents = loadSubagents({
    cwd,
    ...(input.userAgentsDir !== undefined ? { userDir: input.userAgentsDir } : {}),
    ...(input.projectAgentsDir !== undefined ? { projectDir: input.projectAgentsDir } : {}),
  });

  // Capability gate against the active tool registry. Catches
  // any tool with `metadata.writes=true` in a subagent's
  // whitelist — including newly-registered or external tools the
  // old name-list approach would have missed. Fails the bootstrap
  // before the harness wires the registry into HarnessConfig, so
  // the user sees the violation immediately rather than at first
  // task() invocation.
  validateSubagentSet(subagents.byName.values(), toolRegistry);

  // Permission engine preflight (install_id + policy load) BEFORE
  // any SQLite handle is opened. A malformed policy YAML / a §11
  // protected-paths redefinition / a missing config dir for
  // install_id all throw HERE, preserving the v1 leak-test
  // invariant ("DB file never created when policy is bad"). The
  // chain-verify phase still runs after the DB is open and can
  // produce a `refusing` state — that's the operator-recoverable
  // path with --accept-broken-chain.
  const preflight = preflightPermissionEngine({
    cwd,
    home,
    ...(input.enterprisePolicyPath !== undefined
      ? { enterprisePath: input.enterprisePolicyPath }
      : {}),
    ...(input.userPolicyPath !== undefined ? { userPath: input.userPolicyPath } : {}),
  });

  // Open + migrate the DB. bootstrapPermissionEngine's chain-verify
  // phase needs the schema applied. From here on, anything that
  // throws must close the DB.
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = openDb(dbPath);
  try {
    migrate(db);
  } catch (e) {
    closeDb(db);
    throw e;
  }

  // Permission engine bootstrap (PERMISSION_ENGINE.md §2):
  // init → loading-policy → validating-chain → ready (or refusing
  // when chain is broken without --accept-broken-chain). The
  // controller drives runtime degrade/restore, and the audit sink
  // built here is the one the engine emits through — single SQLite
  // handle for the entire lifetime.
  // Sandbox availability is probed at bootstrap (cheap binary
  // lookup via Bun.which). The result flows into the engine
  // options so `check()` runs the §6.5 planner. Probing here
  // rather than per-check keeps the bootstrap path the single
  // source of truth for "is this host capable of sandboxing?".
  //
  // §6.5 policy section composes with the CLI flag:
  //   - `policy.sandbox.required` (default false) → engine becomes
  //     `refusing` on unavailable bwrap. Enterprise-policy authors
  //     use this to refuse boot under a missing toolchain.
  //   - `policy.sandbox.hostAllowed` OR `--sandbox-host` flag → the
  //     `host` profile becomes selectable. Either path is enough;
  //     the planner still requires `host-passthrough` in resolved
  //     capabilities.
  // Test seam — `sandboxAvailabilityOverride` pins the verdict
  // deterministically. Production passes nothing and the real probe
  // runs against the live host.
  const sandboxAvail = input.sandboxAvailabilityOverride ?? detectSandboxAvailability();
  const policySandbox = preflight.resolved.policy.sandbox;
  // Slice 157 (review — phase 2 of macOS /tmp isolation). Acquire a
  // per-CLI-run sandbox tmpdir right after we know the platform has
  // sandbox tooling. On darwin: mkdir /tmp/forja-sb-<ULID> with 0o700
  // and stash the cleanup callback. On linux: returns the no-op shape
  // — bwrap's `--tmpfs /tmp` already isolates per spawn.
  //
  // The ULID is fresh per CLI invocation so two parallel `forja`
  // processes never collide on the path, and a postmortem can
  // correlate `ls -ld /tmp/forja-sb-*` against `agent doctor` /
  // session log timelines.
  //
  // mkdir failure → falls back to undefined tmpdir, which downstream
  // callers treat as "no scoping". The pre-slice-156 behavior (blanket
  // /tmp allow) is the safety floor — graceful, never refuse.
  //
  // Cleanup: only registered when `tmpdir !== undefined` (darwin happy
  // path) — there's nothing to clean on linux/win and on darwin failure
  // paths, and registering a no-op listener per `bootstrap()` invocation
  // would trip MaxListenersExceededWarning under test fixtures that
  // bootstrap repeatedly (R5 review of slice 157).
  //
  // Why ONLY the 'exit' event, not also SIGINT/SIGTERM (R5 review):
  //   - In production, `src/cli/signal.ts:installSignalHandler` (called
  //     from `run.ts`) already wires SIGINT/SIGTERM/SIGHUP/SIGQUIT +
  //     uncaughtException + unhandledRejection to abort the harness
  //     controller, which then drains and calls `process.exit(N)`.
  //     `process.exit` fires the 'exit' event synchronously → cleanup
  //     runs. No double-handler needed.
  //   - In test paths that skip `installSignalHandler` (custom signal
  //     passed in), registering our own SIGINT handler here would
  //     PREVENT Node's default-kill on Ctrl+C without itself calling
  //     `process.exit`, hanging the test process. 'exit' alone avoids
  //     that footgun — it only fires when something else has already
  //     decided to exit.
  const sandboxTmpdirHandle: SandboxTmpdir = acquireSandboxTmpdir({
    sessionId: generateUlid(),
    // Linux: only acquire a persistent session /tmp when shared_tmp is on
    // (else the default `--tmpfs /tmp` already isolates per spawn). Darwin
    // ignores this and always acquires its SBPL tmpdir.
    sharedTmp: sandboxLoaded.config.sharedTmp ?? DEFAULT_SHARED_TMP,
    warn: (m) => {
      process.stderr.write(`forja: ${m}\n`);
    },
  });
  if (sandboxTmpdirHandle.tmpdir !== undefined) {
    process.once('exit', sandboxTmpdirHandle.cleanup);
  }
  // Slice 130 fixup #1: construct the failure_events sink ONCE
  // at the CLI bootstrap level. Thread it through both (a) the
  // permission-engine bootstrap so `sandbox.tool_unavailable`
  // emits at boot, and (b) the HarnessConfig so the harness loop
  // can pass it to createBgManager + createSubagentHandleStore.
  // Pre-fixup the sink type existed but no production caller
  // constructed one — slice 130's wire sites were inert at
  // runtime.
  //
  // Slice 131: construct the outcome_signals sink alongside and
  // pass to the failure sink as `outcomeSink` so downstream
  // failures dual-write a calibration signal whenever the
  // payload carries `approval_seq`. Also threaded onto the
  // HarnessConfig so harness/loop emits `tool_error` signals
  // and CLI checkpoint --undo emits `checkpoint_reverted`.
  const outcomeSink = createSqliteOutcomeSink({ db });
  const failureSink = createSqliteFailureSink({ db, outcomeSink });
  const permResult = await bootstrapPermissionEngine({
    cwd,
    home,
    db,
    sessionId: 'session-bootstrap',
    preflight,
    failureSink,
    ...(input.acceptBrokenChain === true ? { acceptBrokenChain: true } : {}),
    ...(input.approvalPosture !== undefined ? { approvalPosture: input.approvalPosture } : {}),
    sandbox: {
      available: sandboxAvail.available,
      hostExplicitlyAllowed: input.sandboxHost === true || policySandbox?.hostAllowed === true,
      required: policySandbox?.required === true,
      // Slice 165 (review — Batch C sandbox observability). Forward
      // the trust marker so bootstrap can emit a
      // `sandbox.path_resolved` failure_event when the install isn't
      // canonical. Slice 154 populated these fields; pre-slice 165
      // they were dropped at this boundary.
      trustLevel: sandboxAvail.trustLevel,
      path: sandboxAvail.path,
      trustWarnings: sandboxAvail.trustWarnings,
    },
    // Side-effect oracle for the §10.1 envelope gate. Closes the
    // bash_kill / bash_output / bash_background bypass where a
    // narrowed subagent invokes a tool whose resolver returns no
    // caps but whose metadata declares writes / exec / bgManager
    // dependence. `requiresBgManager` rides along because reading
    // or signalling bg-process lifecycle IS a side effect from
    // the envelope's perspective even when no fs write happens
    // (e.g., bash_output is `writes:false` but reads stdout from
    // a previously-spawned process). The callback re-reads the
    // registry on each check (not snapshotted) so MCP tools
    // registered post-bootstrap are observed without re-plumbing.
    isToolSideEffect: (toolName) => {
      const tool = toolRegistry.get(toolName);
      if (tool === null) return false;
      return (
        tool.metadata.writes === true ||
        tool.metadata.exec === true ||
        tool.metadata.requiresBgManager === true ||
        tool.metadata.requiresReminderScheduler === true
      );
    },
  });
  const permissionEngine = permResult.engine;
  const policyLayers = permResult.layerNames as ('enterprise' | 'user' | 'project' | 'session')[];

  // Resolve cwd trust state EARLY so the system-prompt composition
  // (project pointer, below) can gate on it. Originally this lived
  // after the prompt assembly because no upstream surface needed
  // it; the project_pointer section needs the flag at compose
  // time, so we lift it. Failing-closed semantics unchanged: any
  // path that resolves to "no trust storage" or "cwd absent from
  // list" yields `false`, which suppresses the pointer (and any
  // other downstream gate that consults `isCwdTrusted`).
  const trustPath =
    input.trustListPathOverride !== undefined ? input.trustListPathOverride : trustListPath();
  const isCwdTrusted = trustPath !== null && isTrusted(trustPath, cwd);

  let resolvedSystemPrompt: string | undefined;
  let resolvedSystemSegments: SystemSegment[] | undefined;
  let systemPromptHash: string | undefined;
  let memoryRegistry: ReturnType<typeof createMemoryRegistry>;
  let skillCatalog: ReturnType<typeof createSkillCatalog>;
  let resolvedHooks: ReturnType<typeof resolveHookConfig>;
  // Eager-load inventory (MEMORY.md §11.2). Lifted out of the
  // try-block so the post-try HarnessConfig builder can read it;
  // empty array survives the no-memory path without conditional
  // spread on the consumer side.
  let eagerExposures: ReturnType<typeof assembleMemorySection>['eagerLoaded'] = [];
  // Whether the shared scope is offline for THIS session — drives
  // both the eager-load section's `excludeScopes` AND the retrieval
  // runner's `memoryExcludeScopes` (S5 CRIT/H2). Lifted out of the
  // try-block so the post-try HarnessConfig builder can pass it
  // straight into the config without re-deriving from
  // `sharedTrustProbe`.
  let sharedScopeOffline = false;
  // Probe outcome (S5/T5.2). Lifted out of the try-block for the
  // same reason as `eagerExposures` — present on BootstrapResult
  // for the CLI driver to render warnings, absent on the early-
  // throw path so callers can distinguish "probe skipped" from
  // "probe ran and decided X".
  let sharedTrustProbe: ProbeSharedTrustResult | undefined;
  try {
    // Resolve the effective system prompt. Layers stack here in
    // precedence order (most-specific to most-generic). Each
    // `composeWith*` prepends to the downstream chunk it
    // receives, so we wrap from the inside out — the LAST
    // wrapper applied lands FIRST in the final string.
    //
    //    1. Caller's user prompt (input.systemPrompt) — most
    //       specific, the operator's own framing.
    //    2. Playbook discovery hint — table of available
    //       subagents + auto-delegation criteria (PLAYBOOKS.md
    //       §1.4). Sits between parallel and the user prompt
    //       because the table assumes the model already knows the
    //       task_async family from the parallel layer.
    //    3. Tool ergonomics — high-payoff usage rules distilled
    //       from `TOOL_ERGONOMICS.md` (slice before reading,
    //       filter before stdout, scope conservatively, prefer
    //       dedicated tools, do not re-read in session, diagnose
    //       before retry). Sits BETWEEN parallelism and the
    //       playbook hint because it teaches "when you make
    //       tool calls, MAKE THEM WELL" — paired with the
    //       "you can make several at once" framing right above.
    //    4. Parallelism hint — universal background that
    //       surfaces the harness's concurrency affordances
    //       (multi-tool turns, task_async family) so the
    //       capability isn't dormant.
    //    5. Constraints block — the canonical "constraints
    //       negativas globais" section (CONTEXT_TUNING §1.1 /
    //       §1.6): the correctness floor (no inventing symbols,
    //       evidence over assumption, no silent semantic change)
    //       plus the security posture, the hard-to-reverse
    //       confirm rule, and the contradictory-goal rule.
    //    6. Response-format hint — render-target rules
    //       (CommonMark in monospace ANSI, file:line refs,
    //       no-emoji default, structural padding bans) per
    //       ANTI_PATTERNS.md §1.3.
    //    6b. Output-style hint — the output-density default
    //       (signal per token, findings before evidence, silence
    //       between tool calls). Sibling to the response-format
    //       block (both govern how output is written); static, so
    //       it stays in cache breakpoint #1. Per-task verbosity is
    //       the `effort` knob, not this section.
    //    7. Environment block — situational anchor: cwd, OS,
    //       model, today's date, git context. Date in this
    //       section invalidates cache once per UTC day
    //       (acceptable per CONTEXT_TUNING §3.2; the
    //       alternative — placeholder + post-cache substitution
    //       — is not supported by Anthropic's API).
    //    8. Identity / role marker — sits OUTERMOST so it lands
    //       first (CONTEXT_TUNING §1.1: identity is the first
    //       canonical [system] section). Fully static, unlike
    //       the environment block's date below it.
    const withPlaybook = composeWithPlaybookHint(input.systemPrompt, subagents);
    const withErgonomics = composeWithToolErgonomics(withPlaybook);
    const withParallel = composeWithParallelHint(withErgonomics);
    const withConstraints = composeWithConstraints(withParallel);
    const withResponseFormat = composeWithResponseFormat(withConstraints);
    // Output-density default (signal per token, not word count) —
    // sibling to the response-format block: both govern HOW the model
    // writes its output. Static in the stable segment, so it never
    // invalidates the cache prefix; per-task verbosity is the `effort`
    // request param, not a prompt edit. See `output-style-prompt.ts`.
    const withOutputStyle = composeWithOutputStyle(withResponseFormat);
    const withEnvironment = composeWithEnvironment(withOutputStyle, {
      cwd,
      platform: process.platform,
      modelId: provider.id,
      // Today's date in `YYYY-MM-DD`, OPERATOR-LOCAL timezone.
      // Single Date.now() call at boot — stable for the whole
      // session, so the env block sits inside cache breakpoint
      // #1 across turns within a session. Across session
      // boundaries spanning local midnight the cache
      // invalidates, which is the intended trade-off.
      //
      // Local time, not UTC: the model uses this value to
      // interpret relative requests like "today's commits" /
      // "yesterday's logs". `Date.toISOString()` would emit
      // UTC, which is one day ahead in US evening sessions and
      // similar; the wrong day in the prompt then pushes the
      // model toward the wrong git --since window. See
      // `local-date.ts` for the timezone-math rationale.
      today: localIsoDate(),
      // Git probes are best-effort: when cwd is not a git repo
      // the helper returns null and the env section omits the
      // git sub-block entirely.
      git: probeGitContext(cwd),
    });
    // Identity / role marker (CONTEXT_TUNING §1.2) — outermost
    // layer, prepended last so it lands FIRST in the final
    // string, ahead of the environment block. Fully static, so
    // it sits in the most-stable region of cache breakpoint #1.
    resolvedSystemPrompt = composeWithIdentity(withEnvironment);

    // Memory subsystem (spec MEMORY.md / §4.1). Build the registry
    // from the REPO root, not the invocation cwd: project memory
    // lives at `<repo>/.agent/memory/{shared,local}/` and an
    // operator running `agent` from a subdir (the common case)
    // would otherwise see empty project scopes. `resolveRepoRoot`
    // calls `git rev-parse --show-toplevel`; falls back to cwd
    // when not in a git repo (memory then lives wherever the
    // operator invoked from — same fallback as the pre-fix
    // behavior). User scope is unaffected (lives at
    // ~/.config/agent/memory/, scope-roots derives it from env).
    //
    // Registry construction is unconditional in the production
    // path — an absent or empty memory subtree just produces an
    // empty section that composeSystemPrompt passes through,
    // leaving the base prompt unchanged.
    // Resolve the repo root once and reuse for memory scope roots
    // AND boot trigger probes. Earlier cut called
    // `evaluateBootTriggers(cwd)` separately, which broke the
    // common case of running `agent` from a repo subdirectory:
    // memory was loaded from the repo root (`resolveRepoRoot(cwd)`)
    // but trigger probes scanned `cwd`, missing root-level
    // `.git` / `package.json` / `tsconfig.json` etc. Memories
    // tagged with those triggers got filtered out even though
    // the same session loaded the project memory containing them.
    // Single `repoRoot` value keeps the three consumers
    // aligned: memory config loader (hoisted above),
    // memory scope roots, and the trigger-probe section below.
    const repoRoot = projectConfigCwd;
    const memoryRoots = resolveScopeRoots(repoRoot);
    // Vendor seeds are NOT installed at bootstrap — they ride along
    // with `agent init` (spec MEMORY.md §5.7.4 + §5.7.8) so the
    // operator's first explicit setup gesture is also where the
    // catalog lands, mirroring how skills/playbooks scaffold. An
    // operator who never runs `agent init` does NOT see seeds in
    // their /memory list — that's a feature: nothing arrives in
    // the user scope without an explicit operator action.
    memoryRegistry = createMemoryRegistry({ roots: memoryRoots, db, cwd });
    // Skill catalog (spec SKILLS.md §3-§4). Same repo-rooted scope
    // resolution as memory; the catalog scans every scope at
    // construction. The `db` lets recordEvent / recordSurface write
    // skill_events audit rows.
    skillCatalog = createSkillCatalog({ roots: resolveSkillScopeRoots(repoRoot), db, cwd });
    // SessionStart expiry GC (spec MEMORY.md §6.2). Auto-evicts
    // memories whose `expires:` field is on or before today through
    // the canonical state machine — Phase 2.2 routed this path
    // through transitionMemoryState, so each expiry lands TWO
    // memory_events rows (action='quarantined' then action='evicted')
    // plus the paired eviction_events trail with motivo='low_roi'
    // (closest-fit per the spec follow-up) and trigger='expired_at'.
    // The body moves into `.tombstones/`; operators can `/memory
    // restore` an unintended expiry within the retention window.
    // We run this BEFORE assembling the eager prompt section so
    // the model never sees stale entries that vanish mid-session.
    // The session id isn't known yet (the harness loop creates it
    // later), so the audit rows here land with sessionId NULL —
    // the lifecycle GC is conceptually a session-bootstrap event,
    // not a per-session-conversation one. cwd is forwarded so
    // `/memory audit` can group GC events by working directory.
    //
    // Failures surface in `gcResult.failures` with a translated
    // reason string (transitionMemoryState's discriminated outcomes
    // → operator-facing message), plus a stderr line per failure
    // so the operator sees them live without consulting the audit
    // table. A bootstrap-blocking failure would be wrong — one
    // bad memory shouldn't gate the session — but silently
    // dropping the failure is worse.
    const gcResult = await gcExpiredMemories(db, memoryRegistry, memoryRoots, { auditCwd: cwd });
    for (const failure of gcResult.failures) {
      process.stderr.write(
        `forja: memory gc: failed to expire ${failure.memory.scope}/${failure.memory.name} (expires ${failure.memory.expires}): ${failure.reason}\n`,
      );
    }
    // Purge sweep — materializes evicted → purged for tombstones
    // whose retention window expired (EVICTION §7.1). Runs after
    // gcExpiredMemories so this same boot can purge an entry that
    // was just expired in a prior boot whose retention has now
    // run out, AND so any concurrent boot-time evictions land
    // their `evicted` row before this sweep iterates. Failures
    // surface to stderr like expiration failures.
    const purgeResult = await gcPurgeExpiredTombstones(db, memoryRegistry, memoryRoots, {
      auditCwd: cwd,
    });
    for (const failure of purgeResult.failures) {
      process.stderr.write(
        `forja: memory gc: failed to purge eviction_event ${failure.evictionEventId}: ${failure.reason}\n`,
      );
    }
    // Stale-invalidated sweep (S5 CRIT/V1, EVICTION.md §7.1 +
    // MEMORY.md §6.5.6 7-day window). Trust_revoked produces
    // `invalidated` rows in bulk; without this sweep they
    // accumulate on disk forever. Each memory whose invalidation
    // event is older than 7 days transitions to `evicted` with
    // motivo='shift' (the only motivo §4.1 admits for
    // invalidated→evicted), trigger='expired_at',
    // actor='startup_probe'. Failures and orphans surface to
    // stderr like the other sweeps.
    const staleResult = await gcStaleInvalidatedMemories(db, memoryRegistry, memoryRoots, {
      auditCwd: cwd,
    });
    for (const failure of staleResult.failures) {
      process.stderr.write(
        `forja: memory gc: failed to evict stale invalidated ${failure.memory.scope}/${failure.memory.name}: ${failure.reason}\n`,
      );
    }
    for (const orphan of staleResult.orphans) {
      process.stderr.write(
        `forja: memory gc: orphan invalidated frontmatter without audit row at ${orphan.scope}/${orphan.name}\n`,
      );
    }
    // Provenance sweep (MEMORY.md §11.2, S1/T1.7). Drops
    // exposure rows older than the retention window. Best-
    // effort: a DB failure here MUST NOT abort boot — provenance
    // is observability, not correctness, and a one-off failed
    // sweep just delays cleanup by one boot. Stderr surfaces the
    // cause for the operator without gating the session.
    try {
      pruneMemoryProvenance(db, Date.now() - MEMORY_PROVENANCE_RETENTION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Match the AUDIT DRIFT shape every other memory site uses
      // (registry.ts auditRead/auditExposure, loop.ts eager emit,
      // runner.ts retrieve_context emit) so operators can grep
      // 'memory: AUDIT DRIFT' for every drift signal. redactSecrets
      // because SQLite errors may echo bound params.
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to record retention sweep at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // Governance proposal TTL sweep (MEMORY.md §11.3, S8/T8.4).
    // Pending proposals older than 30d auto-expire — a proposal
    // that didn't get reviewed in that window has lost authority
    // (underlying memory + detector context likely drifted).
    // Detectors re-emit if the finding still holds. Best-effort
    // same as the provenance sweep: a DB failure does not abort
    // boot — operator-facing governance surfaces will fall back to
    // surfacing stale rows until the next successful sweep.
    try {
      expirePendingProposals(db, { ttlMs: GOVERNANCE_PROPOSAL_TTL_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to expire pending governance proposals at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // S11 verify-attempts retention sweep (MEMORY.md §11.x, S11/T11.10).
    // Content-addressed dedup cache; rows older than 90d are dropped
    // (the content_hash has almost certainly drifted past that point
    // and the value of suppressing re-dispatch becomes negative).
    // Best-effort same as the sister sweeps above.
    try {
      pruneVerifyAttempts(db, Date.now() - MEMORY_VERIFY_ATTEMPTS_RETENTION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to prune memory_verify_attempts at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // S13 conflict-attempts retention sweep. Same shape as
    // verify-attempts; independent table (memory_conflict_attempts).
    try {
      const { pruneConflictAttempts, MEMORY_CONFLICT_ATTEMPTS_RETENTION_MS } = await import(
        '../storage/repos/memory-conflict-attempts.ts'
      );
      pruneConflictAttempts(db, Date.now() - MEMORY_CONFLICT_ATTEMPTS_RETENTION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to prune memory_conflict_attempts at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // S3 override-events retention sweep (post-Phase-2 review C1).
    // Signal collector populates this table on every modal-reject /
    // permission-deny; without the sweep the table grows unbounded
    // and the threshold counter's `countOverridesInWindow` query
    // slows over time. 90d retention matches memory_provenance —
    // the override events feed the threshold which feeds proposals;
    // symmetric retention keeps the audit JOIN valid for that window.
    try {
      const { pruneOverrideEvents, MEMORY_OVERRIDE_EVENTS_RETENTION_MS } = await import(
        '../storage/repos/memory-override-events.ts'
      );
      pruneOverrideEvents(db, Date.now() - MEMORY_OVERRIDE_EVENTS_RETENTION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to prune memory_override_events at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // S3 override-attempts retention sweep (post-Phase-2 review C1).
    // Companion to verify-attempts + conflict-attempts; rows older
    // than 90d are content-addressed-stale and the cooldown semantic
    // breaks down past that horizon.
    try {
      const { pruneOverrideAttempts, MEMORY_VERIFY_OVERRIDE_ATTEMPTS_RETENTION_MS } = await import(
        '../storage/repos/memory-verify-override-attempts.ts'
      );
      pruneOverrideAttempts(db, Date.now() - MEMORY_VERIFY_OVERRIDE_ATTEMPTS_RETENTION_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to prune memory_verify_override_attempts at boot (will retry next boot): ${redactSecrets(msg)}\n`,
      );
    }
    // Shared-corpus trust probe (S5/T5.2, MEMORY.md §6.5.2
    // `trust_revoked` detector). Runs ONLY when:
    //   - the operator supplied a callback (no TUI ⇒ no consent
    //     pathway; the headless eager-load gate covers fail-closed
    //     downstream by computing the hash separately),
    //   - the cwd is trusted at boot (without cwd trust, the
    //     operator hasn't consented to operate in this directory,
    //     so prompting them about its shared corpus is premature).
    //
    // Placement intent: AFTER the GC sweeps (an active shared
    // memory just auto-evicted by `gcExpiredMemories` would shift
    // the hash, prompting unnecessarily — accepted as a documented
    // false-positive given how rarely operators set `expires:` on
    // shared memories) and BEFORE `assembleMemorySection` so the
    // bulk-invalidate path on revoke keeps the invalidated
    // memories out of THIS session's system prompt (otherwise the
    // operator would need to restart for the revocation to take
    // effect).
    if (input.askSharedTrust !== undefined && isCwdTrusted) {
      sharedTrustProbe = await probeSharedTrust({
        db,
        registry: memoryRegistry,
        roots: memoryRoots,
        sharedRoot: memoryRoots.projectShared,
        askSharedTrust: input.askSharedTrust,
        sessionId: null,
        cwd,
        warn: (msg) => {
          // Same shape used elsewhere in this try block (memory
          // GC failures, provenance sweep failures). Operator
          // greps stderr for any boot-time warning surface.
          process.stderr.write(`forja: shared-corpus trust: ${msg}\n`);
        },
      });
    }
    // Boot-time trigger context (spec §4.3). evaluateBootTriggers
    // probes the REPO ROOT for well-known files (.git, .env,
    // package.json, AGENTS.md, etc.); each present file is added
    // to a Set that assembleMemorySection consults when filtering
    // memories tagged with `triggers:` in their frontmatter.
    // Probing the repo root (not the invocation cwd) matches the
    // memory roots resolved above — same anchor for both. An
    // operator running `agent` from `/repo/src/components/`
    // expects `git` / `package` triggers to fire because the
    // project memory loaded from `/repo` mentions them; probing
    // cwd would silently miss every project-root file.
    const bootContext = evaluateBootTriggers(repoRoot);
    // [project_context] section (spec CONTEXT_TUNING.md §2.0).
    // Eager-loads the body of the project agent-instructions file
    // (AGENTS.md / CLAUDE.md / … — see PROJECT_GUIDE_FILENAMES) into
    // the system prompt when present and trust-gated. Sits in the
    // composed string BEFORE [memory_index] to match the layout in
    // §2 — most-stable-first ordering keeps the cache breakpoint
    // economy intact: the guide content changes only when the file
    // is edited/renamed/removed (rare mid-session), while the memory
    // index changes on every /memory write. Empty-text section
    // passes the base prompt through unchanged when no guide is both
    // trusted and present.
    //
    // `isRepoRootTrusted` is computed independently of
    // `isCwdTrusted`: trust storage is exact-path membership
    // (`isTrusted(trustList, path)`), so an operator who trusted
    // only a subdir has NOT implicitly trusted its parent. The
    // section must not embed content from paths outside the explicit
    // trust grant — see `project-context.ts` §"Trust gate" for the
    // threat model. When `cwd === repoRoot` (the common project-root
    // invocation) the two flags are equal by construction and the
    // second `isTrusted` call is a no-op.
    const isRepoRootTrusted =
      cwd === repoRoot ? isCwdTrusted : trustPath !== null && isTrusted(trustPath, repoRoot);
    const projectContext = assembleProjectContext({
      cwd,
      repoRoot,
      isCwdTrusted,
      isRepoRootTrusted,
    });
    resolvedSystemPrompt = composeWithProjectContext(resolvedSystemPrompt, projectContext.text);
    // S5 fail-closed eager-load gating. The project_shared scope
    // is eligible for the eager-load section ONLY when the trust
    // probe established confidence in the corpus' current state.
    // Three outcomes block the scope:
    //
    //   - 'verify_failed' (P0/H2-rob): substrate couldn't read the
    //     corpus. System has no idea what's on disk; surfacing
    //     previously-snapshotted bodies would be fail-open against
    //     an attacker who EACCES'd the directory.
    //   - 'deferred' (P0/F3 + P1/M4-rob): modal was cancelled (Esc,
    //     timeout) OR a TOCTOU drift was detected after the
    //     operator's 'yes'. Either way, operator hasn't confirmed
    //     the current state.
    //   - 'revoked' (P1/F7): operator just said "I don't trust this
    //     corpus". The probe's bulk-invalidate cleared every ACTIVE
    //     shared memory, but quarantined-shared memories cannot
    //     transition to `invalidated` via motivo `security` (state
    //     machine admits only `shift` for that edge per
    //     EVICTION.md §4.1). Hard-excluding the whole scope at
    //     eager-load drops those survivors out of the model's
    //     window for THIS session — the operator can `/memory
    //     delete` for hard removal across boots.
    //
    // 'seeded', 'unchanged', 'reconfirmed' all pass — those are
    // the states where the trust row pins a hash that matches what
    // the model is about to see.
    //
    // CRIT/F4+M4 hardening: headless callers (no askSharedTrust)
    // and untrusted-cwd boots used to skip the gate entirely
    // (fail-OPEN). They now fail-CLOSED by default: the scope
    // loads ONLY when the stored trust row's hash matches the
    // current corpus fingerprint (the post-decision unchanged
    // state). This means:
    //   - Headless `agent run` against a corpus that's drifted
    //     since the operator's last interactive confirm: scope
    //     excluded, no model exposure to unattested content. The
    //     operator must run the interactive REPL to re-confirm.
    //   - Untrusted cwd (operator declined cwd-trust): scope
    //     excluded; aligns with the spec's "trust is per-project"
    //     stance — no shared corpus without project trust.
    // Why `sharedScopeOffline` is a boolean while downstream callers
    // consume `excludeScopes: readonly MemoryScope[]`: the boolean
    // shape serializes cleanly across the subagent IPC boundary
    // (`--subagent-shared-scope-offline` flag, no list parsing), and
    // S5's only excluded scope is `project_shared` — generality
    // beyond that would be wasted today. Internal consumers of the
    // boolean re-derive `excludeScopes: ['project_shared']` at the
    // call site (see `bootstrap.ts:835`, `subagent-child.ts`, harness
    // `loop.ts:1420`). The array shape stays for the
    // `assembleMemorySection` / `createMemoryView` APIs that may
    // grow more scopes (e.g., a future quarantine sweep that wants
    // to gate `user` independently).
    sharedScopeOffline = (() => {
      if (sharedTrustProbe !== undefined) {
        return (
          sharedTrustProbe.kind === 'verify_failed' ||
          sharedTrustProbe.kind === 'deferred' ||
          sharedTrustProbe.kind === 'revoked'
        );
      }
      // No probe ran. Decide based on whether the corpus state
      // matches what the operator last confirmed. Fail-closed on
      // any unknown / mismatch.
      //
      // P1/F6 cost note (deferred): a CI run that boots N times
      // against an unchanged corpus pays one full `.agent/memory/
      // shared/` read per boot just to compute the hash that will
      // match. A proper mtime fast-path would persist per-file
      // (size, mtime) tuples alongside the trust row and skip the
      // hash on stat-match — but a directory-mtime fast-path
      // misses body-content edits (root mtime doesn't change on
      // body writes), and a full per-file mtime persist requires
      // a migration + a snapshot column. Cost-benefit: ~5-10ms
      // per boot for a 100-file × 5KB corpus, dwarfed by Bun init
      // + SQLite migration. Skipped for now; revisit if telemetry
      // surfaces hot-path impact.
      if (!isCwdTrusted) return true;
      const currentHash = computeSharedFingerprint(memoryRoots.projectShared);
      if (currentHash === null) return true; // unreadable corpus
      const storedTrust = getSharedTrust(db, memoryRoots.projectShared);
      if (storedTrust === null) return true; // never confirmed
      return storedTrust.lastConfirmedHash !== currentHash; // drift
    })();
    // Snapshot the "stable" portion of the prompt — identity, env,
    // ergonomics, constraints, base systemPrompt, project pointer.
    // Everything composed BEFORE the memory/skills append. Captured
    // here so the Anthropic adapter can place a cache breakpoint
    // after this segment, separating it from the memory_index +
    // skills tail that invalidates on `memory_write` / skill palette
    // changes. CONTEXT_TUNING.md §3.1 declares 4 breakpoints; this
    // implements the [system] / [memory_index] split (the
    // [project_context] dedicated breakpoint is fused with [system]
    // here because the pointer is small and invalidates rarely).
    const stableSegmentText = resolvedSystemPrompt ?? '';
    const memorySection = assembleMemorySection({
      registry: memoryRegistry,
      bootContext,
      ...(sharedScopeOffline ? { excludeScopes: ['project_shared'] as const } : {}),
    });
    resolvedSystemPrompt = composeSystemPrompt(resolvedSystemPrompt, memorySection.text);
    eagerExposures = memorySection.eagerLoaded;
    // Skill catalog section (spec SKILLS.md §4.1: surface eager,
    // body lazy). An empty catalog yields an empty section that
    // composeSystemPrompt passes through unchanged. The
    // surfaced/filtered audit is emitted by the harness loop after
    // createSession — the session row must exist before a
    // skill_events row can reference it.
    const skillSectionText = assembleSkillCatalogSection(skillCatalog);
    resolvedSystemPrompt = composeSystemPrompt(resolvedSystemPrompt, skillSectionText);
    // Build the segment list mirroring resolvedSystemPrompt's
    // composition. `flattenSystemSegments(systemSegments)` must
    // equal `resolvedSystemPrompt` — both adapters and the audit
    // hash see identical content; segments only change which
    // boundaries the cache marker lands on.
    const memorySegmentText = composeSystemPrompt(memorySection.text, skillSectionText) ?? '';
    resolvedSystemSegments = [
      { id: 'stable', text: stableSegmentText, cacheBreakpoint: true },
      ...(memorySegmentText.length > 0
        ? [{ id: 'memory' as const, text: memorySegmentText, cacheBreakpoint: true }]
        : []),
    ];

    // Register the assembled system prompt in `prompt_versions`
    // (AUDIT.md §1.3.3): content-addressed, idempotent by hash so a
    // same-content reboot dedupes to the original row. The hash is
    // exposed on BootstrapResult so the harness can stamp
    // `messages.prompt_hash` / `tool_calls.prompt_hash` (§1.3.2
    // join surface). Skipped only when no prompt was assembled —
    // impossible in the production path now that identity is the
    // outermost layer, but the guard keeps test fixtures that
    // bypass composition safe.
    if (resolvedSystemPrompt !== undefined) {
      const hash = hashPromptContent(resolvedSystemPrompt);
      recordPromptVersion(db, {
        hash,
        // `name` is hardcoded to the autonomous profile because that
        // is the only profile this binary ships. When the
        // orchestrated profile (CONTEXT_TUNING §1.8.2) lands, this
        // must branch on the active profile — otherwise both
        // profiles register under the same `name` and the §1.3.5
        // history-by-name query collapses two distinct logical
        // prompts into one bucket. The branch site stays here, in
        // bootstrap, since the profile signal will live in the
        // resolved config.
        kind: 'system',
        name: 'system.autonomous',
        content: resolvedSystemPrompt,
        author: resolveAuthor(),
      });
      systemPromptHash = hash;
    }

    // Hooks subsystem (spec AGENTIC_CLI.md §10). Resolved inside
    // the same try-block as memory so any throw — TOML parse
    // error, fs EACCES on the user-scope hook file, etc. — is
    // funneled into db.close() before the rethrow. Otherwise
    // the SQLite handle (and its WAL files) leak. Reuses the
    // `repoRoot` already computed for memory; the project layer
    // probes `<repoRoot>/.agent/hooks.toml`.
    const hookPaths = resolveHookPaths(repoRoot);
    resolvedHooks = resolveHookConfig(hookPaths);
    // Probe the shell the dispatcher will use. If hooks are
    // configured but no usable shell is on PATH (Windows host
    // without Git Bash / WSL / cmd.exe — exotic but possible
    // in some container builds), synthesize a HookConfigWarning
    // so the CLI driver surfaces the cause on stderr alongside
    // the loader warnings. Without this signal, an operator
    // configures hooks, hits the dispatcher's shell-unavailable
    // short-circuit, and sees mysteriously-skipped hooks with
    // no audit row to debug from.
    if (resolvedHooks.hooks.length > 0) {
      const shell = resolveHookShell();
      if (shell.kind === 'unavailable') {
        resolvedHooks = {
          ...resolvedHooks,
          warnings: [
            ...resolvedHooks.warnings,
            {
              kind: 'shell_unavailable',
              layer: null,
              sourcePath: '<host>',
              message: `${resolvedHooks.hooks.length} hook(s) loaded but no shell available: ${shell.reason} — hooks will be skipped at dispatch`,
            },
          ],
        };
      }
    }
  } catch (e) {
    closeDb(db);
    throw e;
  }

  // Background-process log directory. Lives under `.agent/bg/`
  // alongside the DB (spec §2.7). The harness creates it on first
  // spawn; we just declare the path here so the manager knows where
  // to put log files. Per-cwd: a worktree's bg processes don't
  // collide with the parent repo's.
  const bgLogDir = join(cwd, '.agent', 'bg');

  // (`trustPath` and `isCwdTrusted` resolved above the try-block
  // so the project-context section can gate on them at prompt-
  // assembly time; both are still consumed below — memory_write
  // honors the same flag (MEMORY.md §7.2.1) and the harness
  // surfaces it for downstream gates.)

  // §13.7 broker for exec-tagged tools. Operator override at
  // `input.brokerMode` is load-bearing intent — when set, it wins
  // regardless of host capability. When omitted, the default
  // resolves dynamically: hosts with a working sandbox tool get
  // `'spawn'` (bash spawns wrapped in bwrap/sandbox-exec per the
  // engine's planner); hosts without sandbox tooling fall back to
  // `'in-process'` (degenerate broker; engine + bash AST resolver +
  // protected/sensitive paths floors remain the only defense).
  //
  // `sandboxAvail` was probed at line ~610 (canonical-first
  // resolver, trust check on path-resolved fallbacks); reusing
  // the result here means doctor + bootstrap + the engine
  // planner all see the same availability verdict per invocation.
  //
  // Latency tradeoff: spawn adds ~50-150ms per bash call (process
  // fork + Bun startup + module load). Sessions with many bash
  // calls feel the difference; the security gain is real
  // enforcement of the engine's selected sandbox profile vs zero
  // enforcement on the same bash invocation. Operators who need
  // raw throughput pass `--broker in-process` explicitly.
  const resolvedBrokerMode: 'in-process' | 'spawn' = (() => {
    if (input.brokerMode !== undefined) return input.brokerMode;
    return sandboxAvail.available ? 'spawn' : 'in-process';
  })();
  const broker = constructBroker(
    resolvedBrokerMode,
    cwd,
    sandboxTmpdirHandle.tmpdir,
    sandboxAvail.available,
  );

  const config: HarnessConfig = {
    provider,
    toolRegistry,
    permissionEngine,
    db,
    cwd,
    bgLogDir,
    broker,
    userPrompt: input.prompt,
    // Checkpoints (M3 §12): enabled for every CLI run by default
    // so users get `--undo` for free.
    enableCheckpoints: true,
    // Wire the subagent set so the `task` tool can resolve names.
    // Always passed (even when empty) — the tool surfaces a clear
    // "no subagents defined" hint instead of "registry missing"
    // when there are simply no .md files yet.
    subagentRegistry: subagents,
    memoryRegistry,
    skillCatalog,
    // S5 CRIT/H2: thread the scope-offline decision down so the
    // retrieval runner mirrors the eager-load posture. Empty
    // array when scope is online — the harness loop's
    // BuildRetrievalRunnerDeps spread treats empty as no-op.
    ...(sharedScopeOffline ? { memoryExcludeScopes: ['project_shared'] as const } : {}),
    // Eager-load provenance (MEMORY.md §11.2, S1/T1.4). Frozen
    // here at assembly time; loop emits one provenance row per
    // entry right after createSession. Empty array passes
    // through cleanly when the registry produced no memories or
    // every memory was filtered out (no harm in passing through).
    eagerExposures,
    isCwdTrusted,
    // Hooks resolved at boot (spec AGENTIC_CLI.md §10). When the
    // list is empty (no config files exist) we still pass the
    // empty array — the harness's loop is unconditional, the
    // chain-filter is the no-op when there are no hooks for the
    // event.
    hooks: resolvedHooks.hooks,
    // [audit] config thread-through. Empty `[audit]` block resolves
    // to DEFAULT_RETENTION (all defaults, runGcOnStop=false), which
    // is identical to NOT setting auditRetention at all — both
    // shapes leave the session-end gc trigger off. We pass the
    // resolved config regardless so the loop has the retention
    // windows ready if/when the operator flips run_gc_on_stop.
    auditRetention: auditLoaded.config,
    // Budget resolution: project/user [budget] config layers merged
    // first (per-key, project winning over user via loader's own
    // merge), then CLI input.budget on top. Harness applies
    // DEFAULT_BUDGET as the final fallback when it spreads this
    // partial into a full RunBudget. The field lands when EITHER
    // CLI input is present (mirroring pre-config semantic: explicit
    // `input.budget = {}` flows through as a forwarded empty
    // marker, in case downstream code distinguishes "absent" vs
    // "explicitly empty") OR config carries at least one key.
    ...((): { budget?: Partial<RunBudget> } => {
      const haveConfig = Object.keys(budgetLoaded.config).length > 0;
      const haveCli = input.budget !== undefined;
      if (!haveConfig && !haveCli) return {};
      return { budget: { ...budgetLoaded.config, ...(input.budget ?? {}) } };
    })(),
    // Operator effort default (TOKEN_TUNING.md §4): `[effort].level`
    // from config.toml, else DEFAULT_EFFORT ('high'). Always set on the
    // top-level session so the footer + provider effort have a concrete
    // level from the first turn; `/effort` overrides it in-session.
    // Subagents do NOT get this (they carry only inherited provider-effort).
    effort: effortLoaded.effort ?? DEFAULT_EFFORT,
    // Recap master switch + render-model default (RECAP §3.2/§3.3/§8.2).
    // `--no-recap` forces off; else the config value, else absent —
    // the `isRecapEnabled` predicate owns the default-on policy, so we
    // don't re-encode `true` here (single source of the default).
    ...(input.noRecap === true
      ? { recapEnabled: false }
      : recapLoaded.config.enabled !== undefined
        ? { recapEnabled: recapLoaded.config.enabled }
        : {}),
    ...(recapLoaded.config.renderModel !== undefined
      ? { recapRenderModel: recapLoaded.config.renderModel }
      : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    // Slice Q — resolved state (always boolean, never undefined).
    // Precedence: CLI explicit > project config > user config > default ON.
    // memorySemanticVerifySource carries provenance for /memory
    // governance status rendering + first-run banner suppression.
    memorySemanticVerify: input.memorySemanticVerify ?? memoryLoaded.config.verifySemanticLlm,
    memorySemanticVerifySource:
      input.memorySemanticVerify !== undefined
        ? 'cli'
        : memoryLoaded.projectHadField.verifySemanticLlm
          ? 'project-config'
          : memoryLoaded.userHadField.verifySemanticLlm
            ? 'user-config'
            : 'default',
    memoryConflictDetect: input.memoryConflictDetect ?? memoryLoaded.config.conflictDetectLlm,
    memoryConflictDetectSource:
      input.memoryConflictDetect !== undefined
        ? 'cli'
        : memoryLoaded.projectHadField.conflictDetectLlm
          ? 'project-config'
          : memoryLoaded.userHadField.conflictDetectLlm
            ? 'user-config'
            : 'default',
    memoryOverrideDetect: input.memoryOverrideDetect ?? memoryLoaded.config.overrideDetectLlm,
    memoryOverrideDetectSource:
      input.memoryOverrideDetect !== undefined
        ? 'cli'
        : memoryLoaded.projectHadField.overrideDetectLlm
          ? 'project-config'
          : memoryLoaded.userHadField.overrideDetectLlm
            ? 'user-config'
            : 'default',
    ...(resolvedSystemPrompt !== undefined ? { systemPrompt: resolvedSystemPrompt } : {}),
    ...(resolvedSystemSegments !== undefined ? { systemSegments: resolvedSystemSegments } : {}),
    ...(systemPromptHash !== undefined ? { systemPromptHash } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.resumeFromSessionId !== undefined
      ? { resumeFromSessionId: input.resumeFromSessionId }
      : {}),
    // Slice 130 fixup #1: pass the failure-events sink + boot-time
    // sandbox tool through to the harness. The harness loop then
    // wires both into createBgManager (mid-session loss probe) and
    // createSubagentHandleStore (storage.lock_contention / persist
    // failed). When `sandboxAvail.tool` is null, sandboxBootTool
    // stays undefined — the probe short-circuits and emits stay
    // off, matching pre-slice-130 behavior on hosts without
    // bwrap/sandbox-exec.
    failureSink,
    ...(sandboxAvail.tool !== null ? { sandboxBootTool: sandboxAvail.tool } : {}),
    // Slice 157 (phase 2): forward the per-CLI-run sandbox tmpdir
    // into HarnessConfig so the harness loop can thread it into
    // every ToolContext + the bg manager. Undefined on linux and
    // when bootstrap mkdir failed — downstream callers degrade
    // gracefully to the pre-slice-156 blanket allow.
    ...(sandboxTmpdirHandle.tmpdir !== undefined
      ? { sandboxTmpdir: sandboxTmpdirHandle.tmpdir }
      : {}),
    // Slice 131: outcome_signals sink for tool_error +
    // checkpoint_reverted wires (failure_event dual-write is
    // handled internally by failureSink which received outcomeSink
    // above; this slot is for the harness/loop tool-error wire).
    outcomeSink,
  };

  return {
    config,
    db,
    modelId,
    ...(systemPromptHash !== undefined ? { systemPromptHash } : {}),
    policyLayers,
    lockConflicts: [...permResult.lockConflicts],
    subagents,
    hookWarnings: resolvedHooks.warnings,
    memoryConfigWarnings: memoryLoaded.warnings,
    providersConfigWarnings: providersLoaded.warnings,
    recapConfigWarnings: recapLoaded.warnings,
    budgetConfigWarnings: budgetLoaded.warnings,
    effortConfigWarnings: effortLoaded.warnings,
    auditConfigWarnings: auditLoaded.warnings,
    sandboxConfigWarnings: sandboxLoaded.warnings,
    permissionState: permResult.state,
    ...(permResult.refusingReason !== undefined
      ? { permissionRefusingReason: permResult.refusingReason }
      : {}),
    permissionChain: permResult.chain,
    installIdentity: permResult.identity,
    // §13.7 enforcement snapshot — derived from the same
    // sandboxAvail probe + resolvedBrokerMode that drove broker
    // construction. REPL boot banner reads this to surface the
    // active vs disabled posture before the operator starts
    // typing; doctor consults the same primitives independently.
    sandboxEnforcement: {
      active: resolvedBrokerMode === 'spawn' && sandboxAvail.available,
      tool: sandboxAvail.tool,
      reason:
        resolvedBrokerMode === 'spawn' && sandboxAvail.available
          ? 'active'
          : resolvedBrokerMode === 'spawn'
            ? 'degraded-passthrough'
            : sandboxAvail.available
              ? 'operator-override'
              : 'no-tool',
    } satisfies SandboxEnforcementSnapshot,
    ...(sharedTrustProbe !== undefined ? { sharedTrustProbe } : {}),
  };
};

// §13.7 broker construction (slice 87). Extracted so each branch is
// independently readable + tests can target without going through
// the full bootstrap.
//
// `in-process`: degenerate broker delegating to `createBashHandler`
// in the same process. Bash exec stays in main — same behavior as
// the pre-§13.7 path. Used by default.
//
// `spawn`: real process isolation. Per call, spawns a fresh process
// that reads the BrokerRequest on stdin, dispatches to its bash
// handler, and returns a BrokerResponse on stdout. The
// sandboxRunner closes over `maybeWrapSandboxArgv` so the worker
// spawn is wrapped with bwrap when the engine's planner picked a
// non-host profile.
//
// Two paths converge on the same worker behavior:
//
//   - Source checkout: spawn `process.execPath run src/broker/worker.ts`.
//     `bun run <path>` is the standard entry, `import.meta.main` in
//     worker.ts drives execution.
//
//   - Compiled binary: `import.meta.dir` resolves to `/$bunfs/...`
//     which `bun run` can't address as a script path. Instead we
//     self-exec the same compiled binary (`process.execPath` is the
//     binary itself) with no CLI args + `FORJA_BROKER_WORKER=1`
//     env flag. `src/cli/index.ts` detects the flag BEFORE parseArgs
//     and dispatches to the worker's exported entry. Same module,
//     same lifecycle, same single binary — no temp files, no
//     embedded asset extraction.
//
// Per-call timeoutMs (slice 85) is set by the bashTool; the
// broker-construction `timeoutMs` is the fallback ceiling for
// callers that don't override (60s is generous for the bash
// family + headroom for handler startup).
const constructBroker = (
  mode: 'in-process' | 'spawn',
  cwd: string,
  sandboxTmpdir: string | undefined,
  // True iff a sandbox tool was available at boot. Drives the broker's
  // fail-closed posture: in spawn mode with the tool present at boot, a
  // non-host profile that can't resolve the tool now is a mid-session LOSS
  // → throw (surfaces as a tool error) instead of silent passthrough. False
  // when spawn was force-selected without a tool (`--broker spawn` on a host
  // with no bwrap) — it never had one, so keep the graceful degrade.
  sandboxAvailableAtBoot: boolean,
): Broker => {
  if (mode === 'spawn') {
    // Slice 103 (R6 #9): no `as SandboxProfile` cast. The TS
    // annotation upstream (`BrokerRequest.sandboxProfile: string |
    // null`) admits attacker-controlled strings; the cast would
    // silently launder an unknown profile through to
    // `maybeWrapSandboxArgv` where it could land in the platform
    // fallback (passthrough — unsandboxed exec). The runner now
    // validates the enum membership at the gate and throws on
    // unknown values; the broker's per-call try/catch maps the
    // throw to a structured `sandbox wrap failed` response.
    //
    // Slice 157 (phase 2): forward the per-CLI-run sandbox tmpdir
    // into every wrap. The closure captures it from bootstrap so a
    // single broker handles many calls with the same scoped tmpdir.
    //
    // `passthroughEnv` (slice review-broker-default follow-up):
    // forward `FORJA_BROKER_WORKER=1` through the kernel-boundary
    // clearenv. On the compiled-binary self-exec path, the wrapped
    // inner is `process.execPath` (the same forja binary); without
    // this passthrough, bwrap's `--clearenv` (Linux) or
    // sandbox-exec's `/usr/bin/env -i` wrap (macOS) drops the flag,
    // `src/cli/index.ts` falls through to normal CLI parsing
    // instead of `runWorkerProcess()`, and sandbox-enforced broker
    // calls silently fail on compiled installs. Harmless on the
    // source-checkout path (worker.ts enters via
    // `bun run <path>`'s `import.meta.main`, which never reads FBW).
    const sandboxRunner: SandboxRunner = ({ profile, cwd: callCwd, innerArgv }) =>
      maybeWrapSandboxArgv({
        profile,
        cwd: callCwd,
        innerArgv,
        ...(sandboxTmpdir !== undefined ? { tmpdir: sandboxTmpdir } : {}),
        passthroughEnv: { FORJA_BROKER_WORKER: '1' },
        // fail-closed on mid-session sandbox loss when the tool was present
        // at boot. A non-host profile that can't wrap now → throw → broker
        // maps to 'sandbox wrap failed' → tool error (LLM + operator see it)
        // instead of a silent unsandboxed run.
        failClosed: sandboxAvailableAtBoot,
      });
    // Slice 157 (phase 2): also overlay TMPDIR on the worker spawn's
    // env. The wrap above scopes WHERE the sandbox lets writes land;
    // this overlay tells mktemp / NSTemporaryDirectory / Python
    // tempfile inside the wrapped worker which subpath to use. Both
    // are required: without the wrap, the SBPL still allows blanket
    // /tmp; without the env, tools still pick /tmp/<random> and hit
    // the SBPL deny.
    //
    // FORJA_BROKER_WORKER=1 is added unconditionally — harmless on
    // the source-checkout path (worker.ts is entered via
    // `import.meta.main` regardless), load-bearing on the compiled-
    // binary self-exec path (index.ts checks it before parseArgs).
    const baseEnv =
      sandboxTmpdir !== undefined
        ? { ...scrubEnv(process.env), TMPDIR: sandboxTmpdir }
        : scrubEnv(process.env);
    const workerEnv = { ...baseEnv, FORJA_BROKER_WORKER: '1' };

    // Compiled-binary detection. Bun rewrites `import.meta.dir` to
    // the embedded `/$bunfs/...` asset root when the file lives
    // inside a compiled binary. The signature `/$bunfs/` is stable
    // across Bun versions; the `root` segment varies.
    const isCompiledBinary = import.meta.dir.includes('/$bunfs/');
    if (isCompiledBinary) {
      // Self-exec the same binary; index.ts entry detects the env
      // flag and routes to runWorkerProcess. No CLI args needed
      // (and none would help — worker mode is entirely env-driven).
      return createSpawnBroker({
        command: process.execPath,
        args: [],
        cwd,
        timeoutMs: 60_000,
        sandboxRunner,
        env: workerEnv,
      });
    }

    // Source checkout: spawn `bun run worker.ts`. The worker entry
    // file MUST exist on disk; if a future build/install layout
    // moves the file, surface a clear error rather than failing
    // later via a spawn-fail response.
    const workerPath = resolve(import.meta.dir, '../broker/worker.ts');
    if (!existsSync(workerPath)) {
      throw new Error(
        `broker mode 'spawn' requires worker source at ${workerPath}; not found in this install layout.`,
      );
    }
    return createSpawnBroker({
      command: process.execPath,
      args: ['run', workerPath],
      cwd,
      timeoutMs: 60_000,
      sandboxRunner,
      env: workerEnv,
    });
  }
  const bashHandler = createBashHandler({ scrubEnv });
  return createInProcessBroker({
    exec: (request, callOptions) => bashHandler.execute(request, callOptions),
  });
};
