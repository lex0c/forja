// Retrieval pipeline skeleton tests (RETRIEVAL.md §2 + §10.1).
//
// Slice 4.1 ships the orchestrator with stub stages. These tests
// pin the wiring: every stage runs in order, timings populate, the
// trace lands in retrieval_trace, and the failure-degradation
// surface for per-view search exceptions behaves as spec'd.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Candidate, PipelineDeps, RetrievalQuery } from '../../src/retrieval/index.ts';
import { runRetrieval } from '../../src/retrieval/pipeline.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listRetrievalTracesBySession } from '../../src/storage/repos/retrieval-trace.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

const baseQuery: RetrievalQuery = {
  text: 'who is the user',
  workflow: 'default',
  queryType: 'semantic',
  budgetTokens: 100,
};

const candidateOf = (id: string, score = 0.5): Candidate => ({
  nodeId: id,
  view: 'memory',
  bootstrapScore: score,
  reason: `stub seed ${id}`,
});

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('runRetrieval — skeleton', () => {
  test('empty views → empty slot + persisted trace', async () => {
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {},
      now: () => 1_000,
    };
    const result = await runRetrieval(deps, baseQuery);
    expect(result.queryId).toBeTruthy();
    expect(result.candidatesRaw).toEqual([]);
    expect(result.candidatesExpanded).toEqual([]);
    expect(result.candidatesRanked).toEqual([]);
    expect(result.contextSlot.included).toEqual([]);
    expect(result.contextSlot.skipped).toEqual([]);

    const persisted = listRetrievalTracesBySession(db, sessionId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(result.queryId);
    expect(persisted[0]?.createdAt).toBe(1_000);
  });

  test('stub stages chain — each candidate makes it to the slot as a ref', async () => {
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          search: async () => [candidateOf('memory:a'), candidateOf('memory:b', 0.4)],
        },
      },
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.candidatesRaw).toHaveLength(2);
    expect(r.candidatesExpanded).toHaveLength(2);
    expect(r.candidatesRanked).toHaveLength(2);
    expect(r.contextSlot.included).toHaveLength(2);
    for (const entry of r.contextSlot.included) {
      expect(entry.level).toBe('ref'); // stub compress emits ref only
      expect(entry.costTokens).toBe(1);
    }
  });

  test('compression respects the budget — skipped entries land in the slot', async () => {
    const candidates: Candidate[] = Array.from({ length: 5 }, (_, i) => candidateOf(`m:${i}`));
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: { memory: { search: async () => candidates } },
    };
    const tinyQuery: RetrievalQuery = { ...baseQuery, budgetTokens: 2 };
    const r = await runRetrieval(deps, tinyQuery);
    expect(r.contextSlot.included).toHaveLength(2);
    expect(r.contextSlot.skipped).toHaveLength(3);
    for (const s of r.contextSlot.skipped) {
      expect(s.wouldCostTokens).toBe(1);
      expect(s.reason).toContain('budget exhausted');
    }
  });

  test('per-view search failure is degraded, other views still contribute', async () => {
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const deps: PipelineDeps = {
        db,
        sessionId,
        views: {
          memory: { search: async () => [candidateOf('m:1')] },
          session: {
            search: async () => {
              throw new Error('boom');
            },
          },
        },
      };
      const r = await runRetrieval(deps, baseQuery);
      // The failing view contributes nothing; the healthy view's
      // single candidate still makes it into the slot.
      expect(r.candidatesRaw).toHaveLength(1);
      expect(r.candidatesRaw[0]?.nodeId).toBe('m:1');
      expect(captured.join('')).toContain("view 'session' search failed");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('timings populate for every stage with the monotonic clock supplied', async () => {
    // monoNow returns 0, 10, 20, 30, 40, 50, 60, 70, 80 — pairs of
    // start/end per stage. Search 10, expand 10, rank 10, compress 10.
    const ticks = [0, 10, 10, 20, 20, 30, 30, 40];
    let i = 0;
    const monoNow = (): number => {
      const v = ticks[i] ?? 0;
      i += 1;
      return v;
    };
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {},
      monoNow,
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.timings).toEqual({ searchMs: 10, expandMs: 10, rankMs: 10, compressMs: 10 });
  });

  test('compressionResolver dep activates compressGreedy as default compress', async () => {
    // Slice 4.7 wiring: when deps.compress is absent but
    // deps.compressionResolver is set, the pipeline uses
    // compressGreedy against the resolver instead of the
    // ref-only skeleton stub.
    let resolveCalls = 0;
    const resolver = {
      resolve: () => {
        resolveCalls += 1;
        return { content: 'resolved-content', costTokens: 10 };
      },
    };
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          search: async () => [candidateOf('memory:user/foo')],
        },
      },
      compressionResolver: resolver,
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.contextSlot.included).toHaveLength(1);
    expect(r.contextSlot.included[0]?.content).toBe('resolved-content');
    expect(r.contextSlot.included[0]?.costTokens).toBe(10);
    // The default ref-only stub would have emitted level='ref'
    // with costTokens=1; the resolver path takes over and
    // produces level='full' (first level the greedy loop tries).
    expect(r.contextSlot.included[0]?.level).toBe('full');
    expect(resolveCalls).toBeGreaterThan(0);
  });

  test('explicit deps.compress wins over deps.compressionResolver', async () => {
    // Override precedence: a test that wants total control
    // passes deps.compress directly; the resolver is ignored.
    const resolver = {
      resolve: () => {
        throw new Error('resolver should not be called when deps.compress is set');
      },
    };
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: { memory: { search: async () => [candidateOf('memory:user/foo')] } },
      compress: () => ({
        included: [
          {
            nodeId: 'override',
            view: 'memory',
            level: 'summary',
            content: 'override-content',
            costTokens: 1,
          },
        ],
        skipped: [],
      }),
      compressionResolver: resolver,
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.contextSlot.included[0]?.content).toBe('override-content');
  });

  test('custom expand / rank / compress callbacks override stubs', async () => {
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: { memory: { search: async () => [candidateOf('m:1')] } },
      expand: (cands) =>
        cands.map((c) => ({
          nodeId: c.nodeId,
          view: c.view,
          bootstrapScore: c.bootstrapScore,
          reason: c.reason,
          path: [c.nodeId, 'expanded'],
          runningScore: c.bootstrapScore * 1.5,
        })),
      rank: (exp) =>
        exp.map((e) => ({
          nodeId: e.nodeId,
          view: e.view,
          reason: e.reason,
          path: e.path,
          finalScore: 0.99,
          signals: {
            structural: 0.5,
            lexical: 0.4,
            semantic: 0,
            temporal: 0,
            usage: 0,
            goalAlignment: 0.09,
          },
        })),
      compress: () => ({
        included: [
          {
            nodeId: 'custom',
            view: 'memory',
            level: 'full',
            content: 'custom-content',
            costTokens: 99,
          },
        ],
        skipped: [],
      }),
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.candidatesExpanded[0]?.path).toEqual(['m:1', 'expanded']);
    expect(r.candidatesRanked[0]?.finalScore).toBe(0.99);
    expect(r.contextSlot.included[0]?.content).toBe('custom-content');
  });
});

