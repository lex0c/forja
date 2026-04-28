import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig, RunBudget } from '../harness/index.ts';
import { createPermissionEngine, defaultPolicy, loadPolicyFromFile } from '../permissions/index.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { Provider } from '../providers/index.ts';
import { type DB, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
export const PROJECT_POLICY_PATH = '.agent/permissions.yaml';

export interface BootstrapInput {
  prompt: string;
  modelId?: string;
  cwd?: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  // Test seam: when set, skip the registry lookup and use this provider.
  providerOverride?: Provider;
  // Test seam: override the DB path (default: defaultDbPath()).
  dbPath?: string;
}

export interface BootstrapResult {
  config: HarnessConfig;
  db: DB;
  modelId: string;
  policySource: 'project' | 'default';
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

  const policyFullPath = join(cwd, PROJECT_POLICY_PATH);
  const policySource: BootstrapResult['policySource'] = existsSync(policyFullPath)
    ? 'project'
    : 'default';
  const policy = policySource === 'project' ? loadPolicyFromFile(policyFullPath) : defaultPolicy();
  const permissionEngine = createPermissionEngine(policy, { cwd });

  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

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

  const config: HarnessConfig = {
    provider,
    toolRegistry,
    permissionEngine,
    db,
    cwd,
    userPrompt: input.prompt,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };

  return { config, db, modelId, policySource };
};
