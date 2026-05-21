import {
  type SkillCatalog,
  type SkillScope,
  createSkill,
  deleteSkill,
  moveSkill,
} from '../../../skills/index.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

// `/skill` — operator surface for the skills subsystem lifecycle
// (spec SKILLS.md §6). Subcommands: list / show / new / promote /
// demote / delete. `capture` (turn a session into a skill) and
// `import` (the `imported` scope) are v2.
//
// Disk mutations live in `src/skills/lifecycle.ts`; this command is
// the thin dispatch + presentation layer. After any mutation it
// `reload()`s the catalog so the live `skill_list` / `skill_invoke`
// tools see the change within the same session (the system-prompt
// catalog section is fixed at boot — the model picks a new skill up
// next session, or via `skill_list` now).
//
// Destructive ops gate on an explicit `--confirm` token rather than
// a modal: `promote user` crosses into the host-global scope and
// `delete` removes a file, so each first prints what it will do and
// asks for a re-run. The within-project moves (`promote shared`,
// `demote local`) are reversible and just report what they did
// (spec §6.3: "never silent").

// Split the `--confirm` flag out of the positional args so it can
// appear in any position — without this, `name = positionals[0]`
// would mistake a leading `--confirm` for the skill name.
const splitConfirm = (rest: string[]): { positionals: string[]; confirmed: boolean } => ({
  positionals: rest.filter((arg) => arg !== '--confirm'),
  confirmed: rest.includes('--confirm'),
});

const handleList = (catalog: SkillCatalog): SlashResult => {
  const entries = catalog.list();
  const filtered = catalog.filtered();
  if (entries.length === 0 && filtered.length === 0) {
    return { kind: 'ok', notes: ['no skills — /skill new <name> to scaffold one'] };
  }
  const notes: string[] = [`skills (${entries.length}):`];
  for (const entry of entries) {
    notes.push(`  [${entry.scope}] ${entry.name} — ${entry.frontmatter.description}`);
  }
  if (filtered.length > 0) {
    notes.push(`${filtered.length} file(s) not loaded:`);
    for (const dropped of filtered) {
      notes.push(`  [${dropped.scope}] ${dropped.name} — ${dropped.reason}`);
    }
  }
  return { kind: 'ok', notes };
};

const handleShow = (catalog: SkillCatalog, positionals: string[]): SlashResult => {
  const name = positionals[0];
  if (name === undefined) {
    return { kind: 'error', message: '/skill show: usage — /skill show <name>' };
  }
  const result = catalog.read(name);
  if (result.kind === 'not_found') {
    return { kind: 'error', message: `/skill show: no skill named '${name}'` };
  }
  if (result.kind === 'missing') {
    return {
      kind: 'error',
      message: `/skill show: '${name}' is in the catalog but its file is gone`,
    };
  }
  if (result.kind === 'malformed') {
    return { kind: 'error', message: `/skill show: '${name}' failed to load — ${result.error}` };
  }
  const fm = result.file.frontmatter;
  const notes: string[] = [`[${result.scope}] ${name} — ${fm.description}`];
  if (fm.version !== undefined) notes.push(`version: ${fm.version}`);
  notes.push('---');
  if (result.file.body.length === 0) {
    notes.push('(empty body)');
  } else {
    notes.push(...result.file.body.split('\n'));
  }
  return { kind: 'ok', notes };
};

const handleNew = (catalog: SkillCatalog, positionals: string[]): SlashResult => {
  const name = positionals[0];
  if (name === undefined) {
    return { kind: 'error', message: '/skill new: usage — /skill new <name>' };
  }
  // New skills land in project_local — the lowest, gitignored scope.
  // `/skill promote` moves a vetted one up to shared or user.
  const result = createSkill(catalog.roots, 'project_local', name);
  if (!result.ok) {
    return { kind: 'error', message: `/skill new: ${result.message}` };
  }
  catalog.reload();
  return {
    kind: 'ok',
    notes: [
      `created ${result.path}`,
      'edit it to fill in the description + body; /skill promote shared to share it',
    ],
  };
};

// Run a move, reload the catalog, and report. Shared by promote and
// demote — the direction checks live in their handlers. `label` is
// the subcommand name, so an IO failure surfaces under the same
// `/skill <label>:` prefix the handler's usage errors use.
const applyMove = (
  catalog: SkillCatalog,
  name: string,
  from: SkillScope,
  to: SkillScope,
  label: string,
  okNote: string,
): SlashResult => {
  const result = moveSkill(catalog.roots, name, from, to);
  if (!result.ok) {
    return { kind: 'error', message: `/skill ${label}: ${result.message}` };
  }
  catalog.reload();
  return { kind: 'ok', notes: [okNote, `→ ${result.path}`] };
};

