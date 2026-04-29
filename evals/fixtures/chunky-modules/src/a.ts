// Module A: telemetry collector for the forja-core observability surface.
// This file is intentionally large so that smoke evals can stress the
// compaction pathway. The bytes below are realistic-looking TypeScript
// rather than lorem ipsum so the model treats them as plausible source.

import { ConfigError, RetryableError, ValidationError } from 'forja-core/errors';
import { Counter, Gauge, Histogram, MetricRegistry } from 'forja-core/telemetry';
import type { Span, TraceContext } from 'forja-core/tracing';

export interface TelemetryConfig {
  serviceName: string;
  environment: 'development' | 'staging' | 'production';
  samplingRate: number;
  flushIntervalMs: number;
  maxBatchSize: number;
  endpoint: URL;
  headers: Record<string, string>;
  retryPolicy: { maxAttempts: number; backoffMs: number; jitter: boolean };
}

export class TelemetryCollector {
  private readonly registry = new MetricRegistry();
  private readonly buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly counters = {
    requests: new Counter('forja_requests_total'),
    errors: new Counter('forja_errors_total'),
    retries: new Counter('forja_retries_total'),
  };
  private readonly histograms = {
    latency: new Histogram('forja_latency_ms', [10, 50, 100, 500, 1000, 5000]),
    payload: new Histogram('forja_payload_bytes', [1024, 4096, 16384, 65536]),
  };
  private readonly gauges = {
    queueDepth: new Gauge('forja_queue_depth'),
    activeConnections: new Gauge('forja_active_connections'),
  };

  constructor(private readonly config: TelemetryConfig) {
    if (config.samplingRate < 0 || config.samplingRate > 1) {
      throw new ValidationError(`samplingRate out of range: ${config.samplingRate}`);
    }
    if (config.maxBatchSize < 1) {
      throw new ConfigError(`maxBatchSize must be >= 1, got ${config.maxBatchSize}`);
    }
    this.registry.registerCounters(Object.values(this.counters));
    this.registry.registerHistograms(Object.values(this.histograms));
    this.registry.registerGauges(Object.values(this.gauges));
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
  }

  record(event: TelemetryEvent, span?: Span): void {
    if (Math.random() > this.config.samplingRate) return;
    this.buffer.push({ ...event, traceId: span?.traceId, spanId: span?.spanId });
    if (this.buffer.length >= this.config.maxBatchSize) this.flush();
  }
}

export interface TelemetryEvent {
  timestamp: number;
  kind: 'request' | 'error' | 'retry' | 'cache_hit' | 'cache_miss';
  attributes: Record<string, string | number | boolean>;
  traceId?: string;
  spanId?: string;
}
