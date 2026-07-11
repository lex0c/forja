// Module E: scheduler that orchestrates jobs across forja-core workers
// using a priority queue plus dependency graph. Last fixture file in the
// chunky-modules eval suite; sized for compaction stress.

import { CancellationToken, type ClockSource, type Lease } from 'forja-core/concurrency';
import { CancellationError, DeadlineExceeded, RetryableError } from 'forja-core/errors';
import type { JobSpec, Worker, WorkerPool } from 'forja-core/scheduling';

export interface SchedulerConfig {
  pool: WorkerPool;
  maxConcurrent: number;
  jobTimeoutMs: number;
  retryPolicy: { maxAttempts: number; backoffMs: number };
  clock: ClockSource;
  fairnessKey?: (job: JobSpec) => string;
}

interface QueuedJob {
  spec: JobSpec;
  enqueuedAtMs: number;
  attempt: number;
  blockedBy: Set<string>;
  resolve: (result: unknown) => void;
  reject: (cause: unknown) => void;
}

export class PriorityScheduler {
  private readonly queue: QueuedJob[] = [];
  private readonly running = new Map<string, { worker: Worker; lease: Lease }>();
  private readonly completed = new Set<string>();
  private readonly stats = {
    enqueued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    retried: 0,
  };
  private cancelled = false;

  constructor(private readonly config: SchedulerConfig) {
    if (config.maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be positive, got ${config.maxConcurrent}`);
    }
  }

  async submit(spec: JobSpec): Promise<unknown> {
    if (this.cancelled) {
      throw new CancellationError('scheduler is cancelled');
    }
    return new Promise((resolve, reject) => {
      const job: QueuedJob = {
        spec,
        enqueuedAtMs: this.config.clock.nowMs(),
        attempt: 0,
        blockedBy: new Set(spec.dependsOn ?? []),
        resolve,
        reject,
      };
      this.stats.enqueued += 1;
      this.insertByPriority(job);
      this.tryDispatch();
    });
  }

  private insertByPriority(job: QueuedJob): void {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const there = this.queue[mid]!;
      const cmp = job.spec.priority - there.spec.priority;
      if (cmp > 0 || (cmp === 0 && job.enqueuedAtMs < there.enqueuedAtMs)) hi = mid;
      else lo = mid + 1;
    }
    this.queue.splice(lo, 0, job);
  }

  private tryDispatch(): void {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const idx = this.queue.findIndex((j) => j.blockedBy.size === 0);
      if (idx === -1) return;
      const job = this.queue.splice(idx, 1)[0]!;
      this.startJob(job);
    }
  }

  private async startJob(job: QueuedJob): Promise<void> {
    job.attempt += 1;
    this.stats.started += 1;
    const id = job.spec.id;
    const worker = await this.config.pool.acquire();
    const lease = worker.leaseFor(this.config.jobTimeoutMs);
    this.running.set(id, { worker, lease });
    try {
      const result = await Promise.race([
        worker.execute(job.spec, lease.token),
        this.deadlinePromise(job, lease),
      ]);
      this.stats.completed += 1;
      this.completed.add(id);
      job.resolve(result);
    } catch (cause) {
      this.handleFailure(job, cause);
    } finally {
      this.running.delete(id);
      this.config.pool.release(worker);
      this.unblockDependents(id);
      this.tryDispatch();
    }
  }
}
