// Manifest tool → Forja `Tool`. The factory is decoupled from the manager:
// it takes a bound `call(args, ctx)` closure, so it neither imports the
// manager nor the SDK. The manager computes collision-free wire names (via
// `mcpWireName` + its own dedup) and supplies the final `name`.
//
// Wire-name sanitization is correctness-critical (untrusted, server-supplied
// tool names): a name like `foo.bar` or a 60-char name would be rejected by
// the Anthropic/OpenAI tool-name charset (`^[a-zA-Z0-9_-]{1,64}$`) or throw
// on `registry.register`. We sanitize + length-bound here; the manager
// resolves any residual collision by suffixing.

import { MCP_TOOL_PREFIX } from '../permissions/mcp-naming.ts';
import { type Tool, type ToolContext, type ToolMetadata, toolError } from '../tools/types.ts';
import { McpCallError, type McpCallResult, type McpManifestTool } from './types.ts';

const WIRE_MAX = 64; // Anthropic/OpenAI tool-name length cap.
const PREFIX = MCP_TOOL_PREFIX;
const SEP = '__';

// Replace any char outside the wire charset with '_'. (This is NOT permission
// matching — it's display/identifier shaping — so a regex is appropriate; the
// "glob + prefix only" rule governs policy matchers, not name sanitization.)
export const sanitizeMcpName = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'tool';
};

// `mcp__<server>__<tool>`, bounded to WIRE_MAX. When server + prefix already
// eat the budget, the tool half is truncated (residual collisions are the
// manager's dedup problem).
export const mcpWireName = (server: string, toolName: string): string => {
  const head = `${PREFIX}${sanitizeMcpName(server)}${SEP}`;
  const budget = Math.max(1, WIRE_MAX - head.length);
  return `${head}${sanitizeMcpName(toolName).slice(0, budget)}`;
};

export interface BuildMcpToolInput {
  // Final, collision-resolved wire name (from the manager).
  name: string;
  // The configured server name (for audit/error detail; NOT the wire name).
  server: string;
  tool: McpManifestTool;
  // Whether the server's tools default to the base surface or behind
  // tool_search. Overridden per-tool by `tool.meta.deferred`.
  serverSurface: 'base' | 'deferred';
  // Bound call into the manager for THIS server + tool. Does lazy-connect +
  // state transitions; throws on transport/protocol fault.
  call: (args: unknown, ctx: ToolContext) => Promise<McpCallResult>;
  // The operator granted this server network (MCP.md §2.3) → its tools take the
  // egress category (default confirm, never auto-approved under autonomous).
  egress?: boolean;
}

const buildMetadata = (input: BuildMcpToolInput): ToolMetadata => {
  const meta = input.tool.meta;
  // `writes` defaults to true (pessimistic) so the harness checkpoints before
  // the call unless the server provably declared read-only — MCP.md §3.1.
  const writes = meta.writes ?? true;
  return {
    category: input.egress ? 'mcp.egress' : 'mcp',
    writes,
    // A network-granted server's tools ARE egress; a plain stdio server is local
    // (honor the self-declared hint, default false).
    network: input.egress === true || (meta.network ?? false),
    // An MCP server can write to its own FS outside the agent worktree, so a
    // write tool's effects are NOT captured by the checkpoint → --undo warns.
    escapesCwd: writes,
    // Slice 1 never parallelizes MCP calls (the server may be non-reentrant;
    // it must declare parallel_safe AND we'd need per-server concurrency
    // accounting, which lands later).
    parallel_safe: false,
    idempotent: meta.idempotent ?? false,
    deferred: meta.deferred ?? input.serverSurface === 'deferred',
  };
};

export const buildMcpTool = (input: BuildMcpToolInput): Tool => {
  const detail = { server: input.server, tool: input.tool.name };
  return {
    name: input.name,
    description: input.tool.description,
    inputSchema: input.tool.inputSchema,
    metadata: buildMetadata(input),
    async execute(args, ctx) {
      try {
        const res = await input.call(args, ctx);
        if (res.isError) {
          // A server-reported error defaults to non-retryable; the manager marks
          // `retryable` on the recoverable output-invalid degrade so the flag
          // matches the "retry or fall back" advice in the text.
          return toolError('mcp.tool_error', res.content || 'MCP tool reported an error', {
            retryable: res.retryable ?? false,
            details: detail,
          });
        }
        return res.structured !== undefined
          ? { content: res.content, structured: res.structured }
          : { content: res.content };
      } catch (err) {
        // A framed manager failure carries its own code + retryability — a pinned
        // drift, an exhausted budget, or a terminal state is retryable:false
        // (retrying throws identically until /mcp reconnect), a timeout is true.
        // Passing that flag through stops the model from burning turns re-calling
        // a permanently-failing tool.
        if (err instanceof McpCallError) {
          return toolError(err.code, err.message, { retryable: err.retryable, details: detail });
        }
        // An UNFRAMED throw is a raw transport/protocol fault — the manager has
        // already disconnected the server; frame it as a retryable
        // server-unreachable so the model can distinguish a dead connection from
        // a bad-argument tool error and back off / retry rather than tweak args.
        const cause = err instanceof Error ? err.message : String(err);
        return toolError(
          'mcp.server_unreachable',
          `MCP server '${input.server}' is unreachable: ${cause}`,
          {
            retryable: true,
            details: detail,
          },
        );
      }
    },
  };
};
