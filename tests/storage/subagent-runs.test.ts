import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { getSubagentRun, insertSubagentRun } from '../../src/storage/repos/subagent-runs.ts';

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const seedSession = (parentId?: string) =>
  createSession(db, {
    model: 'm',
    cwd: '/p',
    ...(parentId !== undefined ? { parentSessionId: parentId } : {}),
  });

describe('subagent_runs repo', () => {
  test('insert + get round-trip', () => {
    const parent = seedSession();
    const child = seedSession(parent.id);
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/p/.agent/agents/explore.md',
      sourceSha256: 'a'.repeat(64),
      systemPrompt: 'You are explore.',
      toolsWhitelist: ['read_file', 'grep', 'glob'],
      budgetMaxSteps: 20,
      budgetMaxCostUsd: 0.5,
      budgetMaxWallMs: 60_000,
      capturedAt: 1_700_000_000_000,
    });
    const run = getSubagentRun(db, child.id);
    expect(run).not.toBeNull();
    expect(run?.sessionId).toBe(child.id);
    expect(run?.name).toBe('explore');
    expect(run?.scope).toBe('project');
    expect(run?.sourcePath).toBe('/p/.agent/agents/explore.md');
    expect(run?.sourceSha256).toBe('a'.repeat(64));
    expect(run?.systemPrompt).toBe('You are explore.');
    expect(run?.toolsWhitelist).toEqual(['read_file', 'grep', 'glob']);
    expect(run?.budgetMaxSteps).toBe(20);
    expect(run?.budgetMaxCostUsd).toBe(0.5);
    expect(run?.budgetMaxWallMs).toBe(60_000);
    expect(run?.capturedAt).toBe(1_700_000_000_000);
  });

  test('budgetMaxWallMs is null when omitted at insert', () => {
    // The wall-clock cap is optional in SubagentBudget; the
    // snapshot row mirrors that with a nullable column. A
    // definition without max_wall_clock_ms snapshots as null,
    // not as a sentinel like 0 (which would conflict with the
    // loader's own "must be positive" rule).
    const child = seedSession(seedSession().id);
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'review',
      scope: 'user',
      sourcePath: '/u/review.md',
      sourceSha256: 'b'.repeat(64),
      systemPrompt: 'review',
      toolsWhitelist: [],
      budgetMaxSteps: 5,
      budgetMaxCostUsd: 0,
    });
    expect(getSubagentRun(db, child.id)?.budgetMaxWallMs).toBeNull();
  });

  test('returns null for unknown session id', () => {
    expect(getSubagentRun(db, 'nope')).toBeNull();
  });

  test('cascade: deleting the session deletes its snapshot', () => {
    // Lifecycle contract: snapshot belongs to the child's audit
    // trail (not the parent's). Deleting the child session row
    // cascades the snapshot away. A future retention purge of
    // child sessions must cleanly drop both halves.
    const child = seedSession(seedSession().id);
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/p/.agent/agents/explore.md',
      sourceSha256: 'c'.repeat(64),
      systemPrompt: 'p',
      toolsWhitelist: ['read_file'],
      budgetMaxSteps: 1,
      budgetMaxCostUsd: 0,
    });
    expect(getSubagentRun(db, child.id)).not.toBeNull();
    db.query('DELETE FROM sessions WHERE id = ?').run(child.id);
    expect(getSubagentRun(db, child.id)).toBeNull();
  });

  test('parent purge leaves child snapshot intact (NOT cascade)', () => {
    // The orphan-survives-parent-purge property from migration
    // 010 must extend to the snapshot. ON DELETE SET NULL on the
    // session's parent_session_id MUST NOT cascade through to
    // the snapshot — the snapshot belongs to the child, and the
    // child still exists post-purge.
    const parent = seedSession();
    const child = seedSession(parent.id);
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/p/.agent/agents/explore.md',
      sourceSha256: 'd'.repeat(64),
      systemPrompt: 'p',
      toolsWhitelist: ['read_file'],
      budgetMaxSteps: 1,
      budgetMaxCostUsd: 0,
    });
    db.query('DELETE FROM sessions WHERE id = ?').run(parent.id);
    const run = getSubagentRun(db, child.id);
    expect(run).not.toBeNull();
    expect(run?.name).toBe('explore');
  });

  test('CHECK constraint rejects invalid scope', () => {
    const child = seedSession(seedSession().id);
    expect(() =>
      db.exec(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
         VALUES ('${child.id}', 'x', 'BOGUS', '/p', 'h', 'p', '[]', 1, 0, 0)`,
      ),
    ).toThrow();
  });

  test('toolsWhitelist round-trips JSON correctly', () => {
    // Defense for the JSON serialization path. Empty array,
    // single-element, multi-element. If the parser flips to
    // CSV or some other shape later, these tests catch it.
    const child = seedSession(seedSession().id);
    const cases: Array<[string, string[]]> = [
      ['empty', []],
      ['single', ['read_file']],
      ['multi', ['read_file', 'grep', 'glob']],
    ];
    for (const [_label, tools] of cases) {
      // Reset the row by deleting + re-inserting under same id
      // (cleaner than seeding distinct sessions per case).
      db.query('DELETE FROM subagent_runs WHERE session_id = ?').run(child.id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/u/x.md',
        sourceSha256: 'e'.repeat(64),
        systemPrompt: 'p',
        toolsWhitelist: tools,
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0,
      });
      expect(getSubagentRun(db, child.id)?.toolsWhitelist).toEqual(tools);
    }
  });

  test('insertSubagentRun throws on duplicate session_id (PK conflict)', () => {
    // The repo does NOT use INSERT OR REPLACE. A second insert
    // for the same session_id raises SQLITE_CONSTRAINT_PRIMARYKEY.
    // The runtime's catch wraps this as auditFailure rather than
    // letting it propagate, but the contract at the repo level
    // is "fail loudly on duplicate" — locking it here so a future
    // refactor that flips to OR REPLACE doesn't pass silently.
    const child = seedSession(seedSession().id);
    const input = {
      sessionId: child.id,
      name: 'explore',
      scope: 'user' as const,
      sourcePath: '/u/x.md',
      sourceSha256: 'f'.repeat(64),
      systemPrompt: 'p',
      toolsWhitelist: ['read_file'],
      budgetMaxSteps: 1,
      budgetMaxCostUsd: 0,
    };
    insertSubagentRun(db, input);
    expect(() => insertSubagentRun(db, input)).toThrow();
  });

  test('malformed tools_whitelist JSON parses as empty array (defensive)', () => {
    // Storage corruption is unlikely (INSERT-once column, TEXT
    // is opaque to SQLite), but a malformed JSON would otherwise
    // crash audit listings mid-iteration. The repo coerces to
    // empty so the row stays loadable.
    const child = seedSession(seedSession().id);
    db.query(
      `INSERT INTO subagent_runs
         (session_id, name, scope, source_path, source_sha256, system_prompt,
          tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
       VALUES (?, 'explore', 'user', '/p', 'h', 'p', 'not-json', 1, 0, 0)`,
    ).run(child.id);
    const run = getSubagentRun(db, child.id);
    expect(run?.toolsWhitelist).toEqual([]);
  });
});
