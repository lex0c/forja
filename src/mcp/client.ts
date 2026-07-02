// THE single @modelcontextprotocol/sdk boundary. Every other file in
// src/mcp/ depends on the `McpClient` interface (src/mcp/types.ts); only
// this module imports the SDK, so a future transport (sse/http, slice 2)
// or even a swap off the SDK is a change confined here.
//
// Server output is UNTRUSTED, so the translation from SDK shapes to
// `McpManifestTool` / `McpCallResult` is defensive: every field is
// narrowed, missing/ill-typed fields degrade to safe defaults rather than
// throwing or trusting the declared TS type.

import { chmodSync, createWriteStream, fstatSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ProviderToolInputSchema } from '../providers/types.ts';
import type {
  McpCallResult,
  McpClient,
  McpManifestTool,
  McpRemoteConfig,
  McpSandboxArg,
  McpStdioConfig,
  McpToolMeta,
  McpTransportConfig,
} from './types.ts';

// The SDK Transport type, lifted from Client.connect's first parameter so we
// don't depend on the SDK's internal module path for it.
type SdkTransport = Parameters<Client['connect']>[0];

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

// Defensive bounds on UNTRUSTED server output (a hostile/wedged server must not
// be able to OOM the process, flood the tool registry, or blow the model context
// / cost). These cap what we FORWARD, HASH, PERSIST and REGISTER — the transient
// SDK-side parse of the raw JSON-RPC frame is the SDK's own concern.
//   • A single tools/call text result (flattenContent) — 1 MiB. A legitimate
//     large result (a file dump) fits; a 500 MB payload is truncated with a marker.
export const MAX_TOOL_RESULT_CHARS = 1_048_576;
//   • One manifest's tool COUNT + per-field sizes (narrowManifestTools). A server
//     advertising 10^6 tools, or multi-MB descriptions/schemas, is bounded before
//     the manager hashes + writes manifest_json + floods the registry.
export const MAX_MCP_TOOLS = 256;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 4096;
const MAX_INPUT_SCHEMA_CHARS = 65_536;

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
// embedded-resource blocks are dropped with the text preserved). Bounded at
// MAX_TOOL_RESULT_CHARS: a hostile/wedged server returning one enormous result
// would otherwise be forwarded verbatim into the model context (and retained in
// history) — blowing memory / context / cost before the per-session token cap can
// trip on the NEXT call. Stop joining once the cap is reached and append a marker.
export const flattenContent = (content: unknown): string => {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const block of content) {
    const rec = asRecord(block);
    if (rec === null || rec.type !== 'text') continue;
    const text = asString(rec.text);
    if (text === undefined) continue;
    if (total + text.length > MAX_TOOL_RESULT_CHARS) {
      parts.push(text.slice(0, MAX_TOOL_RESULT_CHARS - total));
      truncated = true;
      break;
    }
    parts.push(text);
    total += text.length;
  }
  const out = parts.join('');
  return truncated
    ? `${out}\n…[truncated: MCP result exceeded ${MAX_TOOL_RESULT_CHARS} chars]`
    : out;
};

// Narrow + BOUND an untrusted `tools/list` payload into McpManifestTool[]. Caps
// the tool count and each field (name / description / inputSchema) so a
// pathological manifest can't OOM the hash/register step or bloat manifest_json.
// Skips a non-object entry or a nameless tool (unusable); an over-long name or
// description is truncated; an oversized inputSchema degrades to `{type:'object'}`.
export const narrowManifestTools = (rawTools: unknown): McpManifestTool[] => {
  const list = Array.isArray(rawTools) ? rawTools : [];
  const tools: McpManifestTool[] = [];
  for (const raw of list) {
    if (tools.length >= MAX_MCP_TOOLS) break; // bound a pathological tool count
    const rec = asRecord(raw);
    if (rec === null) continue;
    const name = asString(rec.name);
    if (name === undefined) continue; // a nameless tool is unusable
    tools.push({
      name: name.slice(0, MAX_TOOL_NAME_CHARS),
      description: (asString(rec.description) ?? '').slice(0, MAX_TOOL_DESCRIPTION_CHARS),
      inputSchema: boundInputSchema(rec.inputSchema),
      meta: extractMeta(rec._meta),
    });
  }
  return tools;
};

