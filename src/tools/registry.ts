import type { Tool } from './types.ts';

export interface ToolRegistry {
  register(tool: Tool): void;
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
