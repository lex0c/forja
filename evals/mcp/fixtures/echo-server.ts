// A tiny REAL MCP server (stdio) for end-to-end testing of the Forja MCP
// client stack — the SDK adapter, the manager's handshake/trust/lazy-connect,
// and the tool round-trip. Uses the low-level @modelcontextprotocol/sdk
// `Server` (the exact `tools/list` + `tools/call` + `_meta.agentic_cli` shape
// our `src/mcp/client.ts` parses), spoken over real stdio pipes.
//
// Run as `bun evals/mcp/fixtures/echo-server.ts` (the integration test +
// any future MCP eval point an mcp.toml `command` at it). It must run from the
// repo so `@modelcontextprotocol/sdk` resolves from the repo node_modules.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the given text, prefixed with "echo:".',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      // The `_meta.agentic_cli.*` hints our manifest/tool-factory consume.
      _meta: { agentic_cli: { writes: false, category: 'mcp' } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = String((req.params.arguments as Record<string, unknown> | undefined)?.text ?? '');
  return { content: [{ type: 'text', text: `echo:${text}` }] };
});

await server.connect(new StdioServerTransport());