// Bound the `structuredContent` channel the same way `flattenContent` bounds the
// text: the harness JSON.stringifys the WHOLE result (structured included) for the
// model + DB, so a small text + a colossal structured blob would bypass the text
// cap and blow memory/context/cost on a single call. Arbitrary JSON can't be
// truncated without corrupting its shape, so an over-cap (or unserializable) blob
// is DROPPED with a marker folded into the text. Returns `{ structured }` to keep,
// or `{ note }` to drop. Exported for direct testing.
export const boundStructuredContent = (
  structured: unknown,
): { structured?: unknown; note?: string } => {
  let size: number;
  try {
    size = JSON.stringify(structured)?.length ?? 0;
  } catch {
    return { note: '[mcp: structured content dropped — not serializable]' };
  }
  if (size > MAX_TOOL_RESULT_CHARS) {
    return {
      note: `[mcp: structured content dropped — ${size} chars exceeded the ${MAX_TOOL_RESULT_CHARS} cap]`,
    };
  }
  return { structured };
};

// Decide how a REJECTED `client.callTool` surfaces. The SDK rejects on a JSON-RPC
// ERROR RESPONSE too (an McpError the server SENT — InvalidParams / MethodNotFound
// / a custom server code), not only on a transport fault: that means the
// connection is ALIVE and the model made a per-call mistake. Translate it to an
// isError RESULT so the model sees + fixes it (a non-retryable tool error) instead
// of the manager tearing down a healthy server and telling the model to retry.
// Return null to RE-THROW: a real transport fault / an abort (timeout or session
// cancel, surfaced as `aborted` or the SDK's ConnectionClosed/RequestTimeout
// codes) must reach the manager so it disconnects or applies its §15.3 timeout
// handling. Exported for direct testing (the live callTool needs a real SDK Client).
export const callErrorToResult = (err: unknown, aborted: boolean): McpCallResult | null => {
  if (aborted) return null;
  if (
    err instanceof McpError &&
    err.code !== ErrorCode.ConnectionClosed &&
    err.code !== ErrorCode.RequestTimeout
  ) {
    return { isError: true, content: `mcp error ${err.code}: ${err.message}` };
  }
  return null;
};

// normalizeInputSchema, then reject an oversized schema (a multi-MB blob a server
// could use to bloat the manifest hash + persisted manifest_json) by degrading to
// the empty object schema.
const boundInputSchema = (raw: unknown): ProviderToolInputSchema => {
  const schema = normalizeInputSchema(raw);
  try {
    if (JSON.stringify(schema).length > MAX_INPUT_SCHEMA_CHARS) return { type: 'object' };
  } catch {
    return { type: 'object' };
  }
  return schema;
};

// Flag a CLEAR protocol violation in the raw `tools/call` result (MCP.md §15.5),
// which the manager turns into an `active`→`degraded`→recover loop. Deliberately
// conservative — a non-array `content` (the MCP spec requires an array), a block
// that is not an object (a bare `null`/primitive is malformed), or a text block
// whose `text` is non-string. An empty array or all-image content is NOT flagged:
// those can be legitimate (a void action, an image-only tool), and degrading a
// healthy server on a false positive is worse than missing one. An explicit
// `isError` result is a valid error, not malformed.
export const isInvalidOutput = (rawContent: unknown, isError: boolean): boolean => {
  if (isError) return false;
  if (!Array.isArray(rawContent)) return true;
  for (const block of rawContent) {
    const rec = asRecord(block);
    if (rec === null) return true; // a content block must be an object
    if (rec.type === 'text' && typeof rec.text !== 'string') return true;
  }
  return false;
};

// MCP.md §2.1: the server's stderr is rotated at 10 MB.
const STDERR_LOG_CAP_BYTES = 10 * 1024 * 1024;

