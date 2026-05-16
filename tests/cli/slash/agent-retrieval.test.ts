// /agent retrieval slash tests (RETRIEVAL.md §10, slice 4.8).

import { beforeEach, describe, expect, test } from 'bun:test';
import { agentPolicyCommand } from '../../../src/cli/slash/commands/agent-policy.ts';
import {
  buildMetricsLines,
  formatDurationMs,
  formatPercent,
} from '../../../src/cli/slash/commands/agent-retrieval.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import type {
  Candidate,
  ContextSlot,
  ExpandedCandidate,
  PipelineTimings,
  RankedCandidate,
  RetrievalTraceRow,
} from '../../../src/retrieval/types.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createRetrievalTrace } from '../../../src/storage/repos/retrieval-trace.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;
let sessionId: string;
let nowMs: number;

const buildCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const focusStack = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack, now: () => nowMs });
  const baseConfig = {
    cwd: '/p',
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0, critiqueCostUsd: 0, critiqueRuns: 0 },
    now: () => nowMs,
    requestShutdown: () => {},
    isRunning: () => false,
    currentSessionId: () => sessionId,
    replSessionIds: () => [sessionId],
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

const sampleCandidate = (id: string, score = 0.5): Candidate => ({
  nodeId: id,
  view: 'memory',
  bootstrapScore: score,
  reason: `BM25 match in ${id}`,
});

const sampleExpanded = (id: string, score = 0.5): ExpandedCandidate => ({
  nodeId: id,
  view: 'memory',
  bootstrapScore: score,
  reason: `BM25 match in ${id}`,
  path: [id],
  runningScore: score,
});

const sampleRanked = (id: string, final = 0.5): RankedCandidate => ({
  nodeId: id,
  view: 'memory',
  reason: `BM25 match in ${id}`,
  path: [id],
  finalScore: final,
  signals: {
    structural: 1.0,
    lexical: 0.5,
    semantic: 0,
    temporal: 1.0,
    usage: 0,
    goalAlignment: 0,
  },
});

const sampleTimings = (): PipelineTimings => ({
  searchMs: 3,
  expandMs: 1,
  rankMs: 2,
  compressMs: 1,
});

const seedTrace = (
  overrides: Partial<{
    workflow: 'review' | 'refactor' | 'explain' | 'debug' | 'precedent_lookup' | 'default';
    queryText: string;
    budgetTokens: number;
    contextSlot: ContextSlot;
    createdAt: number;
  }> = {},
): string => {
  const id = crypto.randomUUID();
  const slot: ContextSlot = overrides.contextSlot ?? {
    included: [
      {
        nodeId: 'memory:user/auth',
        view: 'memory',
        level: 'summary',
        content: 'description for auth',
        costTokens: 5,
      },
    ],
    skipped: [],
  };
  createRetrievalTrace(db, {
    id,
    sessionId,
    queryText: overrides.queryText ?? 'who handles auth?',
    workflow: overrides.workflow ?? 'precedent_lookup',
    queryType: 'precedent',
    budgetTokens: overrides.budgetTokens ?? 100,
    candidatesRaw: [sampleCandidate('memory:user/auth', 0.8)],
    candidatesExpanded: [sampleExpanded('memory:user/auth', 0.8)],
    candidatesRanked: [sampleRanked('memory:user/auth', 0.72)],
    contextSlot: slot,
    timings: sampleTimings(),
    createdAt: overrides.createdAt ?? nowMs,
  });
  return id;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  nowMs = 1_700_000_000_000;
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

// ─── formatDurationMs unit tests ──────────────────────────────────────

describe('formatDurationMs (M2)', () => {
  test('renders the standard tiers', () => {
    expect(formatDurationMs(0.5)).toBe('<1ms');
    expect(formatDurationMs(42)).toBe('42ms');
    expect(formatDurationMs(2_500)).toBe('2.50s');
  });

  test('returns `?` for negative timings (corrupted timings_json)', () => {
    expect(formatDurationMs(-1)).toBe('?');
    expect(formatDurationMs(-999_999)).toBe('?');
  });

  test('returns `?` for NaN / Infinity (defensive)', () => {
    expect(formatDurationMs(Number.NaN)).toBe('?');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('?');
    expect(formatDurationMs(Number.NEGATIVE_INFINITY)).toBe('?');
  });

  test('exactly 0 still renders as <1ms (boundary)', () => {
    expect(formatDurationMs(0)).toBe('<1ms');
  });
});

describe('formatPercent (M5)', () => {
  test('renders ratios in [0, 1] as percentages', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.5)).toBe('50.0%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(0.235)).toBe('23.5%');
  });

  test('returns `?` for out-of-range ratios (defensive)', () => {
    // evictionRate / budgetUtilization should be ∈ [0, 1] by caller
    // invariant. A value outside that range is a flag.
    expect(formatPercent(-0.1)).toBe('?');
    expect(formatPercent(1.5)).toBe('?');
    expect(formatPercent(99)).toBe('?');
  });

  test('returns `?` for NaN / Infinity', () => {
    expect(formatPercent(Number.NaN)).toBe('?');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('?');
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe('?');
  });
});

