// retrieval_trace repo tests (RETRIEVAL.md §10.1).

import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  Candidate,
  ContextSlot,
  ExpandedCandidate,
  PipelineTimings,
  RankedCandidate,
} from '../../src/retrieval/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countRetrievalTraces,
  createRetrievalTrace,
  getRetrievalTrace,
  listRetrievalTracesBySession,
  listRetrievalTracesByWorkflow,
} from '../../src/storage/repos/retrieval-trace.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

const sampleCandidates = (): Candidate[] => [
  {
    nodeId: 'memory:user-role',
    view: 'memory',
    bootstrapScore: 0.8,
    reason: 'BM25 hit on title',
  },
];

const sampleExpanded = (): ExpandedCandidate[] => [
  {
    nodeId: 'memory:user-role',
    view: 'memory',
    bootstrapScore: 0.8,
    reason: 'BM25 hit on title',
    path: ['memory:user-role'],
    runningScore: 0.8,
  },
];

const sampleRanked = (): RankedCandidate[] => [
  {
    nodeId: 'memory:user-role',
    view: 'memory',
    reason: 'BM25 hit on title',
    path: ['memory:user-role'],
    finalScore: 0.72,
    signals: {
      structural: 0,
      lexical: 0.72,
      semantic: 0,
      temporal: 0,
      usage: 0,
      goalAlignment: 0,
    },
  },
];

const sampleSlot = (): ContextSlot => ({
  included: [
    {
      nodeId: 'memory:user-role',
      view: 'memory',
      level: 'full',
      content: '# user role\n\nfull-stack TS dev.',
      costTokens: 42,
    },
  ],
  skipped: [
    {
      nodeId: 'memory:phase-q3',
      view: 'memory',
      wouldCostTokens: 200,
      reason: 'budget exhausted',
    },
  ],
});

