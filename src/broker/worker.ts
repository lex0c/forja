#!/usr/bin/env bun
// Worker entry point — PERMISSION_ENGINE.md §13.7. Spawned by
// `createSpawnBroker` (slice 79) on each `execute` call. Reads
// one BrokerRequest from stdin, dispatches to the registered
// handler, writes one BrokerResponse to stdout, exits.
//
// Production wiring (future slice 81+) registers concrete handlers
// here: bash family, read_file, glob, grep, etc. Slice 80 ships
// only the `__echo__` diagnostic handler so the entry script is
// genuinely useful from the moment it lands — operators can validate
// the broker → worker pipeline end-to-end before any real tool
// handler is wired:
//
//   echo '{"toolName":"__echo__","args":{"k":"v"},"capabilities":[],"sandboxProfile":null}' \
//     | bun run src/broker/worker.ts
//
// The script awaits `runWorker(...)` at top level. When stdin
// closes (broker writes the request line then calls stdin.end()),
// the input drain returns + runWorker emits the response + the
// awaited promise resolves + Bun exits naturally (no explicit
// `process.exit` needed; the absence preserves any flush-on-exit
// behavior in the stdout pipe).

import { scrubEnv } from '../sanitize/index.ts';
import { createBashHandler } from './handlers/bash.ts';
import type { BrokerRequest, BrokerResponse } from './types.ts';
import { type WorkerToolHandler, runWorker } from './worker-runtime.ts';

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

// SIGTERM propagation (slice 83). The spawn broker sends SIGTERM
// on caller-abort; we catch it here, abort the JS-level signal,
// and runWorker passes that into the handler. Without this catch
// the OS would terminate the worker mid-handler, the bash
// subprocess would orphan, and the broker would see "worker
// produced no response" instead of the canonical aborted shape.
const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());

await runWorker({
  handlers: [echoHandler, bashHandler],
  input: readStdin,
  output: (line) => {
    process.stdout.write(line);
  },
  signal: ac.signal,
});
