// Module C: caching layer that wraps any forja-core data source with
// pluggable eviction policies and observability hooks. Sized for
// compaction stress; logic is realistic, names are deliberately verbose.

import type { CacheKey, EvictionPolicy } from 'forja-core/cache';
import { type Clock, Hash, MutexMap, Pool } from 'forja-core/concurrency';
import { CacheMiss, CapacityExceeded, ValidationError } from 'forja-core/errors';

export interface CacheConfig<V> {
  maxEntries: number;
  ttlMs: number;
  evictionPolicy: 'lru' | 'lfu' | 'fifo' | 'tinylfu';
  loader: (key: CacheKey) => Promise<V>;
  serializer?: (value: V) => string;
  deserializer?: (raw: string) => V;
  onHit?: (key: CacheKey) => void;
  onMiss?: (key: CacheKey) => void;
  onEvict?: (key: CacheKey, reason: 'capacity' | 'ttl' | 'manual') => void;
}

export class TieredCache<V> {
  private readonly entries = new MutexMap<string, CacheEntry<V>>();
  private readonly recencyList: string[] = [];
  private readonly frequency = new Map<string, number>();
  private readonly stats = {
    hits: 0,
    misses: 0,
    evictionsCapacity: 0,
    evictionsTtl: 0,
    loaderInvocations: 0,
    loaderErrors: 0,
  };
  private readonly hashFn = new Hash('sha256');

  constructor(private readonly config: CacheConfig<V>) {
    if (config.maxEntries < 1) {
      throw new ValidationError(`maxEntries must be >= 1, got ${config.maxEntries}`);
    }
    if (config.ttlMs <= 0) {
      throw new ValidationError(`ttlMs must be positive, got ${config.ttlMs}`);
    }
  }

  async get(key: CacheKey, clock: Clock): Promise<V> {
    const fingerprint = this.hashFn.hash(JSON.stringify(key));
    const existing = await this.entries.get(fingerprint);
    if (existing !== undefined) {
      const ageMs = clock.nowMs() - existing.createdAtMs;
      if (ageMs < this.config.ttlMs) {
        this.stats.hits += 1;
        this.config.onHit?.(key);
        this.bumpRecency(fingerprint);
        this.bumpFrequency(fingerprint);
        return existing.value;
      }
      this.stats.evictionsTtl += 1;
      this.config.onEvict?.(key, 'ttl');
      await this.entries.delete(fingerprint);
    }
    this.stats.misses += 1;
    this.config.onMiss?.(key);
    return this.loadAndStore(key, fingerprint, clock);
  }

  private async loadAndStore(key: CacheKey, fingerprint: string, clock: Clock): Promise<V> {
    this.stats.loaderInvocations += 1;
    let value: V;
    try {
      value = await this.config.loader(key);
    } catch (e) {
      this.stats.loaderErrors += 1;
      throw e;
    }
    if ((await this.entries.size()) >= this.config.maxEntries) {
      await this.evictOne();
    }
    await this.entries.set(fingerprint, { value, createdAtMs: clock.nowMs() });
    this.bumpRecency(fingerprint);
    this.bumpFrequency(fingerprint);
    return value;
  }
}

interface CacheEntry<V> {
  value: V;
  createdAtMs: number;
}