describe('buildMetricsLines — capReached path (M7)', () => {
  const baseTrace = (overrides: Partial<RetrievalTraceRow> = {}): RetrievalTraceRow => ({
    id: crypto.randomUUID(),
    sessionId: 'sess',
    queryText: 'q',
    workflow: 'default',
    queryType: 'semantic',
    budgetTokens: 100,
    candidatesRaw: [],
    candidatesExpanded: [],
    candidatesRanked: [],
    contextSlot: { included: [], skipped: [] },
    timings: { searchMs: 5, expandMs: 1, rankMs: 2, compressMs: 3 },
    createdAt: 1_700_000_000_000,
    ...overrides,
  });

  test('capReached=true surfaces a warning line naming the hardCap', () => {
    // Exercises the slash-side render that the repo-level
    // capReached test (commit 49be554 / 55ba11a) doesn't reach.
    const nowMs = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    // Two traces — oldest at nowMs - 5d so the warning quotes
    // "≈ 5.0d ago" deterministically.
    const lines = buildMetricsLines({
      traces: [
        baseTrace({ createdAt: nowMs - 1 * dayMs }),
        baseTrace({ createdAt: nowMs - 5 * dayMs }),
      ],
      capReached: true,
      hardCap: 10_000,
      days: 30,
      nowMs,
    });
    const text = lines.join('\n');
    expect(text).toContain('warning: sample capped at 10000 traces');
    expect(text).toContain('oldest kept ≈ 5.0d ago');
    expect(text).toContain('older traces in the requested 30d window are excluded');
  });

  test('capReached=false does NOT emit a warning line', () => {
    const lines = buildMetricsLines({
      traces: [baseTrace()],
      capReached: false,
      hardCap: 10_000,
      days: 30,
      nowMs: 1_700_000_000_000,
    });
    expect(lines.join('\n')).not.toContain('warning: sample capped');
  });

  test('renders the canonical metrics header + body regardless of capReached', () => {
    const lines = buildMetricsLines({
      traces: [
        baseTrace({
          candidatesRanked: [
            // Minimal RankedCandidate shape — fields beyond what
            // the aggregator reads can stay default-ish.
            {
              nodeId: 'memory:user/x',
              view: 'memory',
              reason: 'r',
              path: ['memory:user/x'],
              finalScore: 0.5,
              signals: {
                structural: 0,
                lexical: 0,
                semantic: 0,
                temporal: 0,
                usage: 0,
                goalAlignment: 0,
              },
            },
          ],
          contextSlot: {
            included: [
              {
                nodeId: 'memory:user/x',
                view: 'memory',
                level: 'full',
                content: 'x',
                costTokens: 30,
              },
            ],
            skipped: [],
          },
        }),
      ],
      capReached: false,
      hardCap: 10_000,
      days: 7,
      nowMs: 1_700_000_000_000,
    });
    const text = lines.join('\n');
    expect(text).toContain('retrieval metrics — last 7.0d (1 traces)');
    expect(text).toContain('budget_utilization_mean');
    expect(text).toContain('eviction_rate');
    expect(text).toContain('view distribution');
  });
});

