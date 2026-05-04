import type { ToolRegistry } from '../tools/index.ts';
import type { SubagentDefinition } from './types.ts';

// Validate a subagent definition against the active tool registry.
//
// Step 4.1 safety depends on preventing any mutating tool from
// running inside a default-isolation subagent because `runSubagent`
// disables checkpoints (`enableCheckpoints: false`); a write tool
// from a child session has no reverse path through `--undo`, and
// the child's would-be checkpoints aren't reachable from the parent's
// session id either. The earlier guard relied on a hard-coded
// name list (`write_file`, `edit_file`, the bash family) — fragile
// against newly registered tools or external tools that opt into
// `metadata.writes: true`. This validator gates on the CAPABILITY,
// not the name, so any future tool that declares writes inherits
// the refusal automatically.
//
// Step 4.2 lifts this gate ONLY when the definition declares
// `isolation: worktree` in its frontmatter — the child then runs
// inside a dedicated git worktree (separate branch, separate
// working tree from the parent), so write tools can mutate freely
// without polluting the parent's tree. The validator still rejects
// unregistered tool names regardless of isolation.
//
// Three checks per tool:
//   1. The tool must be registered with the active registry. The
//      runtime would catch this at child-registry construction
//      time too, but pulling it forward gives the author a clean
//      bootstrap-time error instead of a deferred spawn failure.
//   2. The tool's metadata must NOT declare `writes: true` UNLESS
//      the definition opts into worktree isolation. Without
//      worktree, mutating tools have no reverse path; with it,
//      the worktree contains them.
//   3. The tool's metadata must NOT declare `requiresOperatorConfirm`
//      regardless of isolation. These tools (today only
//      `memory_write`) need a modal pipe to the parent's operator
//      REPL; subagents are headless from the operator's perspective
//      and have no IPC channel for confirms. Worktree isolation
//      doesn't help here — the missing piece is the modal callback,
//      not filesystem containment. A future slice that grows IPC's
//      surface (spec §11) to thread confirms back through the parent
//      will lift this gate; until then, we reject at validate time
//      so the author gets a clean error instead of a deferred
//      `headless_mode` rejection at first invocation.
//
// Step 4.2b.iv lifted the third check (`requiresBgManager`):
// every subagent now gets its own bg log directory namespaced
// under `<parentCwd>/.agent/bg/<childSessionId>/`, so
// `bash_background` / `bash_output` / `bash_kill` /
// process-aware `wait_for` and `monitor` are safe to expose. The
// child's harness wires the directory in via `--subagent-bg-log-dir`
// and the bg manager creates it on first spawn; cleanup is a
// recursive rm at end-of-run.
//
// Throws on the first violation with a source-aware message that
// names the offending definition path. Bootstrap calls this for
// every loaded definition; the runtime calls it again at spawn
// time as defense in depth — ensures programmatic callers (evals,
// future tooling) get the same protection without depending on
// the bootstrap path.
export const validateSubagentTools = (
  definition: SubagentDefinition,
  registry: ToolRegistry,
): void => {
  const allowWrites = definition.isolation === 'worktree';
  for (const toolName of definition.tools) {
    const tool = registry.get(toolName);
    if (tool === null) {
      throw new Error(
        `subagent '${definition.name}' (${definition.sourcePath}): tool '${toolName}' is not registered with the active toolset`,
      );
    }
    // requiresOperatorConfirm is stricter than writes — checked
    // first so the operator gets the more specific reason. A
    // confirm-bound tool that ALSO declares writes=true would
    // otherwise surface the writes-without-worktree error and
    // mislead the operator into adding `isolation: worktree`,
    // which doesn't unblock anything.
    if (tool.metadata.requiresOperatorConfirm === true) {
      throw new Error(
        `subagent '${definition.name}' (${definition.sourcePath}): tool '${toolName}' declares metadata.requiresOperatorConfirm=true and cannot appear in subagent.tools[] — the tool needs a modal-confirmation pipe to the parent REPL, which subagents do not have today. Remove the tool from this subagent's whitelist.`,
      );
    }
    if (tool.metadata.writes === true && !allowWrites) {
      throw new Error(
        `subagent '${definition.name}' (${definition.sourcePath}): tool '${toolName}' declares metadata.writes=true and cannot appear in subagent.tools[] without 'isolation: worktree' — write tools require worktree isolation so the parent's tree stays untouched. Add 'isolation: worktree' to the frontmatter or remove the tool.`,
      );
    }
  }
};

// Run the validator across an entire SubagentSet. Bootstrap calls
// this after loading definitions and before threading the set
// into HarnessConfig — a single corrupt definition fails the
// whole bootstrap rather than landing as a deferred runtime error
// at first task() invocation.
export const validateSubagentSet = (
  definitions: Iterable<SubagentDefinition>,
  registry: ToolRegistry,
): void => {
  for (const def of definitions) {
    validateSubagentTools(def, registry);
  }
};