describe('runRetrieval — abort signal', () => {
  test('pre-aborted signal throws before stage 1 runs (no view searched)', async () => {
    let searchCalls = 0;
    const ctrl = new AbortController();
    ctrl.abort();
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          async search() {
            searchCalls++;
            return [candidateOf('m:1')];
          },
        },
      },
      signal: ctrl.signal,
    };
    await expect(runRetrieval(deps, baseQuery)).rejects.toThrow(/aborted before search/);
    expect(searchCalls).toBe(0);
  });

  test('signal flipped between search and expand aborts at the next boundary', async () => {
    let expandRan = false;
    const ctrl = new AbortController();
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          async search() {
            // Simulate a view that triggers an abort while still
            // returning successfully — the next stage boundary
            // must catch it.
            ctrl.abort();
            return [candidateOf('m:1')];
          },
        },
      },
      expand: (cands) => {
        expandRan = true;
        return cands.map((c) => ({
          nodeId: c.nodeId,
          view: c.view,
          bootstrapScore: c.bootstrapScore,
          reason: c.reason,
          path: [c.nodeId],
          runningScore: c.bootstrapScore,
        }));
      },
      signal: ctrl.signal,
    };
    await expect(runRetrieval(deps, baseQuery)).rejects.toThrow(/aborted before expand/);
    expect(expandRan).toBe(false);
  });

  test('signal is forwarded to each view search call', async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const ctrl = new AbortController();
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          async search(_q, signal) {
            seenSignals.push(signal);
            return [];
          },
        },
        session: {
          async search(_q, signal) {
            seenSignals.push(signal);
            return [];
          },
        },
      },
      signal: ctrl.signal,
    };
    await runRetrieval(deps, baseQuery);
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(ctrl.signal);
    expect(seenSignals[1]).toBe(ctrl.signal);
  });

  test('no signal supplied → pipeline runs normally (signal field is optional)', async () => {
    const deps: PipelineDeps = {
      db,
      sessionId,
      views: {
        memory: {
          async search() {
            return [candidateOf('m:1')];
          },
        },
      },
      // signal omitted on purpose
    };
    const r = await runRetrieval(deps, baseQuery);
    expect(r.candidatesRaw).toHaveLength(1);
  });
});
