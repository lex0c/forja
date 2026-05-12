// Broker types — PERMISSION_ENGINE.md §13.7 broker/worker
// architecture. Engine CLI never calls `exec()` directly; tool
// invocations with exec capability flow through a broker that
// owns sandbox mounting + worker lifecycle.
//
// Pre-slice 78, tool execution happened wherever the harness
// called `Bun.spawn` directly. The broker abstraction
// centralizes that into one contract — slice 78 ships the
// types + an in-process degenerate implementation; later slices
// migrate to a separate broker process for the security
// upgrade (spec line 928: "CLI main não tem exec privilege").
//
// Threat model the broker addresses (per slice 78 onward):
//   - **Prompt injection in main:** A compromised harness loop
//     can't directly exec; it can only ASK the broker. The
//     broker enforces sandbox-profile selection (chosen by the
//     permission engine, NOT by the caller).
//   - **State leak across calls:** Worker processes are
//     per-call disposable; tool state can't survive into the
//     next invocation.
//   - **Stuck-tool deadlock:** Worker is killable; the main
//     process never blocks indefinitely.
//   - **Auditability:** All exec flows through one point — every
//     call has a single audit row + telemetry event from a known
//     code path.

// The contract for a tool invocation that needs broker-side exec.
// Constructed by the harness after the permission engine has
// produced an `allow` decision with a sandbox profile.
export interface BrokerRequest {
  // Tool identifier used for telemetry / audit correlation. The
  // broker doesn't dispatch on this — it's logged alongside the
  // call so audit + replay reconstruct what the operator saw.
  toolName: string;
  // Tool arguments as the LLM passed them, NOT the canonicalized
  // form used for hash. The broker forwards these verbatim to
  // the worker, which deserializes them per the tool's schema.
  args: Record<string, unknown>;
  // Resolved capabilities from the permission engine, formatted
  // as `<kind>:<scope>` strings (same format the audit row's
  // capabilities_json column carries). The broker uses these to
  // narrow the sandbox mount points: a write-fs:/work/proj
  // capability becomes a writable bind-mount of /work/proj
  // inside the worker's sandbox.
  capabilities: readonly string[];
  // §6.5 sandbox profile chosen by the engine (`ro` / `cwd-rw` /
  // `cwd-rw-net` / `home-rw` / `host`). Null when the engine
  // didn't run the planner (legacy path or refused branch);
  // null is treated as `host` (no sandbox) — the broker logs a
  // warning but proceeds. Future slices may refuse null in
  // strict mode.
  sandboxProfile: string | null;
  // Audit row's seq for forensic correlation. The broker may
  // emit its own telemetry event tagged with this id so
  // operators can join broker logs with the audit log.
  approvalId?: number;
}

export interface BrokerResponse {
  // True when the tool executed AND exited with code 0. False
  // for any failure mode (sandbox setup failed, worker crashed,
  // tool exited non-zero, broker timeout).
  ok: boolean;
  // Captured stdout. Always defined (empty string if the tool
  // produced none); the broker doesn't forward partial output
  // mid-call — the response lands once the worker exits.
  stdout: string;
  // Captured stderr. Same shape as stdout.
  stderr: string;
  // Numeric exit code from the worker. Undefined when the
  // failure happened BEFORE the worker ran (sandbox mount
  // refusal, spawn failure); `error` field carries the broker-
  // side diagnostic in that case.
  exitCode?: number;
  // Broker-side error description when ok=false AND exitCode is
  // undefined. Carries the failure shape (e.g., "sandbox profile
  // 'X' not viable", "spawn timed out after 30s"). Tools that
  // exit non-zero produce ok=false + exitCode set + error
  // undefined.
  error?: string;
  // Truthful truncation flags from the handler's read-capped
  // primitive (slice 117, R7 P1). Pre-slice the bash tool inferred
  // truncation by regex-testing the trailing pattern in stdout —
  // any user output happening to end in `\n[... truncated; N
  // bytes omitted]` would falsely report truncation. The flags
  // carry the actual handler-side truth. Undefined when the
  // handler doesn't track per-stream truncation (older handlers
  // / non-bash); the bash tool treats undefined as false.
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

// Per-call options. Threaded through every broker implementation
// down to the tool handler. Added in slice 83 (`signal`) so
// callers can cancel an in-flight call instead of leaking the
// subprocess until natural completion. Slice 85 adds `timeoutMs`
// for per-call override of the broker-construction default —
// long-running tools (big tests, builds) need a wider outer
// guard than the broker's session-wide setting.
export interface BrokerCallOptions {
  // Abort signal. When the signal fires:
  //   - in-process broker passes it to the supplied `exec`
  //     callback (the bash handler kills its bash subprocess);
  //   - spawn broker sends SIGTERM to the spawned worker
  //     (worker.ts catches SIGTERM, propagates to runWorker,
  //     which passes it to the handler, which kills the
  //     subprocess; if worker.ts doesn't handle SIGTERM the OS
  //     terminates the process).
  // The broker resolves with `{ok: false, error: 'aborted', ...}`
  // when the signal fired. Pre-aborted signals are handled at
  // entry — no spawn happens.
  signal?: AbortSignal;
  // Per-call outer-guard timeout (slice 85). Overrides the
  // broker-construction `timeoutMs` for this single call. The
  // outer guard kills the WORKER (spawn broker) or relies on the
  // exec function (in-process broker) when exceeded.
  //
  // Distinct from handler-specific timeouts: the bash handler
  // enforces `args.timeout_ms` on the bash subprocess itself
  // (SIGTERM → SIGKILL), while THIS field is the broker-level
  // ceiling for the worker process. The caller (e.g., bashTool)
  // typically sets this wider than the handler timeout so the
  // outer fires only when the handler itself hangs.
  //
  // Semantics:
  //   - `undefined` → use broker-construction default
  //   - `0` → disable timeout for this call (no outer guard)
  //   - positive → use as outer-guard ms
  // The in-process broker passes this to the exec callback;
  // bash-handler-equivalent exec functions may ignore (they have
  // their own per-command timer via args.timeout_ms).
  timeoutMs?: number;
}

// The broker contract. All implementations satisfy this — the
// in-process degenerate (slice 78), a separate-process
// implementation (future slice), a mock for tests, etc.
export interface Broker {
  // Execute one tool invocation. Resolves with the captured
  // output; never throws (failure modes are encoded in the
  // response's `ok` + `error` fields). The implementation MAY
  // serialize concurrent calls (in-process broker queues FIFO
  // to keep state machine reasoning simple) or parallelize them
  // (separate-process broker spawns workers concurrently);
  // callers shouldn't rely on either.
  //
  // Per-call options (slice 83): `signal` cancels the in-flight
  // call by propagating to the tool handler (in-process) or
  // killing the worker (spawn). On abort the response carries
  // `ok: false, error: 'aborted'` plus whatever stdout/stderr
  // had been captured up to that point.
  execute(request: BrokerRequest, options?: BrokerCallOptions): Promise<BrokerResponse>;
  // Release any held resources (long-lived broker process
  // handle, worker pool, etc.). The in-process broker has no
  // resources to release but exposes the method for interface
  // symmetry. Idempotent.
  close(): Promise<void>;
}
