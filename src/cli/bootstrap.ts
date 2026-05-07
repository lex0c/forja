import { join } from 'node:path';
import type { HarnessConfig, RunBudget } from '../harness/index.ts';
import {
  type HookConfigWarning,
  resolveHookConfig,
  resolveHookPaths,
  resolveHookShell,
} from '../hooks/index.ts';
import {
  createMemoryRegistry,
  evaluateBootTriggers,
  gcExpiredMemories,
  resolveRepoRoot,
  resolveScopeRoots,
} from '../memory/index.ts';
import { type LockConflict, createPermissionEngine, resolvePolicy } from '../permissions/index.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { Provider } from '../providers/index.ts';
import { type DB, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { type SubagentSet, loadSubagents, validateSubagentSet } from '../subagents/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { isTrusted, trustListPath } from '../trust/index.ts';
import { assembleMemorySection, composeSystemPrompt } from './memory-prompt.ts';
import { composeWithParallelHint } from './parallel-prompt.ts';
import { composeWithUserPrompt } from './plan-prompt.ts';
import { composeWithPlaybookHint } from './playbook-prompt.ts';
import { assembleProjectPointer, composeWithProjectPointer } from './project-pointer.ts';
import { composeWithResponseFormat } from './response-format.ts';

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

export interface BootstrapInput {
  prompt: string;
  modelId?: string;
  cwd?: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  // Plan mode (AGENTIC_CLI §5): read-only profile. Plumbs through
  // to the harness's planMode flag and triggers injection of a
  // plan-aware system prompt instructing structured output.
  plan?: boolean;
  // Caller-supplied system prompt. When `plan` is also set, the
  // plan-mode prompt is prepended (plan-mode is the operating
  // profile; user content is layered as extra context).
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
}

export interface BootstrapResult {
  config: HarnessConfig;
  db: DB;
  modelId: string;
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
}

// Build a HarnessConfig from environment + cwd + args. This is the main
// entry-shaped wiring: read API key from env (the adapter does it), open
// the DB, migrate, register builtins, load policy from `.agent/permissions.yaml`
// if present, instantiate the provider from the registry. Any failure
// (unknown model, missing API key) bubbles up — the caller decides whether
// to print to stderr and exit 1.
export const bootstrap = (input: BootstrapInput): BootstrapResult => {
  const cwd = input.cwd ?? process.cwd();
  const modelId = input.modelId ?? DEFAULT_MODEL;

  // Resolve everything that *can throw* before opening the DB, so a
  // policy YAML error or unknown model doesn't leak a SQLite handle
  // (and the WAL files that come with it).
  let provider: Provider;
  if (input.providerOverride !== undefined) {
    provider = input.providerOverride;
  } else {
    const registry = createDefaultRegistry();
    const entry = registry.get(modelId);
    if (entry === null) {
      throw new Error(
        `unknown model: ${modelId}. Known: ${registry
          .list()
          .map((e) => e.id)
          .join(', ')}`,
      );
    }
    provider = entry.factory();
  }

  // Hierarchy: enterprise → user → project → session. Each layer is
  // optional; absent layers contribute nothing. The resolver merges
  // with locked-section semantics so an enterprise-marked rule
  // (`tools.bash.locked: true`) cannot be overridden downstream.
  const resolved = resolvePolicy({
    cwd,
    ...(input.enterprisePolicyPath !== undefined
      ? { enterprisePath: input.enterprisePolicyPath }
      : {}),
    ...(input.userPolicyPath !== undefined ? { userPath: input.userPolicyPath } : {}),
  });
  const permissionEngine = createPermissionEngine(resolved.policy, { cwd });
  const policyLayers = resolved.layers.map((l) => l.layer);

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

  // From here on, anything that throws must close the DB.
  // `migrate` and `createMemoryRegistry` are the realistic
  // offenders — schema-version drift surfaces in migrate, and
  // the registry's eager index load can hit fs errors other than
  // ENOENT (EACCES on a misconfigured user scope, EIO, etc.).
  // ENOENT is already handled inside loadScopeIndex as `absent`.
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = openDb(dbPath);

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
  let memoryRegistry: ReturnType<typeof createMemoryRegistry>;
  let resolvedHooks: ReturnType<typeof resolveHookConfig>;
  try {
    migrate(db);

    // Resolve the effective system prompt. Five layers stack
    // here in precedence order (most-specific to most-generic):
    //   1. Caller's user prompt (input.systemPrompt) — most
    //      specific, the operator's own framing.
    //   2. Plan mode prompt — operating-mode framing for
    //      `--plan` invocations only.
    //   3. Playbook discovery hint — table of available
    //      subagents + auto-delegation criteria (PLAYBOOKS.md
    //      §1.4). Sits between parallel and plan/user because
    //      the table assumes the model already knows the
    //      task_async family from the parallel layer.
    //   4. Parallelism hint — universal background that
    //      surfaces the harness's concurrency affordances
    //      (multi-tool turns, task_async family) so the
    //      capability isn't dormant.
    //   5. Response-format hint — render-target rules
    //      (CommonMark in monospace ANSI, file:line refs,
    //      no-emoji default, structural padding bans) per
    //      ANTI_PATTERNS.md §1.3 ("output format expectations
    //      literais"). Sits OUTERMOST because it applies to
    //      every other section's output equally.
    //
    // Composition order: response-format FIRST (most general
    // surface contract), then parallel hint, then playbook
    // hint, then plan/user (more-specific instructions). Each
    // `composeWith*Hint` prepends its hint to the downstream
    // chunk it receives, so we wrap from the inside out.
    const baseDownstream =
      input.plan === true ? composeWithUserPrompt(input.systemPrompt) : input.systemPrompt;
    const withPlaybook = composeWithPlaybookHint(baseDownstream, subagents);
    const withParallel = composeWithParallelHint(withPlaybook);
    resolvedSystemPrompt = composeWithResponseFormat(withParallel);

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
    // Single `repoRoot` value keeps the two consumers aligned.
    const repoRoot = resolveRepoRoot(cwd);
    const memoryRoots = resolveScopeRoots(repoRoot);
    memoryRegistry = createMemoryRegistry({ roots: memoryRoots, db, cwd });
    // SessionStart expiry GC (spec MEMORY.md §6.2). Auto-removes
    // memories whose `expires:` field is on or before today. Each
    // removal emits a `memory_events` row with `action: 'expired'`
    // so the operator can audit "what disappeared and when". We
    // run this BEFORE assembling the eager prompt section so the
    // model never sees stale entries that vanish mid-session. The
    // session id isn't known yet (the harness loop creates it
    // later), so the audit rows here land with sessionId NULL —
    // the lifecycle GC is conceptually a session-bootstrap event,
    // not a per-session-conversation one. cwd is forwarded so
    // `/memory audit` can group GC events by working directory.
    //
    // Failures (sandbox / io / unknown) get a `refused` audit row
    // with stage='lifecycle_gc' AND a stderr line so the operator
    // sees them in two places: the persistent audit table (for
    // forensic review) and the live stderr stream (for "something
    // unusual happened on this boot"). A bootstrap-blocking
    // failure would be wrong — one bad memory shouldn't gate the
    // session — but silently dropping the failure is worse.
    const gcResult = gcExpiredMemories(memoryRegistry, memoryRoots, { auditCwd: cwd });
    for (const failure of gcResult.failures) {
      process.stderr.write(
        `forja: memory gc: failed to expire ${failure.memory.scope}/${failure.memory.name} (expires ${failure.memory.expires}): ${failure.reason}\n`,
      );
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
    // Pointer to AGENTS.md; body lazy via read_file. Sits in the
    // composed string BEFORE [memory_index] to match the layout in
    // §2 — most-stable-first ordering keeps the cache breakpoint
    // economy intact: the pointer changes only when AGENTS.md is
    // renamed/removed, while memory index changes on every
    // /memory write. Empty-text section passes the base prompt
    // through unchanged when AGENTS.md is absent or cwd is
    // untrusted.
    const projectPointer = assembleProjectPointer({ cwd, repoRoot, isCwdTrusted });
    resolvedSystemPrompt = composeWithProjectPointer(resolvedSystemPrompt, projectPointer.text);
    const memorySection = assembleMemorySection({
      registry: memoryRegistry,
      bootContext,
    });
    resolvedSystemPrompt = composeSystemPrompt(resolvedSystemPrompt, memorySection.text);

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
    db.close();
    throw e;
  }

  // Background-process log directory. Lives under `.agent/bg/`
  // alongside the DB (spec §2.7). The harness creates it on first
  // spawn; we just declare the path here so the manager knows where
  // to put log files. Per-cwd: a worktree's bg processes don't
  // collide with the parent repo's.
  const bgLogDir = join(cwd, '.agent', 'bg');

  // (`trustPath` and `isCwdTrusted` resolved above the try-block
  // so the project-pointer section can gate on them at prompt-
  // assembly time; both are still consumed below — memory_write
  // honors the same flag (MEMORY.md §7.2.1) and the harness
  // surfaces it for downstream gates.)

  const config: HarnessConfig = {
    provider,
    toolRegistry,
    permissionEngine,
    db,
    cwd,
    bgLogDir,
    userPrompt: input.prompt,
    // Checkpoints (M3 §12): enabled for every CLI run by default
    // so users get `--undo` for free. Plan mode opts out — there's
    // nothing to undo when no writes can land. Disabling here also
    // saves one git probe per run, which matters when --plan is
    // used inside non-git directories for read-only inspections.
    enableCheckpoints: input.plan !== true,
    // Wire the subagent set so the `task` tool can resolve names.
    // Always passed (even when empty) — the tool surfaces a clear
    // "no subagents defined" hint instead of "registry missing"
    // when there are simply no .md files yet.
    subagentRegistry: subagents,
    memoryRegistry,
    isCwdTrusted,
    // Hooks resolved at boot (spec AGENTIC_CLI.md §10). When the
    // list is empty (no config files exist) we still pass the
    // empty array — the harness's loop is unconditional, the
    // chain-filter is the no-op when there are no hooks for the
    // event.
    hooks: resolvedHooks.hooks,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.plan === true ? { planMode: true } : {}),
    ...(resolvedSystemPrompt !== undefined ? { systemPrompt: resolvedSystemPrompt } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.resumeFromSessionId !== undefined
      ? { resumeFromSessionId: input.resumeFromSessionId }
      : {}),
  };

  return {
    config,
    db,
    modelId,
    policyLayers,
    lockConflicts: resolved.lockConflicts,
    subagents,
    hookWarnings: resolvedHooks.warnings,
  };
};
