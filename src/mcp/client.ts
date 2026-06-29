// THE single @modelcontextprotocol/sdk boundary. Every other file in
// src/mcp/ depends on the `McpClient` interface (src/mcp/types.ts); only
// this module imports the SDK, so a future transport (sse/http, slice 2)
// or even a swap off the SDK is a change confined here.
//
// Server output is UNTRUSTED, so the translation from SDK shapes to
// `McpManifestTool` / `McpCallResult` is defensive: every field is
// narrowed, missing/ill-typed fields degrade to safe defaults rather than
// throwing or trusting the declared TS type.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ProviderToolInputSchema } from '../providers/types.ts';
import type {
  McpCallResult,
  McpClient,
  McpManifestTool,
  McpSandboxArg,
  McpStdioConfig,
  McpToolMeta,
} from './types.ts';

// Sent to the server in `initialize`. Cosmetic (the server logs it); not
// load-bearing.
const CLIENT_INFO = { name: 'forja', version: '0.1.0' } as const;

// Used when the SDK doesn't surface the negotiated protocol version on the
// transport (it is metadata only — the trust hash never covers it).
const FALLBACK_PROTOCOL_VERSION = '2025-03-26';

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

// Minimal spawn env (MCP.md §2.1): PATH/HOME/USER plus the server's own
// declared `env` (from its mcp.toml entry, $VAR-resolved). The server does NOT
// inherit the agent's environment — no API keys / session secrets leak in.
//
// We deliberately do NOT blanket-forward `MCP_*` vars: that would hand one
// server's `MCP_<X>_TOKEN` to EVERY other (untrusted) server. A server gets
// only the base + exactly what its own entry declares — the same
// explicitly-shaped-env discipline every other Forja spawn site follows
// (src/sanitize/env.ts).
export const buildSpawnEnv = (
  declared: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER']) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  if (declared !== undefined) {
    for (const [k, v] of Object.entries(declared)) out[k] = v;
  }
  return out;
};

// Coerce a server-declared inputSchema into the `{ type:'object', ... }`
// shape the rest of the stack (and every provider's tool wire format)
// requires. A server that omits or mis-shapes it gets an empty object
// schema rather than breaking tool registration.
export const normalizeInputSchema = (raw: unknown): ProviderToolInputSchema => {
  const rec = asRecord(raw);
  if (rec !== null && rec.type === 'object') return rec as ProviderToolInputSchema;
  return { type: 'object' };
};

// Pull the `_meta.agentic_cli.*` hints, narrowing each field. Anything
// missing/ill-typed is simply absent (the factory then applies its
// conservative defaults).
export const extractMeta = (rawMeta: unknown): McpToolMeta => {
  const meta = asRecord(rawMeta);
  const ns = meta === null ? null : asRecord(meta.agentic_cli);
  if (ns === null) return {};
  const out: McpToolMeta = {};
  const category = asString(ns.category);
  if (category !== undefined) out.category = category;
  const writes = asBool(ns.writes);
  if (writes !== undefined) out.writes = writes;
  const network = asBool(ns.network);
  if (network !== undefined) out.network = network;
  const parallelSafe = asBool(ns.parallel_safe);
  if (parallelSafe !== undefined) out.parallel_safe = parallelSafe;
  const deferred = asBool(ns.deferred);
  if (deferred !== undefined) out.deferred = deferred;
  const idempotent = asBool(ns.idempotent);
  if (idempotent !== undefined) out.idempotent = idempotent;
  return out;
};

// Flatten the content block array to text (slice 1 is text-only; image /
// embedded-resource blocks are dropped with the text preserved).
export const flattenContent = (content: unknown): string => {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec !== null && rec.type === 'text') {
      const text = asString(rec.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join('');
};

export const createStdioMcpClient = (cfg: McpStdioConfig, sandbox?: McpSandboxArg): McpClient => {
  let client: Client | null = null;

  return {
    async connect(signal) {
      // When sandboxed (MCP.md §2.3), wrap the server's argv in bwrap /
      // sandbox-exec. The wrap returns the inner argv unchanged on host /
      // graceful-degrade and THROWS on fail-closed (tool present at boot, gone
      // now). Done here, inside connect(), so the throw lands in the manager's
      // connect try (→ error state / reaped child) rather than crashing boot.
      const inner = [cfg.command, ...(cfg.args ?? [])];
      const spawnArgv =
        sandbox !== undefined && sandbox.profile !== 'host'
          ? sandbox.wrap({
              profile: sandbox.profile,
              cwd: cfg.cwd ?? process.cwd(),
              innerArgv: inner,
              env: process.env,
              // The server's declared env survives the sandbox's --clearenv.
              ...(cfg.env !== undefined ? { passthroughEnv: { ...cfg.env } } : {}),
            })
          : inner;
      const [spawnCommand = cfg.command, ...spawnArgs] = spawnArgv;
      const transport = new StdioClientTransport({
        command: spawnCommand,
        args: spawnArgs,
        env: buildSpawnEnv(cfg.env),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
        // Capture the server's stderr instead of letting it bleed into the
        // agent's stderr (which is NDJSON in --json mode). The manager can
        // later tee it to traces/mcp-<name>.log.
        stderr: 'pipe',
      });
      const c = new Client(CLIENT_INFO, { capabilities: {} });
      try {
        // Wire the abort signal so a hung `initialize` (slow / malicious
        // server) unwinds on user-cancel or a hard budget abort.
        await c.connect(transport, signal ? { signal } : undefined);
      } catch (err) {
        // Close on failure so the spawned child process is reaped when the
        // handshake throws (timeout / protocol error / abort) — otherwise the
        // adapter's `client` stays null and `close()` would no-op, leaking it.
        await c.close().catch(() => {});
        throw err;
      }
      client = c;
      const info = c.getServerVersion();
      const protocolVersion =
        asString((transport as { protocolVersion?: unknown }).protocolVersion) ??
        FALLBACK_PROTOCOL_VERSION;
      return { protocolVersion, serverVersion: asString(info?.version) ?? null };
    },

    async listTools(signal) {
      if (client === null) throw new Error('mcp client: listTools called before connect');
      const res = await client.listTools(undefined, signal ? { signal } : undefined);
      const tools: McpManifestTool[] = [];
      for (const raw of res.tools ?? []) {
        const rec = raw as unknown as Record<string, unknown>;
        const name = asString(rec.name);
        if (name === undefined) continue; // a nameless tool is unusable
        tools.push({
          name,
          description: asString(rec.description) ?? '',
          inputSchema: normalizeInputSchema(rec.inputSchema),
          meta: extractMeta(rec._meta),
        });
      }
      return tools;
    },

    async callTool(tool, args, signal) {
      if (client === null) throw new Error('mcp client: callTool called before connect');
      const argRecord = asRecord(args) ?? {};
      const res = await client.callTool(
        { name: tool, arguments: argRecord },
        undefined,
        signal ? { signal } : undefined,
      );
      const result: McpCallResult = {
        isError: res.isError === true,
        content: flattenContent(res.content),
      };
      if (res.structuredContent !== undefined) result.structured = res.structuredContent;
      return result;
    },

    async close() {
      const c = client;
      client = null;
      if (c !== null) await c.close();
    },
  };
};