// Drain the server's piped stderr and tee it to `logPath`. Draining is
// MANDATORY even without a path: an unread `stderr: 'pipe'` fills (OS pipe +
// the SDK's in-memory PassThrough) and the child then BLOCKS on its next stderr
// write — the `data` listener is what keeps it moving. The file is opened
// lazily on the first byte (a silent server leaves no empty artifact), in
// APPEND mode (a reconnect must NOT truncate the prior session's crash output)
// with mode 0600 set AT CREATE — stderr can carry secret-shaped payloads
// (panics dumping env, a tool echoing a Bearer token), and creating 0600
// avoids the world-readable window a chmod-after-lazy-create would leave.
// Best-effort throughout: a mkdir/open/write failure drops the sink but keeps
// draining so the child never blocks. Keeps one rotation generation (`<log>.1`)
// at 10 MB. Parallels `subagents/spawn-factory.ts#drainStderrToLogFile`, but
// that consumes a Web ReadableStream (Bun.spawn); the SDK transport hands us a
// Node `Readable` (node:child_process), a different stream surface.
//
// Returns a promise that resolves once the stream ends and the final flush
// completes — `connect()` fire-and-forgets it; tests await it. Exported for
// direct testing without a real subprocess (push bytes into a Node Readable,
// end it, await, assert the file).
export const teeStderr = (stderr: Readable, logPath: string | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    let sink: { write: (c: Uint8Array) => void; end: () => Promise<void> } | undefined;
    let opened = false;
    let bytes = 0;
    let done = false;
    const open = (): void => {
      if (logPath === undefined) return;
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        try {
          chmodSync(dirname(logPath), 0o700);
        } catch {
          // Best-effort dir lockdown (the load-bearing barrier).
        }
        // openSync (NOT createWriteStream's async open) so the file exists
        // SYNCHRONOUSLY — the rotation's renameSync below needs it present, and
        // 'a'+0o600 gives append (no truncate on reconnect) + operator-only-at-
        // create (no world-readable chmod race) in one syscall. The stream wraps
        // that fd for non-blocking, fd-prompt writes (so `/mcp logs` on a live
        // server sees the latest lines) and closes it on end.
        const fd = openSync(logPath, 'a', 0o600);
        // 'a' (append) keeps a prior session's bytes, so SEED the rotation counter
        // from the file's current size — via the fd (no TOCTOU vs the open) — so
        // the cap counts the WHOLE file, not just this drain. Otherwise an existing
        // mcp-<name>.log + repeated reconnects each append ~another cap and the file
        // grows well past STDERR_LOG_CAP_BYTES. (If a prior rotation's rename failed
        // the file is still full, so this seeds near the cap and re-rotates.)
        try {
          bytes = fstatSync(fd).size;
        } catch {
          bytes = 0;
        }
        const stream = createWriteStream(logPath, { fd, autoClose: true });
        stream.on('error', () => {
          sink = undefined; // EACCES / disk full → drain-to-discard from here.
        });
        sink = {
          write: (c) => {
            stream.write(c);
          },
          end: () => new Promise<void>((res) => stream.end(res)),
        };
      } catch {
        sink = undefined; // synchronous open failure — drain-to-discard.
      }
    };
    stderr.on('data', (chunk: Buffer) => {
      if (!opened) {
        opened = true;
        open();
      }
      if (sink === undefined || logPath === undefined) return;
      if (bytes + chunk.length > STDERR_LOG_CAP_BYTES) {
        // Rotate: close, keep one generation, reopen fresh. The old stream's fd
        // keeps writing into the renamed `.1` inode (Unix), so in-flight bytes
        // aren't lost; the reopen appends to a fresh `<log>`.
        try {
          void sink.end();
          renameSync(logPath, `${logPath}.1`);
        } catch {
          // Best-effort rotation.
        }
        // open() reseeds `bytes` from the reopened file (0 after a clean rename;
        // the still-full size if the rename failed → it re-rotates next chunk).
        open();
        if (sink === undefined) return;
      }
      try {
        sink.write(chunk);
        bytes += chunk.length;
      } catch {
        sink = undefined; // mid-run write failure — keep draining to discard.
      }
    });
    // end/error/close can all fire; flush + resolve exactly once.
    const finish = (): void => {
      if (done) return;
      done = true;
      void (async () => {
        try {
          await sink?.end();
        } catch {
          // Best-effort flush.
        }
        resolve();
      })();
    };
    stderr.on('end', finish);
    stderr.on('error', finish);
    stderr.on('close', finish);
  });

