import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListSessions } from '../../src/cli/list-sessions.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../src/storage/repos/sessions.ts';

let tempDir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'forja-list-sessions-'));
  dbPath = join(tempDir, 'agent.sqlite');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runListSessions', () => {
  test('empty DB prints "no sessions found"', () => {
    const out: string[] = [];
    const code = runListSessions({
      json: false,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('no sessions');
  });

  test('json mode emits one NDJSON line per session, newest first', () => {
    const a = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    const b = createSession(db, { model: 'mock/b', cwd: '/p', startedAt: 2000 });
    appendMessage(db, { sessionId: a.id, role: 'user', content: 'first prompt' });
    appendMessage(db, { sessionId: b.id, role: 'user', content: 'second prompt' });
    completeSession(db, a.id, 'done', 0.0123, true);

    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '{}') as { id: string; status: string };
    const second = JSON.parse(lines[1] ?? '{}') as { id: string; status: string };
    expect(first.id).toBe(b.id); // newest first
    expect(first.status).toBe('running');
    expect(second.id).toBe(a.id);
    expect(second.status).toBe('done');
  });

  test('json mode includes prompt_preview from first user message', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'list the source files' });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    expect(item.prompt_preview).toBe('list the source files');
  });

  test('truncates long prompt_preview', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    const longPrompt = 'x'.repeat(200);
    appendMessage(db, { sessionId: s.id, role: 'user', content: longPrompt });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    // Truncated to 80 with the ellipsis sentinel.
    expect(item.prompt_preview.length).toBeLessThanOrEqual(80);
    expect(item.prompt_preview.endsWith('…')).toBe(true);
  });

  test('table mode prints a header and one row per session', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'a prompt' });
    const out: string[] = [];
    runListSessions({ json: false, dbOverride: db, out: (s) => out.push(s) });
    const text = out.join('');
    expect(text).toContain('STARTED');
    expect(text).toContain(s.id);
    expect(text).toContain('a prompt');
  });

  test('respects custom limit', () => {
    for (let i = 0; i < 5; i++) {
      const s = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 + i });
      appendMessage(db, { sessionId: s.id, role: 'user', content: `p${i}` });
    }
    const out: string[] = [];
    runListSessions({ json: true, limit: 3, dbOverride: db, out: (s) => out.push(s) });
    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  test('handles a session with no messages (preview is empty string)', () => {
    // Race window: session created but prompt not yet appended.
    // The listing must not crash.
    createSession(db, { model: 'mock/a', cwd: '/p' });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as { prompt_preview: string };
    expect(item.prompt_preview).toBe('');
  });

  test('subagent rows are hidden by default', () => {
    // The dominant case is "show me my own runs". A user who
    // invoked `task()` should see ONE row, not the parent + N
    // subagent children inflating the listing. The default omits
    // children; --include-subagents fans them in.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent prompt' });
    createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const item = JSON.parse(lines[0] ?? '{}') as {
      id: string;
      parent_session_id: string | null;
    };
    expect(item.id).toBe(parent.id);
    expect(item.parent_session_id).toBeNull();
  });

  test('--include-subagents fans children under their parent', () => {
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent prompt' });
    const c1 = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    const c2 = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1200,
    });
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    // Order: parent first (newest of the top-level pool), then its
    // children oldest-first.
    const parsed = lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          parent_session_id: string | null;
          depth: number;
        },
    );
    expect(parsed[0]?.id).toBe(parent.id);
    expect(parsed[0]?.parent_session_id).toBeNull();
    expect(parsed[0]?.depth).toBe(0);
    expect(parsed[1]?.id).toBe(c1.id);
    expect(parsed[1]?.parent_session_id).toBe(parent.id);
    expect(parsed[1]?.depth).toBe(1);
    expect(parsed[2]?.id).toBe(c2.id);
    expect(parsed[2]?.parent_session_id).toBe(parent.id);
    expect(parsed[2]?.depth).toBe(1);
  });

  test('JSON output always includes cumulative_cost_usd (leaf row equals own cost)', () => {
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'p' });
    completeSession(db, s.id, 'done', 0.0042, true);
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as {
      cost_usd: number;
      cumulative_cost_usd: number;
    };
    expect(item.cost_usd).toBeCloseTo(0.0042, 9);
    expect(item.cumulative_cost_usd).toBeCloseTo(0.0042, 9);
  });

  test('JSON cumulative_cost_usd sums parent + descendants', () => {
    // O1 fix: user shouldn't have to mentally sum children's cost.
    // Top-level row reports cumulative including subagents; the
    // user reads spend at a glance without --include-subagents.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    completeSession(db, parent.id, 'done', 0.001, true);
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    completeSession(db, child.id, 'done', 0.05, true);
    const grandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: child.id,
    });
    completeSession(db, grandchild.id, 'done', 0.1, true);
    const out: string[] = [];
    runListSessions({ json: true, dbOverride: db, out: (s) => out.push(s) });
    const item = JSON.parse(out[0] ?? '{}') as {
      cost_usd: number;
      cumulative_cost_usd: number;
    };
    expect(item.cost_usd).toBeCloseTo(0.001, 9);
    // 0.001 (parent) + 0.05 (child) + 0.1 (grandchild) = 0.151
    expect(item.cumulative_cost_usd).toBeCloseTo(0.151, 9);
  });

  test('table mode annotates parent rows with descendant cost', () => {
    // The table delta shows what the children added on top of the
    // row's own spend. Format: "$0.0010 +$0.1500" (own + descendants).
    // Rows with no billed descendants render plain ("$0.0010").
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    completeSession(db, parent.id, 'done', 0.001, true);
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    completeSession(db, child.id, 'done', 0.15, true);
    const out: string[] = [];
    runListSessions({ json: false, dbOverride: db, out: (s) => out.push(s) });
    const text = out.join('');
    expect(text).toContain('$0.0010 +$0.1500');
  });

  test('table mode annotates intermediate rows with their own subtree cumulative', () => {
    // Intermediate rows (depth>0 with their OWN descendants) must
    // surface accurate cumulative — this is the correctness fix
    // that replaced the prior "echo cost_usd at depth>0" shortcut.
    // Without this, JSON consumers reading per-node rollups got
    // child cost_usd reported as cumulative even when grandchildren
    // billed, masking real spend.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    completeSession(db, parent.id, 'done', 0.001, true);
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    completeSession(db, child.id, 'done', 0.05, true);
    const grandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: child.id,
      startedAt: 1200,
    });
    completeSession(db, grandchild.id, 'done', 0.1, true);
    const out: string[] = [];
    runListSessions({
      json: false,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const text = out.join('');
    // Top-level row shows full subtree cumulative ($0.05 + $0.10).
    expect(text).toContain('$0.0010 +$0.1500');
    // Intermediate (child) row shows ITS OWN subtree cumulative
    // ($0.10 from the grandchild) — this is the correctness fix.
    expect(text).toContain('$0.0500 +$0.1000');
    // Leaf grandchild has no descendants → no annotation, plain cost.
    expect(text).toMatch(/\$0\.1000\s{2,}/);
  });

  test('table mode skips annotation when descendants billed zero', () => {
    // Subagent rows that exist but didn't bill (zero cost) must
    // not trigger the annotation — otherwise every parent of a
    // free-mock subagent would render a misleading "+$0.0000".
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    completeSession(db, parent.id, 'done', 0.001, true);
    createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
    });
    const out: string[] = [];
    runListSessions({ json: false, dbOverride: db, out: (s) => out.push(s) });
    const text = out.join('');
    expect(text).toContain('$0.0010');
    expect(text).not.toContain('+$');
  });

  test('JSON cumulative_cost_usd includes descendants on intermediate (depth>0) rows', () => {
    // Regression for the M1 fix that overcorrected — earlier
    // `depth === 0 ? cumulative : own` underreported subtree
    // cost on intermediate rows (parent → child → grandchild).
    // JSON consumers doing programmatic per-node rollups (e.g.,
    // billing reports filtered by subagent type) would see the
    // child report only its own cost, missing the grandchild's
    // contribution. Fix: cumulative computed for every node via
    // post-order walk in fanSubtree.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    completeSession(db, parent.id, 'done', 0.001, true);
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    completeSession(db, child.id, 'done', 0.05, true);
    const grandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: child.id,
      startedAt: 1200,
    });
    completeSession(db, grandchild.id, 'done', 0.1, true);

    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const rows = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { id: string; cost_usd: number; cumulative_cost_usd: number });
    expect(rows).toHaveLength(3);
    // Parent: own 0.001 + child 0.05 + grandchild 0.1 = 0.151
    expect(rows[0]?.id).toBe(parent.id);
    expect(rows[0]?.cumulative_cost_usd).toBeCloseTo(0.151, 9);
    // Intermediate child: own 0.05 + grandchild 0.1 = 0.15
    // Pre-fix this reported just 0.05 (own cost), masking the
    // grandchild's contribution to the subtree.
    expect(rows[1]?.id).toBe(child.id);
    expect(rows[1]?.cumulative_cost_usd).toBeCloseTo(0.15, 9);
    // Leaf grandchild: own = cumulative.
    expect(rows[2]?.id).toBe(grandchild.id);
    expect(rows[2]?.cumulative_cost_usd).toBeCloseTo(0.1, 9);
  });

  test('JSON output exposes subagent_run fingerprint for subagent rows', () => {
    // Audit surface: the listing carries name + source_sha256 of
    // the captured definition so a forensic walk doesn't need a
    // separate query. Detail (system prompt, full toolset, budget)
    // lives in the subagent_runs row reachable via the same id.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: parent.startedAt + 1,
    });
    // Seed the snapshot directly (no harness in this test).
    db.query(
      `INSERT INTO subagent_runs
         (session_id, name, scope, source_path, source_sha256, system_prompt,
          tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
       VALUES (?, 'explore', 'project', '/p/.forja/playbooks/explore.md',
               '${'a'.repeat(64)}', 'You are explore.', '["read_file"]', 5, 0.01, 0)`,
    ).run(child.id);

    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const [parentRow, childRow] = lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          subagent_run: { name: string; source_sha256: string } | null;
        },
    );
    // Top-level row carries a null fingerprint (not a subagent).
    expect(parentRow?.id).toBe(parent.id);
    expect(parentRow?.subagent_run).toBeNull();
    // Child row carries the captured fingerprint.
    expect(childRow?.id).toBe(child.id);
    expect(childRow?.subagent_run?.name).toBe('explore');
    expect(childRow?.subagent_run?.source_sha256).toBe('a'.repeat(64));
  });

  test('subagent row without a snapshot reports subagent_run: null (defensive)', () => {
    // A subagent row with no snapshot can exist in two cases: a
    // pre-migration-012 row (no snapshot was captured at the
    // time), or a future bug that created the session but failed
    // to insert the snapshot. The listing must not crash; emit
    // null and let the user notice the missing fingerprint.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: parent.startedAt + 1,
    });
    // No subagent_runs row inserted.
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    const childRow = JSON.parse(lines[1] ?? '{}') as {
      id: string;
      subagent_run: unknown;
    };
    expect(childRow.id).toBe(child.id);
    expect(childRow.subagent_run).toBeNull();
  });

  test('--include-subagents recursively walks the full descendant tree', () => {
    // Recursion contract: subagents can spawn subagents up to
    // MAX_SUBAGENT_DEPTH=4. The listing must surface all of them
    // when --include-subagents is set, not just the immediate
    // children — otherwise a debugging session inspecting a deep
    // playbook chain can't find the grandchild's session id for
    // follow-up commands. DFS order: parent, then full subtree
    // (oldest sibling first), then next top-level row.
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: 1100,
    });
    const grandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: child.id,
      startedAt: 1200,
    });
    const greatGrandchild = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: grandchild.id,
      startedAt: 1300,
    });
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    const parsed = lines.map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          parent_session_id: string | null;
          depth: number;
        },
    );
    expect(parsed[0]?.id).toBe(parent.id);
    expect(parsed[0]?.depth).toBe(0);
    expect(parsed[1]?.id).toBe(child.id);
    expect(parsed[1]?.depth).toBe(1);
    expect(parsed[2]?.id).toBe(grandchild.id);
    expect(parsed[2]?.depth).toBe(2);
    expect(parsed[3]?.id).toBe(greatGrandchild.id);
    expect(parsed[3]?.depth).toBe(3);
  });

  test('--include-subagents handles a self-referential row without looping', () => {
    // Defense in depth: parent_session_id is a FK but SQLite does
    // NOT prevent a row from referencing itself. A corrupt write
    // (or a future migration accident) could insert a self-loop;
    // the listing must not deadlock on it. The `seen` guard in
    // fanOut catches the cycle on the second visit and emits the
    // row exactly once.
    const s = createSession(db, { model: 'mock/a', cwd: '/p' });
    db.query('UPDATE sessions SET parent_session_id = id WHERE id = ?').run(s.id);
    appendMessage(db, { sessionId: s.id, role: 'user', content: 'looped' });
    const out: string[] = [];
    runListSessions({
      json: true,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    // The row is is_subagent=false (created as top-level) so it
    // surfaces as a root. fanOut visits it, then walks children:
    // listChildSessions returns the same row (self-reference),
    // but the seen guard short-circuits before recursing. Result:
    // exactly one line, no infinite loop, no duplicates.
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { id: string; depth: number };
    expect(parsed.id).toBe(s.id);
    expect(parsed.depth).toBe(0);
  });

  test('--include-subagents truncates whole subtrees to fit limit', () => {
    // Cap-on-top-level was the bug: with --include-subagents, the
    // limit only governed parents and the fan-out could multiply
    // row count without bound. The fix: cap is on the FINAL row
    // count, and we only include a parent's subtree if it fits
    // entirely (mid-tree cuts hide children behind a visible
    // parent and confuse the user).
    //
    // Setup: 3 top-level parents, each with 2 children. Limit=3.
    // Parent #1's subtree (1 + 2 = 3 rows) fits exactly. Parent
    // #2 would overflow (3 + 3 = 6 > 3) so the listing stops at
    // parent #1's subtree. Parents #2 and #3 are reported as
    // omitted on stderr.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const parent = createSession(db, {
        model: 'mock/a',
        cwd: '/p',
        startedAt: 1000 - i, // newest first
      });
      ids.push(parent.id);
      for (let j = 0; j < 2; j++) {
        createSession(db, {
          model: 'mock/a',
          cwd: '/p',
          parentSessionId: parent.id,
          startedAt: 1000 - i + j + 1,
        });
      }
    }
    const out: string[] = [];
    const err: string[] = [];
    runListSessions({
      json: true,
      limit: 3,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // parent #1 + its 2 children
    const parsed = lines.map((l) => JSON.parse(l) as { id: string; depth: number });
    expect(parsed[0]?.id).toBe(ids[0]); // newest parent first
    expect(parsed[0]?.depth).toBe(0);
    expect(parsed[1]?.depth).toBe(1);
    expect(parsed[2]?.depth).toBe(1);

    // Truncation hint surfaces on stderr — non-JSON mode uses it
    // for the human listing too. Here we asked for --json, so the
    // err sink stays the only channel.
    const errOut = err.join('');
    expect(errOut).toContain('truncated to fit limit=3');
    expect(errOut).toContain('2 more top-level sessions omitted');
  });

  test('--include-subagents stops cleanly when the FIRST subtree overflows', () => {
    // Edge case: a single top-level parent has more descendants
    // than the limit. With subtree-atomic semantics we MUST emit
    // zero rows rather than a partial tree (the parent without
    // its children would lie about the structure).
    const parent = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 });
    for (let i = 0; i < 5; i++) {
      createSession(db, {
        model: 'mock/a',
        cwd: '/p',
        parentSessionId: parent.id,
        startedAt: 1001 + i,
      });
    }
    const out: string[] = [];
    const err: string[] = [];
    runListSessions({
      json: true,
      limit: 3,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(out.join('').trim()).toBe('');
    expect(err.join('')).toContain('1 more top-level session omitted');
  });

  test('truncation hint counts ALL omitted parents, not just those in the fetched batch', () => {
    // The fetch caps at `limit`, so a DB with N >> limit top-level
    // sessions returns at most `limit` rows. Without the COUNT(*)
    // fix, the omitted count was computed from `parents.length -
    // parents.indexOf(parent)` which never exceeded `limit`,
    // undercounting the real omission. Now an O(1) COUNT against
    // the same predicate gives accurate diagnostics.
    //
    // Fixture: 30 top-level sessions, limit=5. The 5 newest fit
    // (all leaf rows, no subagents). The hint must say "25
    // omitted", not "0".
    for (let i = 0; i < 30; i++) {
      const s = createSession(db, { model: 'mock/a', cwd: '/p', startedAt: 1000 + i });
      appendMessage(db, { sessionId: s.id, role: 'user', content: `p${i}` });
    }
    const out: string[] = [];
    const err: string[] = [];
    runListSessions({
      json: true,
      limit: 5,
      dbOverride: db,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    const errOut = err.join('');
    expect(errOut).toContain('25 more top-level sessions omitted');
    expect(errOut).toContain('limit=5');
  });

  test('truncation hint accuracy: --include-subagents path also uses total count', () => {
    // Same correctness for the subagent-fan-out path: with N
    // parents in DB but limit=K, we can only fetch K and only
    // emit some subset of those. The hint must compare against N,
    // not K, otherwise an --include-subagents listing that fits
    // every fetched subtree would falsely claim no truncation
    // when N > K.
    //
    // Fixture: 10 top-level (each with 1 child = 2 rows), limit=4.
    // Two parents fit (4 rows). Eight remain — only 2 of those
    // were even fetched (limit=4 fetches 4 parents), but the
    // count must still report 8.
    for (let i = 0; i < 10; i++) {
      const parent = createSession(db, {
        model: 'mock/a',
        cwd: '/p',
        startedAt: 1000 + i * 10,
      });
      appendMessage(db, { sessionId: parent.id, role: 'user', content: `p${i}` });
      createSession(db, {
        model: 'mock/a',
        cwd: '/p',
        parentSessionId: parent.id,
        startedAt: 1001 + i * 10,
      });
    }
    const out: string[] = [];
    const err: string[] = [];
    runListSessions({
      json: true,
      limit: 4,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    const lines = out
      .join('')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(4); // 2 parents × (1 self + 1 child)
    const errOut = err.join('');
    expect(errOut).toContain('8 more top-level sessions omitted');
  });

  test('--include-subagents truncation: no err sink → silent (no throw)', () => {
    // The err sink is optional. When absent, truncation is silent
    // — the listing itself is already correct within the cap.
    // We assert no throw and that the listing renders sensibly
    // (the empty-output case shows the "no sessions found"
    // sentinel because every parent's subtree overflowed).
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    for (let i = 0; i < 5; i++) {
      createSession(db, {
        model: 'mock/a',
        cwd: '/p',
        parentSessionId: parent.id,
        startedAt: 1000 + i,
      });
    }
    const out: string[] = [];
    expect(() =>
      runListSessions({
        json: false,
        limit: 3,
        includeSubagents: true,
        dbOverride: db,
        out: (s) => out.push(s),
        // No err sink wired.
      }),
    ).not.toThrow();
    // Single parent with overflow → 0 data rows → table renderer
    // emits "no sessions found." sentinel.
    expect(out.join('')).toContain('no sessions found');
  });

  test('table mode marks subagent rows with the ↳ indent', () => {
    const parent = createSession(db, { model: 'mock/a', cwd: '/p' });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'p' });
    const child = createSession(db, {
      model: 'mock/a',
      cwd: '/p',
      parentSessionId: parent.id,
      startedAt: parent.startedAt + 1,
    });
    const out: string[] = [];
    runListSessions({
      json: false,
      includeSubagents: true,
      dbOverride: db,
      out: (s) => out.push(s),
    });
    const text = out.join('');
    expect(text).toContain(parent.id);
    expect(text).toContain(`↳ ${child.id}`);
  });
});