const handlePromote = (
  catalog: SkillCatalog,
  positionals: string[],
  confirmed: boolean,
): SlashResult => {
  const target = positionals[0];
  const name = positionals[1];
  if (name === undefined || (target !== 'shared' && target !== 'user')) {
    return {
      kind: 'error',
      message: '/skill promote: usage — /skill promote <shared|user> <name>',
    };
  }
  const entry = catalog.lookup(name);
  if (entry === null) {
    return { kind: 'error', message: `/skill promote: no resolved skill named '${name}'` };
  }
  if (target === 'shared') {
    if (entry.scope !== 'project_local') {
      return {
        kind: 'error',
        message: `/skill promote: '${name}' is in scope '${entry.scope}' — promote shared moves project_local → project_shared`,
      };
    }
    return applyMove(
      catalog,
      name,
      'project_local',
      'project_shared',
      'promote',
      `promoted '${name}' to project_shared`,
    );
  }
  // target === 'user' — crosses into the host-global scope; gate it.
  if (entry.scope === 'user') {
    return { kind: 'error', message: `/skill promote: '${name}' is already a user skill` };
  }
  if (!confirmed) {
    return {
      kind: 'ok',
      notes: [
        `/skill promote user '${name}': moves it from ${entry.scope} into your host-global`,
        'user scope — it will then apply to every project on this machine.',
        `re-run as: /skill promote user ${name} --confirm`,
      ],
    };
  }
  return applyMove(
    catalog,
    name,
    entry.scope,
    'user',
    'promote',
    `promoted '${name}' to user scope`,
  );
};

const handleDemote = (catalog: SkillCatalog, positionals: string[]): SlashResult => {
  const target = positionals[0];
  const name = positionals[1];
  if (name === undefined || target !== 'local') {
    return { kind: 'error', message: '/skill demote: usage — /skill demote local <name>' };
  }
  const entry = catalog.lookup(name);
  if (entry === null) {
    return { kind: 'error', message: `/skill demote: no resolved skill named '${name}'` };
  }
  if (entry.scope !== 'project_shared') {
    return {
      kind: 'error',
      message: `/skill demote: '${name}' is in scope '${entry.scope}' — demote local moves project_shared → project_local`,
    };
  }
  return applyMove(
    catalog,
    name,
    'project_shared',
    'project_local',
    'demote',
    `demoted '${name}' to project_local`,
  );
};

const handleDelete = (
  catalog: SkillCatalog,
  positionals: string[],
  confirmed: boolean,
): SlashResult => {
  const name = positionals[0];
  if (name === undefined) {
    return { kind: 'error', message: '/skill delete: usage — /skill delete <name>' };
  }
  const entry = catalog.lookup(name);
  if (entry === null) {
    return { kind: 'error', message: `/skill delete: no resolved skill named '${name}'` };
  }
  if (!confirmed) {
    return {
      kind: 'ok',
      notes: [
        `/skill delete '${name}': removes [${entry.scope}] ${name} from disk.`,
        `re-run as: /skill delete ${name} --confirm`,
      ],
    };
  }
  const result = deleteSkill(catalog.roots, entry.scope, name);
  if (!result.ok) {
    return { kind: 'error', message: `/skill delete: ${result.message}` };
  }
  catalog.reload();
  const notes = [`deleted [${entry.scope}] ${name}`];
  // A same-name skill in a lower-precedence scope was shadowed by the
  // one just deleted and is now the resolved skill. Say so — deleting
  // 'x' and leaving 'x' resolvable is exactly the silent surprise
  // §6.3 argues against.
  const remaining = catalog.lookup(name);
  if (remaining !== null) {
    notes.push(
      `note: '${name}' still resolves — a shadowed copy in [${remaining.scope}] is now active`,
    );
  }
  return { kind: 'ok', notes };
};

export const skillCommand: SlashCommand = {
  name: 'skill',
  description: 'Manage skills — list, show, new, promote, demote, delete',
  // `exec` is async only to satisfy the SlashCommand contract; every
  // handler is synchronous (the lifecycle ops are sync `fs`).
  exec: async (args: string[], ctx: SlashContext): Promise<SlashResult> => {
    const catalog = ctx.baseConfig.skillCatalog;
    if (catalog === undefined) {
      return { kind: 'error', message: '/skill: skill catalog unavailable in this context' };
    }
    const sub = args[0];
    const { positionals, confirmed } = splitConfirm(args.slice(1));
    switch (sub) {
      case undefined:
      case 'list':
        return handleList(catalog);
      case 'show':
        return handleShow(catalog, positionals);
      case 'new':
        return handleNew(catalog, positionals);
      case 'promote':
        return handlePromote(catalog, positionals, confirmed);
      case 'demote':
        return handleDemote(catalog, positionals);
      case 'delete':
        return handleDelete(catalog, positionals, confirmed);
      default:
        return {
          kind: 'error',
          message: `/skill: unknown subcommand '${sub}' (try: list, show, new, promote, demote, delete)`,
        };
    }
  },
};
