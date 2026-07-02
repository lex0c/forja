// End-to-end integration of the REMOTE MCP client (streamable-HTTP) against a
// REAL SDK server over a real localhost HTTP socket — the counterpart to
// real-subprocess.test.ts (stdio). Proves the remote transport connects,
// lists + calls a tool over the wire, that the env-bearer Authorization header
// actually reaches the server (the unit tests only use a fake client), and that
// Forja's LAZY reconnect (connect+list+close, then a fresh connect+call) works
// against a real MULTI-SESSION server — the reconnect stdio gets for free (a new
// subprocess) but the remote transport must survive as a second HTTP session.

import { afterEach, describe, expect, test } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteMcpClient } from '../../src/mcp/client.ts';
import type { McpRemoteConfig } from '../../src/mcp/types.ts';

const BEARER = 'Bearer test-secret-token';

interface Fixture {
  url: string;
  sawAuth: () => boolean;
  // How many distinct sessions the server has established (one per `initialize`).
  // Forja reconnects lazily, so a second tool call = a second session.
  sessions: () => number;
  stop: () => void;
}

// A fresh SDK `Server` (handlers rebound) — the multi-session server builds one
// per session, so each transport owns its own server instance.
const makeServer = (): Server => {
  const server = new Server(
    { name: 'remote-fixture', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
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
        _meta: { agentic_cli: { writes: false, category: 'mcp' } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const text = String((req.params.arguments as Record<string, unknown> | undefined)?.text ?? '');
    return { content: [{ type: 'text', text: `echo:${text}` }] };
  });
  return server;
};

// Spin up a real streamable-HTTP MCP server (SDK server transport over Bun.serve)
// serving an `echo` tool; when `requireAuth`, it 401s a request whose Authorization
// header isn't the expected bearer. MULTI-SESSION: one transport per session,
// created on `initialize` (no session id) and routed to thereafter by the
// `mcp-session-id` header — the shape a real MCP server has, and what lets Forja's
// lazy reconnect open a SECOND session instead of hitting "Server already
// initialized" (which a single shared transport would raise on the 2nd initialize).
const startServer = async (requireAuth: boolean): Promise<Fixture> => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let sessionsCreated = 0;
  let sawAuth = false;
  const s = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const auth = req.headers.get('authorization');
      if (auth === BEARER) sawAuth = true;
      if (requireAuth && auth !== BEARER) {
        return new Response('unauthorized', { status: 401 });
      }
      const sid = req.headers.get('mcp-session-id');
      let transport = sid ? transports.get(sid) : undefined;
      if (transport === undefined) {
        // A new session (an `initialize` with no session id). Stateful,
        // JSON-response mode: the transport generates a session id the SDK client
        // then carries on every subsequent request.
        sessionsCreated += 1;
        // Annotated so `t` isn't self-referentially inferred from the callback.
        const t: WebStandardStreamableHTTPServerTransport =
          new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id: string) => {
              transports.set(id, t);
            },
          });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
        };
        await makeServer().connect(t);
        transport = t;
      }
      return transport.handleRequest(req);
    },
  });
  return {
    url: `http://127.0.0.1:${s.port}/mcp`,
    sawAuth: () => sawAuth,
    sessions: () => sessionsCreated,
    stop: () => s.stop(true),
  };
};

const remoteCfg = (over: Partial<McpRemoteConfig>): McpRemoteConfig => ({
  transport: 'http',
  url: '',
  rawUrl: '$MCP_URL',
  ...over,
});

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.stop();
  fixture = undefined;
});

describe('mcp remote real-server integration (streamable-HTTP)', () => {
  test('connects, lists + calls a tool with the bearer reaching the server', async () => {
    fixture = await startServer(true);
    const client = createRemoteMcpClient(remoteCfg({ url: fixture.url, authHeader: BEARER }));
    try {
      const info = await client.connect();
      expect(info.serverName).toBe('remote-fixture');

      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('echo');
      expect(tools.find((t) => t.name === 'echo')?.meta.writes).toBe(false); // _meta parsed

      const res = await client.callTool('echo', { text: 'HELLO' });
      expect(res.isError).toBe(false);
      expect(res.content).toBe('echo:HELLO'); // round-tripped over real HTTP

      expect(fixture.sawAuth()).toBe(true); // the env-bearer Authorization reached the server
    } finally {
      await client.close();
    }
  });

  test('a missing bearer is rejected (401) → connect throws', async () => {
    fixture = await startServer(true);
    const client = createRemoteMcpClient(remoteCfg({ url: fixture.url })); // no authHeader
    await expect(client.connect()).rejects.toThrow();
    await client.close().catch(() => {});
  });

  test('survives the LAZY reconnect: connect+list+close, then a fresh connect+call', async () => {
    // Forja connects lazily — init connects + lists + CLOSES, and the first
    // tools/call RECONNECTS with a fresh client. Each connect is a new session (a
    // new `initialize`), so the client re-hits the handshake against a second HTTP
    // session. This is the exact flow stdio gets for free (a fresh subprocess) but
    // the remote transport must handle over one long-lived server — a single-session
    // server would reject the 2nd initialize ("Server already initialized").
    fixture = await startServer(false);

    // Phase 1 — the init handshake: connect + list, then close (drop the socket).
    const c1 = createRemoteMcpClient(remoteCfg({ url: fixture.url }));
    const info = await c1.connect();
    expect(info.serverName).toBe('remote-fixture');
    expect((await c1.listTools()).map((t) => t.name)).toContain('echo');
    await c1.close();

    // Phase 2 — the lazy reconnect for the tool call: a fresh client + session.
    const c2 = createRemoteMcpClient(remoteCfg({ url: fixture.url }));
    await c2.connect();
    const res = await c2.callTool('echo', { text: 'oi' });
    await c2.close();
    expect(res.isError).toBe(false);
    expect(res.content).toBe('echo:oi'); // the reconnected call round-trips

    expect(fixture.sessions()).toBe(2); // two DISTINCT sessions — the reconnect re-initialized
  });
});
