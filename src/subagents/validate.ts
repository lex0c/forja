import type { ToolRegistry } from '../tools/index.ts';
import type { SubagentDefinition } from './types.ts';

// Validate a subagent definition against the active tool registry.
//
// Step 4.1 safety depends on preventing any mutating tool from
// running inside a subagent because `runSubagent` disables
// checkpoints (`enableCheckpoints: false`); a write tool from a
// child session has no reverse path through `--undo`, and the
// child's would-be checkpoints aren't reachable from the parent's
// session id either. The earlier guard relied on a hard-coded
// name list (`write_file`, `edit_file`, the bash family) — fragile
// against newly registered tools or external tools that opt into
// `metadata.writes: true`. This validator gates on the CAPABILITY,
// not the name, so any future tool that declares writes inherits
// the refusal automatically.
//
// Two checks per tool:
//   1. The tool must be registered with the active registry. The
//      runtime would catch this at child-registry construction
//      time too, but pulling it forward gives the author a clean
//      bootstrap-time error instead of a deferred spawn failure.
//   2. The tool's metadata must NOT declare `writes: true`. Step
//      4.2 worktree isolation lifts this restriction for tools
//      that opt in via the worktree subsystem; until then the
//      refusal is unconditional.
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
  for (const toolName of definition.tools) {
    const tool = registry.get(toolName);
    if (tool === null) {
      throw new Error(
        `subagent '${definition.name}' (${definition.sourcePath}): tool '${toolName}' is not registered with the active toolset`,
      );
    }
    if (tool.metadata.writes === true) {
      throw new Error(
        `subagent '${definition.name}' (${definition.sourcePath}): tool '${toolName}' declares metadata.writes=true and cannot appear in subagent.tools[] in Step 4.1 — write tools require worktree isolation (Step 4.2) so the parent's --undo can reverse the child's mutations. Remove the tool or wait for worktree support.`,
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
