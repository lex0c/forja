// Module D: structured logger built around forja-core's tracing model.
// Supports multiple sinks, level filtering per logger name, and lazy
// serialization. Sized intentionally to feed compaction stress evals.

import { ConfigError, ValidationError } from 'forja-core/errors';
import type { LogLevel, LogRecord, Sink } from 'forja-core/logging';
import { type ContextStorage, Span, TraceContext } from 'forja-core/tracing';

export interface LoggerConfig {
  name: string;
  level: LogLevel;
  sinks: Sink[];
  redactKeys: string[];
  contextStorage: ContextStorage;
  sampling?: { errorAlways: boolean; otherRate: number };
}

export class StructuredLogger {
  private readonly redactSet: Set<string>;
  private readonly minLevel: number;

  constructor(private readonly config: LoggerConfig) {
    if (config.sinks.length === 0) {
      throw new ConfigError('logger requires at least one sink');
    }
    if (config.sampling !== undefined) {
      const r = config.sampling.otherRate;
      if (r < 0 || r > 1) {
        throw new ValidationError(`sampling.otherRate out of range: ${r}`);
      }
    }
    this.redactSet = new Set(config.redactKeys);
    this.minLevel = LEVEL_RANK[config.level];
  }

  trace(message: string, attrs?: Record<string, unknown>): void {
    this.write('trace', message, attrs);
  }

  debug(message: string, attrs?: Record<string, unknown>): void {
    this.write('debug', message, attrs);
  }

  info(message: string, attrs?: Record<string, unknown>): void {
    this.write('info', message, attrs);
  }

  warn(message: string, attrs?: Record<string, unknown>): void {
    this.write('warn', message, attrs);
  }

  error(message: string, attrs?: Record<string, unknown>, cause?: unknown): void {
    const fullAttrs: Record<string, unknown> = { ...(attrs ?? {}) };
    if (cause instanceof Error) {
      fullAttrs.error_name = cause.name;
      fullAttrs.error_message = cause.message;
      if (cause.stack !== undefined) fullAttrs.error_stack = cause.stack;
    } else if (cause !== undefined) {
      fullAttrs.cause = String(cause);
    }
    this.write('error', message, fullAttrs);
  }

  private write(level: LogLevel, message: string, attrs?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < this.minLevel) return;
    if (this.config.sampling !== undefined && level !== 'error') {
      if (Math.random() > this.config.sampling.otherRate) return;
    }
    const span = this.config.contextStorage.currentSpan();
    const safeAttrs = this.redactAttrs(attrs ?? {});
    const record: LogRecord = {
      timestamp: Date.now(),
      level,
      logger: this.config.name,
      message,
      attributes: safeAttrs,
      traceId: span?.traceId,
      spanId: span?.spanId,
    };
    for (const sink of this.config.sinks) sink.write(record);
  }

  private redactAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      out[k] = this.redactSet.has(k) ? '<redacted>' : v;
    }
    return out;
  }
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
