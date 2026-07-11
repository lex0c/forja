// Hook matcher tests for the Eviction event (EVICTION.md §10.3).
//
// The dispatcher honors five new matcher fields on Eviction-event
// hook specs (substrate, motivo, fromState, toState, actor). These
// tests pin the matching behavior using matchesPayload directly,
// independent of the spawn machinery — keeps the cost of asserting
// the matcher contract tiny vs spinning up dispatchChain fixtures.

import { describe, expect, test } from 'bun:test';
import { matchesPayload } from '../../src/hooks/dispatcher-matching.ts';
import {
  BLOCKING_EVENTS,
  type EvictionEventData,
  type HookEventPayload,
  type HookMatcher,
  type HookSpec,
} from '../../src/hooks/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const makeEvictionPayload = (overrides: Partial<EvictionEventData> = {}): HookEventPayload => ({
  schema: 'v1',
  event: 'Eviction',
  sessionId: 'sess-1',
  data: {
    substrate: 'memory',
    objectId: 'mem-1',
    objectScope: 'project_local',
    fromState: 'active',
    toState: 'quarantined',
    trigger: 'verify_failed',
    motivo: 'conflict',
    actor: 'loop_cold',
    evidenceJson: '{}',
    ...overrides,
  },
});

const makeSpec = (matcher: HookMatcher = {}): HookSpec => ({
  layer: 'project',
  sourcePath: '/repo/.forja/hooks.toml',
  event: 'Eviction',
  matcher,
  entryIndex: 0,
  command: 'echo {{event}}',
  timeoutMs: 5000,
  failClosed: false,
  locked: false,
});

describe('Eviction event: BLOCKING_EVENTS membership', () => {
  test('Eviction is registered as a blocking event', () => {
    expect(BLOCKING_EVENTS.has('Eviction')).toBe(true);
  });
});

describe('Eviction event: hook_runs schema accepts the event', () => {
  // Post-1.2 review C1 regression: migration 047 rebuilt
  // hook_runs.event CHECK to include 'Eviction'. Without this,
  // every audit write from a fired Eviction hook would hit the
  // CHECK constraint and the dispatcher would log "AUDIT DRIFT"
  // to stderr. The test inserts directly through bun:sqlite —
  // exercising the schema, not the dispatcher — so a future
  // migration regression that re-tightens the CHECK trips this
  // first.
  test('raw INSERT with event=Eviction succeeds against the migrated schema', () => {
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    expect(() =>
      db
        .query(
          `INSERT INTO hook_runs (
            id, session_id, event, layer, source_path, hook_index,
            command, expanded, exit_code, outcome, duration_ms,
            stdout, stderr, matched_tool, created_at
          ) VALUES (?, ?, 'Eviction', 'project', '/x/hooks.toml', 0,
                    'echo', 'echo', 0, 'allow', 5, NULL, NULL, NULL, ?)`,
        )
        .run('row-1', sessionId, Date.now()),
    ).not.toThrow();
    const rows = db
      .query<{ event: string }, [string]>('SELECT event FROM hook_runs WHERE id = ?')
      .all('row-1');
    expect(rows[0]?.event).toBe('Eviction');
  });
});

describe('Eviction matcher: empty matcher', () => {
  test('a spec with no matcher fields admits any Eviction payload', () => {
    const spec = makeSpec();
    expect(matchesPayload(spec, makeEvictionPayload())).toBe(true);
  });
});

describe('Eviction matcher: per-field exact match', () => {
  test('substrate match admits, mismatch rejects', () => {
    const spec = makeSpec({ substrate: 'memory' });
    expect(matchesPayload(spec, makeEvictionPayload({ substrate: 'memory' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ substrate: 'policy' }))).toBe(false);
  });

  test('motivo match admits, mismatch rejects', () => {
    const spec = makeSpec({ motivo: 'security' });
    expect(matchesPayload(spec, makeEvictionPayload({ motivo: 'security' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ motivo: 'conflict' }))).toBe(false);
  });

  test('fromState match admits, mismatch rejects', () => {
    const spec = makeSpec({ fromState: 'active' });
    expect(matchesPayload(spec, makeEvictionPayload({ fromState: 'active' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ fromState: 'quarantined' }))).toBe(false);
  });

  test('toState match admits, mismatch rejects', () => {
    const spec = makeSpec({ toState: 'evicted' });
    expect(matchesPayload(spec, makeEvictionPayload({ toState: 'evicted' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ toState: 'quarantined' }))).toBe(false);
  });

  test('actor match admits, mismatch rejects', () => {
    const spec = makeSpec({ actor: 'user' });
    expect(matchesPayload(spec, makeEvictionPayload({ actor: 'user' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ actor: 'loop_cold' }))).toBe(false);
  });
});