// The error to surface when the handshake signal fires — a timeout signal from
// `AbortSignal.timeout` carries a `TimeoutError` reason (a readable "operation
// timed out"); a user/budget abort may carry none.
const connectAbortError = (signal: AbortSignal): Error => {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error('mcp connect aborted');
};

// Enforce the handshake signal around the WHOLE connect, not just `initialize`.
// `Client.connect` awaits `transport.start()` (for SSE: the stream open, which
// blocks until the server sends its `endpoint` event and can hang forever if it
// never does) BEFORE it applies `RequestOptions.signal` to the initialize
// request — so the signal passed to `connect` alone does NOT bound `start()`.
// Race the connect against the signal so the advertised timeout + user abort
// actually fire; the caller closes the client on throw, which tears down the
// transport (aborting a hung SSE stream). The signal is still passed through so
// the SDK also aborts the initialize request itself once start() has resolved.
export const abortableConnect = async (
  c: Client,
  transport: SdkTransport,
  signal?: AbortSignal,
): Promise<void> => {
  const connecting = c.connect(transport, signal ? { signal } : undefined);
  if (signal === undefined) {
    await connecting;
    return;
  }
  // A late settle (after we've already lost the race to the abort) must not
  // surface as an unhandled rejection.
  connecting.catch(() => {});
  if (signal.aborted) throw connectAbortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(connectAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    connecting.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
};

// Shared adapter over the SDK `Client`. The TRANSPORT is built by `makeTransport`
// (stdio spawns the child + tees its stderr; remote opens the HTTP/SSE
// connection); everything below — the handshake wrapper, listTools/callTool with
// defensive narrowing, close — is identical across transports.
const sdkClientFrom = (makeTransport: () => SdkTransport): McpClient => {
  let client: Client | null = null;

  return {
    async connect(signal) {
      const transport = makeTransport();
      const c = new Client(CLIENT_INFO, { capabilities: {} });
      try {
        // Bound the ENTIRE handshake (transport start + initialize) by the signal
        // — a hung SSE stream open would otherwise slip past the timeout/abort.
        await abortableConnect(c, transport, signal);
      } catch (err) {
        // Close on failure so a spawned child / open socket is reaped when the
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
      return {
        protocolVersion,
        // The server's self-reported identity from `initialize.serverInfo` — both
        // feed the manifest hash (spec §3.2), so a re-branded server re-trusts.
        serverName: asString(info?.name) ?? null,
        serverVersion: asString(info?.version) ?? null,
      };
    },

    async listTools(signal) {
      if (client === null) throw new Error('mcp client: listTools called before connect');
      const res = await client.listTools(undefined, signal ? { signal } : undefined);
      return narrowManifestTools(res.tools);
    },

    async callTool(tool, args, signal) {
      if (client === null) throw new Error('mcp client: callTool called before connect');
      const argRecord = asRecord(args) ?? {};
      let res: Awaited<ReturnType<Client['callTool']>>;
      try {
        res = await client.callTool(
          { name: tool, arguments: argRecord },
          undefined,
          signal ? { signal } : undefined,
        );
      } catch (err) {
        // A server-reported JSON-RPC error means the connection is alive — return
        // it as an isError result; a transport fault / abort re-throws so the
        // manager disconnects or applies its timeout handling.
        const translated = callErrorToResult(err, signal?.aborted ?? false);
        if (translated !== null) return translated;
        throw err;
      }
      const result: McpCallResult = {
        isError: res.isError === true,
        content: flattenContent(res.content),
      };
      if (res.structuredContent !== undefined) {
        const bounded = boundStructuredContent(res.structuredContent);
        if (bounded.note !== undefined) {
          result.content = result.content ? `${result.content}\n${bounded.note}` : bounded.note;
        } else {
          result.structured = bounded.structured;
        }
      }
      if (isInvalidOutput(res.content, res.isError === true)) {
        result.invalid = true;
        // Preserve the malformed raw (flattenContent above already discarded its
        // structure) for the §15.5 audit + the model's error.
        try {
          result.invalidRaw = JSON.stringify(res.content)?.slice(0, 1024);
        } catch {
          result.invalidRaw = String(res.content).slice(0, 1024);
        }
      }
      return result;
    },

    async close() {
      const c = client;
      client = null;
      if (c !== null) await c.close();
    },
  };
};

export const createStdioMcpClient = (
  cfg: McpStdioConfig,
  sandbox?: McpSandboxArg,
  stderrLogPath?: string,
): McpClient =>
  sdkClientFrom(() => {
    // When sandboxed (MCP.md §2.3), wrap the server's argv in bwrap /
    // sandbox-exec. The wrap returns the inner argv unchanged on host /
    // graceful-degrade and THROWS on fail-closed (tool present at boot, gone
    // now) — the throw propagates out of connect() to the manager.
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
      // Capture the server's stderr instead of letting it bleed into the agent's
      // stderr (NDJSON in --json mode); tee'd to mcp-<name>.log.
      stderr: 'pipe',
    });
    // Attach the stderr drain BEFORE connecting. The SDK exposes the PassThrough
    // at construction (the child is spawned inside c.connect → transport.start),
    // so this (a) captures the stderr of a server that DIES during `initialize`
    // (the crash reason `/mcp logs` exists to surface), and (b) keeps the pipe
    // drained through the handshake so a chatty server can't deadlock mid-connect.
    const errStream = (transport as { stderr?: Readable | null }).stderr;
    if (errStream != null) void teeStderr(errStream, stderrLogPath);
    return transport;
  });