// ─── router ────────────────────────────────────────────────────────────

describe('/agent retrieval — router', () => {
  test('rejects unknown subnamespace at root', async () => {
    const r = await agentPolicyCommand.exec(['nope'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain("unknown subnamespace 'nope'");
  });

  test('rejects unknown retrieval subcommand', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'made-up'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('unknown subcommand');
  });
});

// ─── summary ───────────────────────────────────────────────────────────

describe('/agent retrieval — summary', () => {
  test('empty session: surfaces a hint instead of the count line', async () => {
    const r = await agentPolicyCommand.exec(['retrieval'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.join('\n')).toContain('no retrieval traces in this session yet');
  });

  test('lists workflow counts when traces exist', async () => {
    seedTrace({ workflow: 'precedent_lookup' });
    seedTrace({ workflow: 'precedent_lookup' });
    seedTrace({ workflow: 'debug' });
    const r = await agentPolicyCommand.exec(['retrieval'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('retrieval traces in this session: 3');
    expect(text).toContain('precedent_lookup=2');
    expect(text).toContain('debug=1');
  });
});

// ─── audit ─────────────────────────────────────────────────────────────

describe('/agent retrieval audit', () => {
  test('empty session: reports empty', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'audit'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.join('\n')).toContain('no retrieval traces');
  });

  test('lists traces newest first', async () => {
    seedTrace({ queryText: 'first query', createdAt: 1_000 });
    seedTrace({ queryText: 'middle query', createdAt: 2_000 });
    seedTrace({ queryText: 'latest query', createdAt: 3_000 });
    const r = await agentPolicyCommand.exec(['retrieval', 'audit'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    const latestIdx = text.indexOf('latest query');
    const middleIdx = text.indexOf('middle query');
    const firstIdx = text.indexOf('first query');
    expect(latestIdx).toBeGreaterThan(0);
    expect(middleIdx).toBeGreaterThan(latestIdx);
    expect(firstIdx).toBeGreaterThan(middleIdx);
  });

  test('--limit caps the result count', async () => {
    for (let i = 0; i < 5; i++) {
      seedTrace({ queryText: `query ${i}`, createdAt: i * 1000 });
    }
    const r = await agentPolicyCommand.exec(['retrieval', 'audit', '--limit', '2'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    // 2 trace lines + header + footer line
    const traceLines = (r.notes ?? []).filter(
      (l) => l.startsWith('  ') && !l.includes('use /agent'),
    );
    expect(traceLines).toHaveLength(2);
    expect(text).toContain('query 4');
    expect(text).toContain('query 3');
  });

  test('rejects --limit with non-integer value', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'audit', '--limit', 'abc'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('rejects unknown flag', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'audit', '--bogus'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('unknown flag');
  });

  test('rejects --limit at boundary (0 and above cap)', async () => {
    const below = await agentPolicyCommand.exec(['retrieval', 'audit', '--limit', '0'], buildCtx());
    expect(below.kind).toBe('error');
    if (below.kind === 'error') expect(below.message).toContain('--limit must be an integer');
    const above = await agentPolicyCommand.exec(
      ['retrieval', 'audit', '--limit', '101'],
      buildCtx(),
    );
    expect(above.kind).toBe('error');
    if (above.kind === 'error') expect(above.message).toContain('--limit must be an integer');
  });
});

// ─── replay ────────────────────────────────────────────────────────────

describe('/agent retrieval replay', () => {
  test('missing id surfaces a clear error', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'replay'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('missing query id');
  });

  test('renders full per-stage dump for an existing trace', async () => {
    const id = seedTrace({ queryText: 'how does auth work?' });
    const r = await agentPolicyCommand.exec(['retrieval', 'replay', id], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain(`trace ${id}`);
    expect(text).toContain('workflow=precedent_lookup');
    expect(text).toContain('how does auth work?');
    expect(text).toContain('candidates_raw');
    expect(text).toContain('candidates_ranked');
    expect(text).toContain('context_slot included');
    expect(text).toContain('timings:');
    // Signal breakdown present
    expect(text).toContain('lex=');
    expect(text).toContain('tmp=');
  });

  test('resolves an 8-char prefix unambiguously', async () => {
    const id = seedTrace();
    const prefix = id.slice(0, 8);
    const r = await agentPolicyCommand.exec(['retrieval', 'replay', prefix], buildCtx());
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.notes?.join('\n')).toContain(`trace ${id}`);
  });

  test('reports skipped entries in the dump', async () => {
    seedTrace({
      contextSlot: {
        included: [],
        skipped: [
          {
            nodeId: 'memory:user/skipped',
            view: 'memory',
            wouldCostTokens: 200,
            reason: 'cheapest level (summary) costs 30t > remaining 5t',
          },
        ],
      },
    });
    const trace = (
      await import('../../../src/storage/repos/retrieval-trace.ts')
    ).listRetrievalTracesBySession(db, sessionId)[0];
    if (!trace) throw new Error('expected one trace');
    const r = await agentPolicyCommand.exec(['retrieval', 'replay', trace.id], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('skipped (1):');
    expect(text).toContain('would_cost=200t');
    expect(text).toContain('cheapest level (summary)');
  });

  test('error on unknown id', async () => {
    const r = await agentPolicyCommand.exec(
      ['retrieval', 'replay', 'definitely-not-an-id'],
      buildCtx(),
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('no trace id matches');
  });

  test('ambiguous prefix is refused with the colliding short ids', async () => {
    // UUIDs are random — colliding prefixes are statistically
    // improbable. Plant two traces with synthesized ids sharing
    // a 4-char prefix (so the resolver's prefix scan matches
    // both) but DIFFERENT 8-char shortIds (so the error message
    // can list them distinctly).
    const sharedPrefix = 'abcd';
    const idA = 'abcd1111-2222-2222-2222-222222222222';
    const idB = 'abcd9999-3333-3333-3333-333333333333';
    createRetrievalTrace(db, {
      id: idA,
      sessionId,
      queryText: 'a',
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
      id: idB,
      sessionId,
      queryText: 'b',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
    });
    const r = await agentPolicyCommand.exec(['retrieval', 'replay', sharedPrefix], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('ambiguous');
      // Both colliding short ids show up in the message so the
      // operator can pick a longer prefix.
      expect(r.message).toContain(idA.slice(0, 8));
      expect(r.message).toContain(idB.slice(0, 8));
    }
  });

  test('prefix scan reaches beyond MAX_AUDIT_LIMIT — older traces still resolve (H7 regression)', async () => {
    // Regression: prior `resolveTraceId` scanned only the freshest
    // MAX_AUDIT_LIMIT=100 traces. In a session with >100 traces, a
    // valid prefix for an older trace returned "no match" silently.
    // The resolver now scans up to PREFIX_SCAN_HARD_CAP=10k so
    // prefix resolution covers realistic session depths.
    const targetId = 'beef0000-0000-0000-0000-000000000000';
    // Seed 150 fresh traces (more than the old 100 cap) before the
    // target so the target is "older" than the original window.
    for (let i = 0; i < 150; i++) {
      createRetrievalTrace(db, {
        sessionId,
        queryText: `filler ${i}`,
        workflow: 'default',
        queryType: 'semantic',
        budgetTokens: 100,
        candidatesRaw: [],
        candidatesExpanded: [],
        candidatesRanked: [],
        contextSlot: { included: [], skipped: [] },
        timings: sampleTimings(),
        createdAt: nowMs - (200 - i),
      });
    }
    createRetrievalTrace(db, {
      id: targetId,
      sessionId,
      queryText: 'target',
      workflow: 'default',
      queryType: 'semantic',
      budgetTokens: 100,
      candidatesRaw: [],
      candidatesExpanded: [],
      candidatesRanked: [],
      contextSlot: { included: [], skipped: [] },
      timings: sampleTimings(),
      createdAt: nowMs - 1000, // older than every filler
    });
    const r = await agentPolicyCommand.exec(['retrieval', 'replay', 'beef0000'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.notes?.join('\n')).toContain(targetId);
    }
  });
});

// ─── metrics ───────────────────────────────────────────────────────────

describe('/agent retrieval metrics', () => {
  test('reports zero traces when window is empty', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'metrics'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.join('\n')).toContain('no retrieval traces in the last 30');
  });

  test('aggregates utilization / eviction / latency / diversity', async () => {
    // Three traces with varying utilization + a skipped entry to
    // exercise eviction_rate.
    seedTrace({
      budgetTokens: 100,
      contextSlot: {
        included: [
          {
            nodeId: 'memory:user/a',
            view: 'memory',
            level: 'summary',
            content: 'a',
            costTokens: 50,
          },
        ],
        skipped: [
          {
            nodeId: 'memory:user/skipped',
            view: 'memory',
            wouldCostTokens: 200,
            reason: 'cheapest level (summary) costs 200t > remaining 50t',
          },
        ],
      },
    });
    seedTrace({
      budgetTokens: 100,
      contextSlot: {
        included: [
          {
            nodeId: 'session:message:x',
            view: 'session',
            level: 'full',
            content: 'x',
            costTokens: 80,
          },
        ],
        skipped: [],
      },
    });
    const r = await agentPolicyCommand.exec(['retrieval', 'metrics'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('budget_utilization_mean');
    expect(text).toContain('eviction_rate');
    expect(text).toContain('diversity');
    expect(text).toContain('latency by stage');
    expect(text).toContain('view distribution');
    expect(text).toContain('memory');
    expect(text).toContain('session');
  });

  test('--days flag respects the window', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    seedTrace({ createdAt: nowMs - 10 * dayMs, queryText: 'inside-7d-no' });
    seedTrace({ createdAt: nowMs - 1 * dayMs, queryText: 'inside-7d-yes' });
    const r = await agentPolicyCommand.exec(['retrieval', 'metrics', '--days', '7'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.join('\n')).toContain('1 traces');
  });

  test('rejects --days with non-integer value', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'metrics', '--days', 'abc'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('rejects --days at boundary (0 and above cap)', async () => {
    const below = await agentPolicyCommand.exec(
      ['retrieval', 'metrics', '--days', '0'],
      buildCtx(),
    );
    expect(below.kind).toBe('error');
    if (below.kind === 'error') expect(below.message).toContain('--days must be an integer');
    const above = await agentPolicyCommand.exec(
      ['retrieval', 'metrics', '--days', '366'],
      buildCtx(),
    );
    expect(above.kind).toBe('error');
    if (above.kind === 'error') expect(above.message).toContain('--days must be an integer');
  });
});

// ─── workflows ─────────────────────────────────────────────────────────

describe('/agent retrieval workflows', () => {
  test('lists every workflow with its six-signal weights', async () => {
    const r = await agentPolicyCommand.exec(['retrieval', 'workflows'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = r.notes?.join('\n') ?? '';
    for (const wf of ['review', 'refactor', 'explain', 'debug', 'precedent_lookup', 'default']) {
      expect(text).toContain(wf);
    }
    // Column headers
    expect(text).toContain('structural');
    expect(text).toContain('lexical');
    expect(text).toContain('temporal');
  });
});