describe('Eviction matcher: conjunction (AND across fields)', () => {
  // All supplied matcher fields must match — a single mismatch
  // suppresses the hook even when other fields would pass.
  test('two-field matcher admits when both match', () => {
    const spec = makeSpec({ substrate: 'memory', motivo: 'security' });
    expect(
      matchesPayload(spec, makeEvictionPayload({ substrate: 'memory', motivo: 'security' })),
    ).toBe(true);
  });

  test('two-field matcher rejects on a single mismatch', () => {
    const spec = makeSpec({ substrate: 'memory', motivo: 'security' });
    expect(
      matchesPayload(spec, makeEvictionPayload({ substrate: 'policy', motivo: 'security' })),
    ).toBe(false);
    expect(
      matchesPayload(spec, makeEvictionPayload({ substrate: 'memory', motivo: 'conflict' })),
    ).toBe(false);
  });

  test('all five fields together pin a single transition shape', () => {
    // Spec §10.3 example: an enterprise hook gating only on
    // security-flagged memory purges.
    const spec = makeSpec({
      substrate: 'memory',
      motivo: 'security',
      fromState: 'active',
      toState: 'purged',
      actor: 'hook',
    });
    const matching = makeEvictionPayload({
      substrate: 'memory',
      motivo: 'security',
      fromState: 'active',
      toState: 'purged',
      actor: 'hook',
    });
    expect(matchesPayload(spec, matching)).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ ...matching.data, actor: 'user' }))).toBe(
      false,
    );
  });
});

describe('Eviction matcher: event isolation', () => {
  // The matcher fields only narrow on Eviction events; specs
  // declared for other events are unaffected, and a hook with an
  // Eviction matcher doesn't accidentally apply to a tool event.
  test('Eviction matcher does not affect a tool event', () => {
    // Same spec WITH Eviction matchers, but its event is Eviction
    // — it must not match a PreToolUse payload regardless of
    // matcher content.
    const spec = makeSpec({ substrate: 'memory' });
    const toolPayload: HookEventPayload = {
      schema: 'v1',
      event: 'PreToolUse',
      sessionId: 'sess-1',
      data: { tool: { name: 'bash', input: { command: 'ls' } } },
    };
    expect(matchesPayload(spec, toolPayload)).toBe(false);
  });

  test('a tool-event hook (different event) does not match Eviction', () => {
    const toolSpec: HookSpec = { ...makeSpec(), event: 'PreToolUse', matcher: { tool: 'bash' } };
    expect(matchesPayload(toolSpec, makeEvictionPayload())).toBe(false);
  });

  test('tool matcher on an Eviction spec is silently ignored (operator misconfig)', () => {
    // Post-1.2 review H1: previously, a `tool` matcher set on an
    // Eviction-event spec would suppress the hook (specMatches
    // returned false because toolName=null). That made operator
    // typos invisible. Fix: tool matcher is a no-op on non-tool
    // payloads; the rest of the matcher chain (substrate, etc.)
    // still narrows.
    const spec = makeSpec({ tool: 'bash', substrate: 'memory' });
    expect(matchesPayload(spec, makeEvictionPayload({ substrate: 'memory' }))).toBe(true);
    expect(matchesPayload(spec, makeEvictionPayload({ substrate: 'policy' }))).toBe(false);
  });

  test('Eviction matcher fields on a tool-event spec are silently ignored', () => {
    // Post-1.2 review M3: an operator who sets eviction matcher
    // fields on a PostToolUse spec (cross-event nonsense) should
    // see the hook still run for tool events — the eviction
    // matcher is a no-op on non-Eviction payloads. Mirrors the
    // tool-matcher-on-eviction-event behavior above.
    const toolSpec: HookSpec = {
      ...makeSpec(),
      event: 'PostToolUse',
      matcher: { substrate: 'memory', motivo: 'security' },
    };
    const toolPayload: HookEventPayload = {
      schema: 'v1',
      event: 'PostToolUse',
      sessionId: 'sess-1',
      data: {
        tool: { name: 'write_file', input: { path: '/x' }, output: 'ok', failed: false },
      },
    };
    expect(matchesPayload(toolSpec, toolPayload)).toBe(true);
  });
});
