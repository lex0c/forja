import { join } from 'node:path';
import type { HarnessConfig, RunBudget } from '../harness/index.ts';
import { type LockConflict, createPermissionEngine, resolvePolicy } from '../permissions/index.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { Provider } from '../providers/index.ts';
import { type DB, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { type SubagentSet, loadSubagents, validateSubagentSet } from '../subagents/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { composeWithUserPrompt } from './plan-prompt.ts';

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

  // From here on, anything that throws must close the DB. `migrate` is
  // the only realistic offender — schema-version drift surfaces here.
  const dbPath = input.dbPath ?? defaultDbPath();
  const db = openDb(dbPath);
  try {
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }

  // Resolve the effective system prompt. Plan mode prepends its
  // own prompt to whatever the caller supplied; without plan mode,
  // the caller's prompt passes through unchanged.
  let resolvedSystemPrompt: string | undefined;
  if (input.plan === true) {
    resolvedSystemPrompt = composeWithUserPrompt(input.systemPrompt);
  } else if (input.systemPrompt !== undefined) {
    resolvedSystemPrompt = input.systemPrompt;
  }

  // Background-process log directory. Lives under `.agent/bg/`
  // alongside the DB (spec §2.7). The harness creates it on first
  // spawn; we just declare the path here so the manager knows where
  // to put log files. Per-cwd: a worktree's bg processes don't
  // collide with the parent repo's.
  const bgLogDir = join(cwd, '.agent', 'bg');

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
  };
};