const sampleTimings = (): PipelineTimings => ({
  searchMs: 3,
  expandMs: 1,
  rankMs: 2,
  compressMs: 1,
});

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('createRetrievalTrace', () => {
  test('persists every stage and round-trips', () => {
    const trace = createRetrievalTrace(db, {
      sessionId,
      queryText: 'who is the user?',
      workflow: 'precedent_lookup',
      queryType: 'precedent',
      budgetTokens: 500,
      candidatesRaw: sampleCandidates(),
      candidatesExpanded: sampleExpanded(),
      candidatesRanked: sampleRanked(),
      contextSlot: sampleSlot(),
      timings: sampleTimings(),
    });
    expect(trace.id).toBeTruthy();
    expect(trace.createdAt).toBeGreaterThan(0);
    const read = getRetrievalTrace(db, trace.id);
    expect(read).not.toBeNull();
    expect(read?.queryText).toBe('who is the user?');
    expect(read?.workflow).toBe('precedent_lookup');
    expect(read?.queryType).toBe('precedent');
    expect(read?.budgetTokens).toBe(500);
    expect(read?.candidatesRaw).toEqual(sampleCandidates());
    expect(read?.candidatesExpanded).toEqual(sampleExpanded());
    expect(read?.candidatesRanked).toEqual(sampleRanked());
    expect(read?.contextSlot).toEqual(sampleSlot());
    expect(read?.timings).toEqual(sampleTimings());
  });

  test('accepts an explicit id (replay path)', () => {
    const trace = createRetrievalTrace(db, {
      id: 'pinned-trace-id',
      sessionId,
      queryText: 'q',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 1,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    expect(trace.id).toBe('pinned-trace-id');
    expect(getRetrievalTrace(db, 'pinned-trace-id')?.id).toBe('pinned-trace-id');
  });

  test('scrubs the query text before persisting', () => {
    const trace = createRetrievalTrace(db, {
      sessionId,
      queryText: 'why did /home/operator/secrets/key.pem fail?',
      workflow: 'debug',
      queryType: 'causal',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    const read = getRetrievalTrace(db, trace.id);
    expect(read?.queryText).not.toContain('/home/operator/secrets');
  });

  test('scrubs candidate reason strings across all stages', () => {
    const reasonWithPath = 'BM25 hit on /home/operator/secrets/auth.ts:42';
    const trace = createRetrievalTrace(db, {
      sessionId,
      queryText: 'q',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [
        { nodeId: 'n1', view: 'memory', bootstrapScore: 0.5, reason: reasonWithPath },
      ],
      candidatesExpanded: [
        {
          nodeId: 'n1',
          view: 'memory',
          bootstrapScore: 0.5,
          reason: reasonWithPath,
          path: ['n1'],
          runningScore: 0.5,
        },
      ],
      candidatesRanked: [
        {
          nodeId: 'n1',
          view: 'memory',
          reason: reasonWithPath,
          path: ['n1'],
          finalScore: 0.5,
          signals: {
            structural: 0,
            lexical: 0.5,
            semantic: 0,
            temporal: 0,
            usage: 0,
            goalAlignment: 0,
          },
        },
      ],
      contextSlot: {
        included: [],
        skipped: [
          {
            nodeId: 'n2',
            view: 'memory',
            wouldCostTokens: 200,
            reason: reasonWithPath,
          },
        ],
      },
      timings: sampleTimings(),
    });
    const read = getRetrievalTrace(db, trace.id);
    expect(read).not.toBeNull();
    expect(read?.candidatesRaw[0]?.reason).not.toContain('/home/operator/secrets');
    expect(read?.candidatesExpanded[0]?.reason).not.toContain('/home/operator/secrets');
    expect(read?.candidatesRanked[0]?.reason).not.toContain('/home/operator/secrets');
    expect(read?.contextSlot.skipped[0]?.reason).not.toContain('/home/operator/secrets');
    // Return shape also reflects the scrub (callers don't need a
    // re-read to see the redacted payload).
    expect(trace.candidatesRaw[0]?.reason).not.toContain('/home/operator/secrets');
  });

  test('leaves ContextSlotEntry.content RAW (substrate must survive)', () => {
    // Slot content is the body retrieval is meant to surface; if we
    // redacted it, the model would receive the redacted shape and
    // eval replay couldn't re-rank against truth. Spec stores raw
    // here; the prompt-boundary scrub layer handles credentials at
    // I/O time.
    const rawContent = '# notes\n\nsee /home/operator/.config/agent/memory/user_role.md';
    const trace = createRetrievalTrace(db, {
      sessionId,
      queryText: 'q',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: {
        included: [
          {
            nodeId: 'n1',
            view: 'memory',
            level: 'full',
            content: rawContent,
            costTokens: 50,
          },
        ],
        skipped: [],
      },
      timings: sampleTimings(),
    });
    const read = getRetrievalTrace(db, trace.id);
    expect(read?.contextSlot.included[0]?.content).toBe(rawContent);
  });

  test('rejects budget_tokens <= 0 (DB CHECK)', () => {
    expect(() =>
      createRetrievalTrace(db, {
        sessionId,
        queryText: 'q',
        workflow: 'default',
        queryType: 'semantic',
        budgetTokens: 0,
        candidatesRaw: [],
        candidatesExpanded: [],
        candidatesRanked: [],
        contextSlot: { included: [], skipped: [] },
        timings: sampleTimings(),
      }),
    ).toThrow();
  });

  test('rejects invalid workflow (DB CHECK)', () => {
    expect(() =>
      createRetrievalTrace(db, {
        sessionId,
        queryText: 'q',
        workflow: 'bogus' as 'default',
        queryType: 'semantic',
        budgetTokens: 100,
        candidatesRaw: [],
        candidatesExpanded: [],
        candidatesRanked: [],
        contextSlot: { included: [], skipped: [] },
        timings: sampleTimings(),
      }),
    ).toThrow();
  });

  test('rejects invalid query_type (DB CHECK)', () => {
    expect(() =>
      createRetrievalTrace(db, {
        sessionId,
        queryText: 'q',
        workflow: 'default',
        queryType: 'made_up' as 'semantic',
        budgetTokens: 100,
        candidatesRaw: [],
        candidatesExpanded: [],
        candidatesRanked: [],
        contextSlot: { included: [], skipped: [] },
        timings: sampleTimings(),
      }),
    ).toThrow();
  });

  test('CASCADE: session purge removes traces', () => {
    createRetrievalTrace(db, {
      sessionId,
      queryText: 'q',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    expect(countRetrievalTraces(db)).toBe(1);
    db.query('PRAGMA foreign_keys = ON').run();
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(countRetrievalTraces(db)).toBe(0);
  });
});

describe('listRetrievalTracesBySession', () => {
  test('returns traces newest first, capped by limit', () => {
    for (let i = 0; i < 5; i++) {
      createRetrievalTrace(db, {
        sessionId,
        queryText: `q${i}`,
        workflow: 'default',
        queryType: 'semantic',
        budgetTokens: 100,
        candidatesRaw: [],
        candidatesExpanded: [],
        candidatesRanked: [],
        contextSlot: { included: [], skipped: [] },
        timings: sampleTimings(),
        createdAt: 1000 + i,
      });
    }
    const rows = listRetrievalTracesBySession(db, sessionId, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.queryText).toBe('q4');
    expect(rows[1]?.queryText).toBe('q3');
    expect(rows[2]?.queryText).toBe('q2');
  });

  test('scopes strictly to the session', () => {
    const other = createSession(db, { model: 'm', cwd: '/p' }).id;
    createRetrievalTrace(db, {
      sessionId,
      queryText: 'mine',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    createRetrievalTrace(db, {
      sessionId: other,
      queryText: 'theirs',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    const rows = listRetrievalTracesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queryText).toBe('mine');
  });
});

describe('listRetrievalTracesByWorkflow', () => {
  test('filters by workflow', () => {
    createRetrievalTrace(db, {
      sessionId,
      queryText: 'review-q',
      workflow: 'review',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    createRetrievalTrace(db, {
      sessionId,
      queryText: 'debug-q',
      workflow: 'debug',
      queryType: 'causal',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    const reviews = listRetrievalTracesByWorkflow(db, 'review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.queryText).toBe('review-q');
  });
});
