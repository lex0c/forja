import type { Tool } from './types.ts';

export interface ToolRegistry {
  register(tool: Tool): void;
  // Remove a tool by wire name; returns true if it was present. Used for the
  // mid-session MCP hot-swap (/mcp revoke / reconnect) — the per-turn
  // `buildToolDefs` reads the registry live, so the next turn reflects the
  // removal without any epoch bump. The shared session registry is otherwise
  // immutable after bootstrap; treat mid-session mutation as a between-turns
  // operation (the harness loop snapshots its config at turn start).
  unregister(name: string): boolean;
  get(name: string): Tool | null;
  list(): Tool[];
  has(name: string): boolean;
}

export const createToolRegistry = (): ToolRegistry => {
  const map = new Map<string, Tool>();
  return {
    register(tool) {
      if (map.has(tool.name)) {
        throw new Error(`tool ${tool.name} already registered`);
      }
      map.set(tool.name, tool);
    },
    unregister(name) {
      return map.delete(name);
    },
    get(name) {
      return map.get(name) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
    has(name) {
      return map.has(name);
    },
  };
};
