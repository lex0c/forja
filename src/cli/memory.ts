// `agent --memory <verb>` handler. Independent of bootstrap (no
// provider, no permissions, no tool registry — only DB + cwd) so
// inspecting memory doesn't require an API key. Mirrors the
// structure of `runWorktreesCli` and `runCheckpointsCli`.
//
// Subcommands:
//   list [scope]            — entries from all scopes (or one);
//                             table or NDJSON
//   show <name> [scope]     — frontmatter + body of one memory.
//                             Emits a `read` audit event with
//                             session_id=null (operator-driven
//                             inspection, not an agent action) so
//                             the audit log captures every read
//                             regardless of who triggered it.
//
// Scope precedence on lookup matches the registry: project_local
// > project_shared > user. With an explicit scope positional, the
// lookup is strict (no fallback) — same as `memory_read`.

import {
  FrontmatterError,
  type MemoryListing,
  type MemoryRegistry,
  type MemoryScope,
  createMemoryRegistry,
  resolveRepoRoot,
  resolveScopeRoots,
  validateName,
} from '../memory/index.ts';
import { type DB, closeDb, defaultDbPath, migrate, openDb } from '../storage/index.ts';

export interface MemoryCliInput {
  verb: 'list' | 'show';
  positionals: string[];
  json: boolean;
  cwd: string;
  // Test seams.
  dbPath?: string;
  dbOverride?: DB;
  // Output sinks. Same stdout-pure / stderr-for-logs split spec
  // §2.6 mandates.
  out: (s: string) => void;
  err: (s: string) => void;
}

const VALID_VERBS = ['list', 'show'] as const;
const VALID_SCOPES = new Set<MemoryScope>(['user', 'project_shared', 'project_local']);

const isScopeArg = (token: string): token is MemoryScope => VALID_SCOPES.has(token as MemoryScope);

interface ListEntryJson {
  scope: MemoryScope;
  name: string;
  description: string;
  href: string;
  // Present only for vendor seeds (spec §5.7.3 — operator surface
  // must distinguish vendor-curated meta-behavior from operator-
  // authored memories). Omitted on non-seed entries to keep the
  // payload additive: existing JSON consumers parse identical bytes
  // for the user/shared/local cases they already exercise.
  subdir?: 'seeds';
}

const renderListEntry = (l: MemoryListing): ListEntryJson => {
  const base: ListEntryJson = {
    scope: l.scope,
    name: l.name,
    description: l.entry.hook,
    href: l.entry.href,
  };
  if (l.subdir === 'seeds') base.subdir = 'seeds';
  return base;
};

const writeListJson = (entries: ListEntryJson[], out: (s: string) => void): void => {
  for (const e of entries) out(`${JSON.stringify(e)}\n`);
};

const writeListTable = (entries: ListEntryJson[], out: (s: string) => void): void => {
  if (entries.length === 0) {
    out('no memories found.\n');
    return;
  }
  out(`${['scope', 'name', 'description'].join('  ')}\n`);
  for (const e of entries) {
    // `[seed]` suffix matches the slash `/memory list` and the
    // eager-load convention (after the name, ahead of the
    // description). The table form omits any seed column to keep
    // the historical three-column layout; operators scripting
    // against table output read the suffix, JSON consumers read
    // the `subdir` field.
    const seedSuffix = e.subdir === 'seeds' ? ' [seed]' : '';
    out(`${e.scope}  ${e.name}${seedSuffix}  ${e.description}\n`);
  }
};

const runList = (
  registry: MemoryRegistry,
  positionals: string[],
  json: boolean,
  out: (s: string) => void,
  err: (s: string) => void,
): number => {
  // Optional scope positional. We accept zero or one positional;
  // anything else is a typo (e.g. `agent --memory list role` when
  // the operator meant `show`).
  if (positionals.length > 1) {
    err(`forja: --memory list takes at most one scope positional; got: ${positionals.join(' ')}\n`);
    return 1;
  }
  const scopeArg = positionals[0];
  if (scopeArg !== undefined && !isScopeArg(scopeArg)) {
    err(`forja: invalid scope '${scopeArg}'. Use one of user, project_shared, project_local\n`);
    return 1;
  }
  const listings = registry.list(scopeArg !== undefined ? { scope: scopeArg } : {});
  const rendered = listings.map(renderListEntry);
  if (json) {
    writeListJson(rendered, out);
    out(`${JSON.stringify({ count: rendered.length })}\n`);
  } else {
    writeListTable(rendered, out);
  }
  return 0;
};

interface ShowJson {
  scope: MemoryScope;
  name: string;
  description: string;
  type: string;
  source: string;
  expires?: string;
  trust?: string;
  triggers?: string[];
  body: string;
}

