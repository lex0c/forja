// Worker runtime — PERMISSION_ENGINE.md §13.7 worker dispatch
// primitive. The pure function `runWorker(options)` is the worker
// process's inner loop:
//
//   1. drain stdin (caller-supplied `input` callback)
//   2. parse one NDJSON line as a BrokerRequest
//   3. dispatch to the matching handler by `toolName`
//   4. catch handler throws into BrokerResponse error path
//   5. emit one NDJSON line on stdout (caller-supplied `output`)
//
// Why a pure function with seams instead of inlining the loop in
// `worker.ts`: unit tests must pin every wire-format edge case
// (empty input, invalid JSON, missing fields, handler throws,
// unknown tool, duplicate handler names) without spawning a real
// subprocess. The seams keep tests fast + deterministic. The
// production entry (`worker.ts`) is a 10-line script that wires
// the seams to `Bun.stdin.stream()` and `process.stdout.write`.
//
// Wire format on stdin (broker → worker):
//   - one NDJSON line, terminated by '\n'
//   - parses as the BrokerRequest type from `./types.ts`
//   - trailing whitespace is trimmed
//   - empty / whitespace-only input → error response
//   - invalid JSON → error response
//   - valid JSON missing required fields → error response
//
// Wire format on stdout (worker → broker):
//   - one NDJSON line, terminated by '\n'
//   - serializes as a BrokerResponse from `./types.ts`
//   - emitted exactly once per `runWorker` invocation
//   - failures map to `{ok: false, error: '...', stdout: '', stderr: ''}`
//
// Handler registry: callers pass an array of `WorkerToolHandler`.
// Slice 80 doesn't ship concrete handlers — production wiring
// (slice 81+) registers bash + read_file + glob + etc. Tests pass
// scripted handlers. Dispatch keys on `request.toolName`; unknown
// names emit a `worker handler not found:` error response.
//
// Handler throws are NEVER propagated. Every code path inside the
// runtime maps failures to BrokerResponse + emits a single line.
// The worker process always exits cleanly (the broker discriminates
// failure modes via the response's `ok` + `error` fields).
//
// Duplicate handler names are a caller bug: emit a registration
// error response and return without reading input. The worker's
// stdin pipe stays open + closes when the process exits; the
// broker reads the response from stdout regardless.
//
// Statelessness: `runWorker` holds no module-level state. Multiple
// invocations in the same process (test scenarios) work
// independently. Production workers are per-call disposable so
// this is paranoia, not requirement.

import type { BrokerRequest, BrokerResponse } from './types.ts';

export interface WorkerToolHandler {
  // Identifier the broker passes as `request.toolName`. Must be
  // unique within a worker's handler registry. Convention: snake_case
  // matching the tool name in `src/tools/builtin/`. The `__echo__`
  // name (double underscores) is reserved for the diagnostic handler
  // in the production worker entry.
  name: string;
  // Execute one BrokerRequest. The handler is responsible for
  // realizing the tool's side effect (spawn shell, read fs, etc.)
  // + producing the BrokerResponse. Throws are caught by `runWorker`
  // and mapped to an error response, but well-behaved handlers
  // SHOULD return a BrokerResponse from every path (including
  // failure modes — set `ok: false` + populate `error` + `stderr`).
  execute(request: BrokerRequest): Promise<BrokerResponse>;
}

export interface RunWorkerOptions {
  // Handler registry for this invocation. Empty array is legal
  // (every request will get a `worker handler not found:` error).
  handlers: readonly WorkerToolHandler[];
  // Drain the input source as a single string. Production passes
  // a function that consumes `Bun.stdin.stream()` until EOF. Tests
  // pass a function returning a fixed string. Errors propagate
  // into a `worker input read failed:` response.
  input: () => Promise<string>;
  // Write a single line. Called exactly once per `runWorker`
  // invocation, with the JSON-serialized BrokerResponse plus a
  // trailing '\n'. Production binds `process.stdout.write`; tests
  // capture into an array.
  output: (line: string) => void;
}

const isBrokerRequest = (v: unknown): v is BrokerRequest => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.toolName !== 'string') return false;
  if (typeof o.args !== 'object' || o.args === null) return false;
  if (!Array.isArray(o.capabilities)) return false;
  for (const c of o.capabilities) {
    if (typeof c !== 'string') return false;
  }
  if (o.sandboxProfile !== null && typeof o.sandboxProfile !== 'string') return false;
  if (o.approvalId !== undefined && typeof o.approvalId !== 'number') return false;
  return true;
};

const errorResponse = (error: string): BrokerResponse => ({
  ok: false,
  stdout: '',
  stderr: '',
  error,
});

const emit = (output: (line: string) => void, response: BrokerResponse): void => {
  output(`${JSON.stringify(response)}\n`);
};

export const runWorker = async (options: RunWorkerOptions): Promise<void> => {
  // Build handler map first so duplicate detection fails fast,
  // before we touch stdin. Duplicate names are a caller bug —
  // emit a registration error and return; the broker reads it
  // from stdout like any other response.
  const handlerMap = new Map<string, WorkerToolHandler>();
  for (const h of options.handlers) {
    if (handlerMap.has(h.name)) {
      emit(options.output, errorResponse(`worker handler duplicate: ${h.name}`));
      return;
    }
    handlerMap.set(h.name, h);
  }

  let rawInput: string;
  try {
    rawInput = await options.input();
  } catch (e) {
    emit(
      options.output,
      errorResponse(`worker input read failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return;
  }

  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    emit(options.output, errorResponse('worker received empty input'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    emit(
      options.output,
      errorResponse(`worker request parse failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    return;
  }

  if (!isBrokerRequest(parsed)) {
    emit(options.output, errorResponse('worker request missing required fields'));
    return;
  }

  const handler = handlerMap.get(parsed.toolName);
  if (handler === undefined) {
    emit(options.output, errorResponse(`worker handler not found: ${parsed.toolName}`));
    return;
  }

  let response: BrokerResponse;
  try {
    response = await handler.execute(parsed);
  } catch (e) {
    response = errorResponse(`worker handler threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  emit(options.output, response);
};