// A REMOTE server (no subprocess, no sandbox, no stderr — MCP.md §2.2). The
// env-resolved bearer header (if any) rides EVERY request via `requestInit`,
// including the initial SSE stream open: in @modelcontextprotocol/sdk 1.29.0 the
// SSE transport's `_commonHeaders()` merges `requestInit.headers` and applies
// them to both the stream-opening request (via the EventSource `fetch` wrapper in
// `_startOrAuth`) AND the recurring POSTs — so a separate `eventSourceInit.fetch`
// would be redundant here. (Re-verify this if the SDK is upgraded: older SSE
// transports only honored `eventSourceInit` for the stream, which would drop the
// header from connect().) OAuth (`authProvider`) is a later slice. 'http' =
// streamable-HTTP, 'sse' = legacy SSE.
export const createRemoteMcpClient = (cfg: McpRemoteConfig): McpClient =>
  sdkClientFrom(() => {
    const url = new URL(cfg.url);
    const opts =
      cfg.authHeader !== undefined
        ? { requestInit: { headers: { Authorization: cfg.authHeader } } }
        : undefined;
    const transport =
      cfg.transport === 'sse'
        ? new SSEClientTransport(url, opts)
        : new StreamableHTTPClientTransport(url, opts);
    // The SDK's remote transports type `sessionId` as `string | undefined`,
    // which trips exactOptionalPropertyTypes against the Transport interface's
    // `sessionId?: string`. They are the SDK's own transports + work with
    // c.connect at runtime, so the variance is a bundled-types nit.
    return transport as SdkTransport;
  });

// Dispatch on the transport kind — the single factory the manager calls. stdio
// threads the sandbox + stderr-log path; remote ignores them.
export const createMcpClient = (
  cfg: McpTransportConfig,
  sandbox?: McpSandboxArg,
  stderrLogPath?: string,
): McpClient =>
  cfg.transport === 'stdio'
    ? createStdioMcpClient(cfg, sandbox, stderrLogPath)
    : createRemoteMcpClient(cfg);
