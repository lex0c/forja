#!/usr/bin/env bun
// Worker entry point — PERMISSION_ENGINE.md §13.7. Spawned by
// `createSpawnBroker` (slice 79) on each `execute` call. Reads
// one BrokerRequest from stdin, dispatches to the registered
// handler, writes one BrokerResponse to stdout, exits.
//
// Two invocation paths produce the same behavior:
//
//   1. Source checkout: `bun run src/broker/worker.ts` — Bun
//      executes this file as the entry script (`import.meta.main`
//      is true) and the bottom-of-file block awaits
//      `runWorkerProcess()` directly.
//
//   2. Compiled binary self-exec: the main entry
//      (`src/cli/index.ts`) detects the `FORJA_BROKER_WORKER=1`
//      env flag and `await import`s this module + calls the
//      exported `runWorkerProcess()`. `import.meta.main` is
//      FALSE on this path (index.ts is the entry), so the
//      bottom-of-file block stays inert and the entry-point
//      caller drives the lifecycle. This is the path that
//      restores sandbox enforcement to compiled-binary installs:
//      `bun build --compile` rewrites `import.meta.dir` to the
//      embedded `/$bunfs/...` root which `bun run` can't address,
//      but self-exec via `process.execPath` invokes the same
//      compiled binary which already carries this module
//      embedded via the normal import graph from index.ts.
//
// Production wiring (slice 81+) registers concrete handlers
// here: bash family, read_file, glob, grep, etc. Slice 80 shipped
// only the `__echo__` diagnostic handler so the entry script was
// useful from the moment it landed — operators validated the
// broker → worker pipeline end-to-end before any real tool handler
// was wired:
//
//   echo '{"toolName":"__echo__","args":{"k":"v"},"capabilities":[],"sandboxProfile":null}' \
//     | bun run src/broker/worker.ts
//
// `runWorkerProcess` returns when stdin closes (broker writes the
// request line then calls stdin.end()): the input drain returns,
// `runWorker` emits the response, the promise resolves, Bun exits
// naturally (no explicit `process.exit` needed; the absence
// preserves any flush-on-exit behavior in the stdout pipe).

import { scrubEnv } from '../sanitize/index.ts';
import { createBashHandler } from './handlers/bash.ts';
import type { BrokerRequest, BrokerResponse } from './types.ts';
import { runWorker, type WorkerToolHandler } from './worker-runtime.ts';

const echoHandler: WorkerToolHandler = {
  name: '__echo__',
  execute: async (request: BrokerRequest): Promise<BrokerResponse> => ({
    ok: true,
    stdout: JSON.stringify({
      toolName: request.toolName,
      args: request.args,
      capabilities: request.capabilities,
      sandboxProfile: request.sandboxProfile,
    }),
    stderr: '',
    exitCode: 0,
  }),
};

const bashHandler = createBashHandler({ scrubEnv });

// Stdin byte ceiling (slice 102, R6 #22). The worker receives ONE
// NDJSON line — typical request payloads are well under 1 MiB
// even for large tool argument bags. A hostile or buggy caller
// (manual `echo ... | bun worker.ts` invocations) could feed
// gigabytes and OOM the worker before the handler ever runs.
// 16 MiB matches the broker's stdout cap (drainBounded in
// spawn.ts) — symmetric upper bound on the request/response
// envelope. The handler-side caps (bash `maxOutputBytes`, etc.)
// remain the inner enforcement layer; this is the outer barrier
// that protects the worker process itself.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const readStdin = async (): Promise<string> => {
  let total = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    if (total + chunk.byteLength > MAX_REQUEST_BYTES) {
      // Truncate to the cap, then break. The handler will see
      // a malformed (likely incomplete) JSON line and fail with
      // the canonical "invalid request" envelope; the broker's
      // response parser surfaces that as a worker crash with
      // the truncated bytes available for triage.
      const remaining = MAX_REQUEST_BYTES - total;
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
      }
      throw new Error(`worker: stdin exceeded ${MAX_REQUEST_BYTES} bytes (request truncated)`);
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
};

// Drives one request/response cycle: wires SIGTERM into an
// AbortController, reads stdin, dispatches to a registered handler,
// writes the response. Exported so the compiled-binary self-exec
// path (`src/cli/index.ts` detects `FORJA_BROKER_WORKER=1`) can
// invoke it without going through `bun run` — and the source-checkout
// path can still call `bun run src/broker/worker.ts` via the
// `import.meta.main` block below.
//
// SIGTERM propagation (slice 83): the spawn broker sends SIGTERM on
// caller-abort; we catch it here, abort the JS-level signal, and
// runWorker passes that into the handler. Without this catch the OS
// would terminate the worker mid-handler, the bash subprocess would
// orphan, and the broker would see "worker produced no response"
// instead of the canonical aborted shape.
//
// `process.once` (was `process.on`) — slice 113 (R6 P1). The worker
// handles exactly ONE request and exits; the SIGTERM listener only
// ever needs to fire once. Using `on` accumulated a listener each
// time runWorker re-entered (in test fixtures that import this
// module to extract handlers and re-run inline) and Bun surfaced
// `MaxListenersExceededWarning` at 11. `once` auto-removes after
// first fire and prevents the warning.
export const runWorkerProcess = async (): Promise<void> => {
  const ac = new AbortController();
  process.once('SIGTERM', () => ac.abort());
  await runWorker({
    handlers: [echoHandler, bashHandler],
    input: readStdin,
    output: (line) => {
      process.stdout.write(line);
    },
    signal: ac.signal,
  });
};

// Top-level execution when this file is the entry script
// (`bun run src/broker/worker.ts`). `import.meta.main` is false
// when the module is loaded via `await import(...)` from another
// entry — including the compiled-binary self-exec path — so the
// caller drives the lifecycle and this block stays inert.
if (import.meta.main) {
  await runWorkerProcess();
}
