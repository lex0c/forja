// Module B: rate limiter built on forja-core primitives. Token-bucket
// algorithm with per-key state stored in an in-memory map plus optional
// distributed backing. Sized intentionally large for compaction stress.

import { AtomicCounter, type ClockSource, MutexMap } from 'forja-core/concurrency';
import { CapacityExceeded, KeyNotFound, RetryableError } from 'forja-core/errors';
import type { KeyExtractor, RateLimitDecision } from 'forja-core/limits';

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
  keyExtractor: KeyExtractor;
  clock: ClockSource;
  backingStore?: 'memory' | 'redis' | 'dynamo';
  shedOnOverload: boolean;
  burstAllowance: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new MutexMap<string, BucketState>();
  private readonly counter = new AtomicCounter();
  private readonly metrics = {
    accepted: 0,
    rejected: 0,
    shed: 0,
    refilled: 0,
  };

  constructor(private readonly config: RateLimitConfig) {
    if (config.capacity < 1) {
      throw new RangeError(`capacity must be positive, got ${config.capacity}`);
    }
    if (config.refillPerSecond <= 0) {
      throw new RangeError(`refillPerSecond must be positive, got ${config.refillPerSecond}`);
    }
  }

  async tryAcquire(request: { headers: Headers; cost: number }): Promise<RateLimitDecision> {
    const key = this.config.keyExtractor(request);
    if (key === null) {
      throw new KeyNotFound('rate limit key extractor returned null');
    }
    const cost = Math.max(1, Math.floor(request.cost));
    const now = this.config.clock.nowMs();
    const bucket = await this.buckets.upsert(key, (existing) => {
      if (existing === undefined) {
        return { tokens: this.config.capacity, lastRefillMs: now };
      }
      const elapsedSec = (now - existing.lastRefillMs) / 1000;
      const replenished = Math.min(
        this.config.capacity,
        existing.tokens + elapsedSec * this.config.refillPerSecond,
      );
      this.metrics.refilled += replenished - existing.tokens;
      return { tokens: replenished, lastRefillMs: now };
    });
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.metrics.accepted += 1;
      return { allowed: true, remaining: bucket.tokens, retryAfterMs: 0 };
    }
    this.metrics.rejected += 1;
    if (this.config.shedOnOverload) {
      this.metrics.shed += 1;
      throw new CapacityExceeded(`rate limit exceeded for key=${key}, cost=${cost}`);
    }
    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.config.refillPerSecond) * 1000);
    return { allowed: false, remaining: bucket.tokens, retryAfterMs };
  }
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}
