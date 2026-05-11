// Telemetry JSON-lines adapter — PERMISSION_ENGINE.md §18 line
// 1205 ("OTEL export com scrubbing"). Writes each event as one
// JSON object per line (NDJSON / JSONL format). Operators pipe
// this stream to anything that ingests JSON lines —
// `otelcol-contrib`'s `filelogreceiver`, Loki, Vector, fluentbit,
// or a hand-rolled tail script.
//
// Why JSON lines, not the OTEL SDK directly:
//   - Forja's locked stack (CLAUDE.md) bars new runtime deps
//     without a spec PR. The `@opentelemetry/api` +
//     `@opentelemetry/sdk-metrics` family is ~300KB of TS code +
//     transitive deps that would shift the agent's binary
//     footprint significantly. JSON lines is dep-free.
//   - JSON lines compose with every existing observability tool.
//     An operator who wants real OTEL pipes through otelcol's
//     `filelog` receiver + the `otlphttp` exporter — three lines
//     of YAML config, zero engine surface.
//   - Future slice can ship a true OTEL SDK adapter alongside
//     this one (`src/telemetry/otel.ts`) for operators who
//     specifically want in-process export. Both share the same
//     `TelemetrySink` contract.
//
// Schema: each line is `JSON.stringify(event) + '\n'`. Field
// order is JSON-engine-defined but stable across runs for the
// same event shape. Consumers that need byte-stable serialization
// (e.g., for replay-verification) wrap their own canonical
// serializer; this adapter is for HUMAN + OPS-TOOL consumption,
// not chain-hash-grade determinism.

import type { TelemetryEvent, TelemetrySink } from './index.ts';

export interface CreateJsonLinesTelemetrySinkOptions {
  // Receiver for each formatted line (already includes the
  // trailing `\n`). Production wiring: `process.stdout.write` or
  // a `node:fs.createWriteStream` `.write` bound function. Tests
  // pass a capturing function. Throws from `write` propagate to
  // the caller — the engine's outer try/catch at the emission
  // site absorbs (same posture as the scrubbing sink, slice 76).
  write: (line: string) => void;
}

export const createJsonLinesTelemetrySink = (
  options: CreateJsonLinesTelemetrySinkOptions,
): TelemetrySink => ({
  emit: (event: TelemetryEvent) => {
    options.write(`${JSON.stringify(event)}\n`);
  },
});