const runShow = (
  registry: MemoryRegistry,
  positionals: string[],
  json: boolean,
  out: (s: string) => void,
  err: (s: string) => void,
): number => {
  if (positionals.length === 0 || positionals.length > 2) {
    err(
      `forja: --memory show requires <name> and accepts an optional scope; got: ${positionals.join(' ') || '(empty)'}\n`,
    );
    return 1;
  }
  const name = positionals[0];
  if (name === undefined) {
    err('forja: --memory show requires <name>\n');
    return 1;
  }
  const scopeArg = positionals[1];
  if (scopeArg !== undefined && !isScopeArg(scopeArg)) {
    err(`forja: invalid scope '${scopeArg}'. Use one of user, project_shared, project_local\n`);
    return 1;
  }

  // Defense-in-depth: validate the name BEFORE hitting the
  // registry. The registry's `findListing` would silently return
  // null for `../escape` (no listing matches by name), surfacing
  // as `unknown` and masking the path-traversal attempt. Mirrors
  // the same pattern in the memory_read tool surface.
  try {
    validateName(name);
  } catch (e) {
    if (e instanceof FrontmatterError) {
      err(`forja: invalid memory name: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const result = registry.read(name, scopeArg !== undefined ? { scope: scopeArg } : {});

  if (result.kind === 'unknown') {
    const scopeQual = scopeArg !== undefined ? ` in scope ${scopeArg}` : '';
    err(`forja: no memory named '${name}'${scopeQual}\n`);
    return 1;
  }
  if (result.kind === 'missing') {
    err(
      `forja: memory '${name}' is indexed in scope ${result.scope} but the body file is missing\n`,
    );
    return 1;
  }
  if (result.kind === 'malformed') {
    err(`forja: memory '${name}' (scope ${result.scope}) failed to parse: ${result.error}\n`);
    return 1;
  }

  const fm = result.file.frontmatter;
  if (json) {
    const obj: ShowJson = {
      scope: result.scope,
      name: fm.name,
      description: fm.description,
      type: fm.type,
      source: fm.source,
      body: result.file.body,
    };
    if (fm.expires !== undefined) obj.expires = fm.expires;
    if (fm.trust !== undefined) obj.trust = fm.trust;
    if (fm.triggers !== undefined) obj.triggers = fm.triggers;
    out(`${JSON.stringify(obj)}\n`);
    return 0;
  }

  // Plain mode: header line with scope/name/type, then frontmatter
  // metadata, then a blank line, then the body verbatim. Operator
  // can pipe to less or grep.
  out(`scope: ${result.scope}\n`);
  out(`name: ${fm.name}\n`);
  out(`type: ${fm.type}\n`);
  out(`source: ${fm.source}\n`);
  out(`description: ${fm.description}\n`);
  if (fm.expires !== undefined) out(`expires: ${fm.expires}\n`);
  if (fm.trust !== undefined) out(`trust: ${fm.trust}\n`);
  if (fm.triggers !== undefined) out(`triggers: ${fm.triggers.join(', ')}\n`);
  out('\n');
  out(result.file.body);
  if (!result.file.body.endsWith('\n')) out('\n');
  return 0;
};

export const runMemoryCli = async (input: MemoryCliInput): Promise<number> => {
  const { verb, positionals, json, cwd, out, err } = input;

  if (!VALID_VERBS.includes(verb)) {
    err(`forja: unknown --memory subcommand: ${verb}. Use one of ${VALID_VERBS.join('|')}\n`);
    return 1;
  }

  // DB open (or test override). Migrations run defensively — this
  // may be the first command after upgrading.
  const db = input.dbOverride ?? openDb(input.dbPath ?? defaultDbPath());
  try {
    if (input.dbOverride === undefined) migrate(db);

    // Build the registry from the REPO root, not the invocation
    // cwd. Project memory lives at `<repo>/.agent/memory/...`;
    // an operator running `agent --memory list` from a subdir
    // would otherwise see empty project scopes. Falls back to
    // cwd when not in a git repo. The CLI doesn't have a session
    // (operator-driven inspection); the registry's audit hook
    // tolerates `sessionId: undefined` and persists a row with
    // session_id=NULL — the audit log still captures the read,
    // but the operator-vs-agent distinction is preserved by the
    // null session linkage.
    const roots = resolveScopeRoots(resolveRepoRoot(cwd));
    const registry = createMemoryRegistry({ roots, db, cwd });

    if (verb === 'list') {
      return runList(registry, positionals, json, out, err);
    }
    return runShow(registry, positionals, json, out, err);
  } catch (e) {
    err(`forja: --memory ${verb} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    if (input.dbOverride === undefined) {
      try {
        closeDb(db);
      } catch {
        // ignore
      }
    }
  }
};
