// Single source of truth for the MCP tool-name wire prefix. Three sites key
// off the `mcp__<server>__<tool>` namespacing and must never drift:
//   - the risk scorer (`defaultIsMcpTool`) — applies the supply-chain weight,
//   - the capability resolver — gives MCP tools empty-caps/high-confidence,
//   - the MCP tool-factory — produces the names.
// A standalone leaf module (no imports) so both the permission layer and the
// higher-level src/mcp layer can depend on it without a cycle.

export const MCP_TOOL_PREFIX = 'mcp__';

export const isMcpToolName = (name: string): boolean => name.startsWith(MCP_TOOL_PREFIX);
