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

  describe('hooks_snapshot (migration 020)', () => {
    test('round-trips a non-empty hook chain', () => {
      const parent = seedSession();
      const child = seedSession(parent.id);
      const hooks = [
        {
          layer: 'enterprise' as const,
          sourcePath: '/etc/agent/hooks.toml',
          event: 'PreToolUse' as const,
          matcher: { tool: 'bash' as const },
          command: 'audit-bash {{tool.input.command}}',
          timeoutMs: 5000,
          failClosed: true,
          locked: true,
          entryIndex: 0,
        },
        {
          layer: 'project' as const,
          sourcePath: '/p/.agent/hooks.toml',
          event: 'PostToolUse' as const,
          matcher: { tool: 'write_file' as const },
          command: 'lint {{tool.input.path}}',
          timeoutMs: 3000,
          failClosed: false,
          locked: false,
          entryIndex: 0,
        },
      ];
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/p/.agent/agents/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
        hooksSnapshot: hooks,
      });
      const run = getSubagentRun(db, child.id);
      expect(run?.hooksSnapshot).toEqual(hooks);
    });

    test('omitting hooksSnapshot lands as null (legacy fallback discriminator)', () => {
      // The child reads `hooksSnapshot === null` as the signal
      // to fall back to disk re-resolve. Programmatic callers
      // that don't model the snapshot must produce exactly
      // that shape — distinct from the authoritative
      // empty-array case below.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'r',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: 'h',
        systemPrompt: 'p',
        toolsWhitelist: [],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0,
      });
      const run = getSubagentRun(db, child.id);
      expect(run?.hooksSnapshot).toBeNull();
    });

    test('explicit empty hooksSnapshot ([]) round-trips as authoritative empty', () => {
      // Distinct from null. The child treats this as "parent
      // resolved its chain and got zero hooks" and runs WITHOUT
      // hooks — does NOT re-resolve from disk. This is the
      // load-bearing behavior the previous `length > 0` check
      // collapsed; the discriminator is the wire's job.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'r',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: 'h',
        systemPrompt: 'p',
        toolsWhitelist: [],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0,
        hooksSnapshot: [],
      });
      const run = getSubagentRun(db, child.id);
      expect(run?.hooksSnapshot).toEqual([]);
      // Critically NOT null — the discriminator must survive.
      expect(run?.hooksSnapshot).not.toBeNull();
    });

    test('malformed hooks_snapshot JSON parses as null (defensive)', () => {
      // A corrupt snapshot must not crash audit listings. We
      // fall back to `null` (NOT `[]`) so the child takes the
      // legacy disk-re-resolve path — a corrupt row should
      // NOT silently disable hook enforcement, which `[]`
      // (authoritative empty) would do.
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, hooks_snapshot, captured_at)
         VALUES (?, 'explore', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not-json', 0)`,
      ).run(child.id);
      const run = getSubagentRun(db, child.id);
      expect(run?.hooksSnapshot).toBeNull();
    });

    test('non-array hooks_snapshot parses as null (shape guard)', () => {
      // Parser refuses anything that isn't an array of objects.
      // `null` here so corrupt rows take the legacy disk path
      // rather than silently skipping hooks via `[]`.
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, hooks_snapshot, captured_at)
         VALUES (?, 'explore', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '{"oops":1}', 0)`,
      ).run(child.id);
      const run = getSubagentRun(db, child.id);
      expect(run?.hooksSnapshot).toBeNull();
    });
  });

  describe('tool_restrictions (migration 024)', () => {
    test('round-trips a non-empty restrictions map', () => {
      // Author declares both bash gates and write_file path gates.
      // Snapshot must preserve both shapes verbatim — the child's
      // wrapper consults each entry, and a normalization pass here
      // would silently relax / drop a rule.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'refactor',
        scope: 'project',
        sourcePath: '/p/.agent/agents/refactor.md',
        sourceSha256: 'b'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['bash', 'write_file'],
        budgetMaxSteps: 10,
        budgetMaxCostUsd: 0.5,
        toolRestrictions: {
          bash: { allow: ['git diff *', 'rg *'], deny: ['rm -rf *'] },
          write_file: { allowPaths: ['src/**'], denyPaths: ['src/secret/**'] },
        },
      });
      const run = getSubagentRun(db, child.id);
      expect(run?.toolRestrictions).toEqual({
        bash: { allow: ['git diff *', 'rg *'], deny: ['rm -rf *'] },
        write_file: { allowPaths: ['src/**'], denyPaths: ['src/secret/**'] },
      });
    });

    test('omitting toolRestrictions lands as null', () => {
      // Legacy / programmatic callers without a restrictions block
      // must end up with `null` so the child runtime treats the row
      // as "no snapshot, no gate". `{}` would also be a passthrough
      // at runtime but is reserved for the explicit empty case.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: 'c'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.toolRestrictions).toBeNull();
    });

    test('explicit empty {} round-trips as authoritative empty', () => {
      // Distinguishable from `null` in audit even though both
      // become passthrough at runtime. Author who deliberately
      // declared an empty restrictions block in their .md gets
      // `{}` back, not `null`.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'minimal',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: 'd'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        toolRestrictions: {},
      });
      expect(getSubagentRun(db, child.id)?.toolRestrictions).toEqual({});
    });

    test('corrupt JSON in tool_restrictions falls back to null', () => {
      // Storage corruption (extremely unlikely on TEXT) must not
      // silently disable gates — `null` engages the legacy "no
      // snapshot" branch in the child, which simply applies no
      // gate. That is identical to the corrupt-row case for
      // purposes of safety: the row is unusable, treat as "no
      // snapshot" rather than "everything allowed".
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, tool_restrictions, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '{not json', 0)`,
      ).run(child.id);
      const run = getSubagentRun(db, child.id);
      expect(run?.toolRestrictions).toBeNull();
    });

    test('non-mapping shape (array) falls back to null', () => {
      // Defensive: an array would parse but fail the
      // `typeof === 'object' && !Array.isArray` guard. Important
      // because `JSON.parse('[]')` is structurally valid but the
      // restrictions surface is a map of tool names; treating the
      // array as a map would silently drop every rule.
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, tool_restrictions, captured_at)
         VALUES (?, 'array', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '[]', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.toolRestrictions).toBeNull();
    });
  });

  describe('sampling (migration 025)', () => {
    test('round-trips a full sampling override map', () => {
      // Mirrors the canonical playbook frontmatter shape: every
      // field the loader normalizes (camelCase rename of the
      // YAML snake_case) must survive the JSON round-trip
      // unchanged. The child wraps these values into harness
      // config + GenerateRequest verbatim, so a normalization
      // pass here would silently drift the model's actual
      // generation parameters from what the .md declared.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'threat-model',
        scope: 'project',
        sourcePath: '/p/.agent/agents/threat-model.md',
        sourceSha256: 'e'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 25,
        budgetMaxCostUsd: 1.5,
        sampling: {
          temperature: 0.2,
          topP: 0.9,
          maxTokens: 4096,
          thinkingBudget: 4000,
          seedInEval: true,
        },
      });
      expect(getSubagentRun(db, child.id)?.sampling).toEqual({
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 4096,
        thinkingBudget: 4000,
        seedInEval: true,
      });
    });

    test('omitting sampling lands as null', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: 'f'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.sampling).toBeNull();
    });

    test('explicit empty {} round-trips as authoritative empty', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'minimal',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '0'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        sampling: {},
      });
      expect(getSubagentRun(db, child.id)?.sampling).toEqual({});
    });

    test('partial override (just temperature) round-trips with absent fields stripped', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'partial',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '1'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        sampling: { temperature: 0.7 },
      });
      const run = getSubagentRun(db, child.id);
      expect(run?.sampling).toEqual({ temperature: 0.7 });
      expect(run?.sampling?.topP).toBeUndefined();
      expect(run?.sampling?.maxTokens).toBeUndefined();
    });

    test('corrupt JSON in sampling falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, sampling, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not json', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.sampling).toBeNull();
    });

    test('non-mapping shape (array) falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, sampling, captured_at)
         VALUES (?, 'array', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '[]', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.sampling).toBeNull();
    });
  });

  describe('reference_paths (migration 026)', () => {
    test('round-trips a non-empty reference list in declared order', () => {
      // Order matters for the rendered block; the audit row
      // preserves the author's order verbatim. Test pins this.
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'security-audit',
        scope: 'project',
        sourcePath: '/p/.agent/agents/security-audit.md',
        sourceSha256: '2'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        references: ['THREAT_MODELING.md', 'OPSEC.md', 'CRYPTOGRAPHY.md'],
      });
      expect(getSubagentRun(db, child.id)?.references).toEqual([
        'THREAT_MODELING.md',
        'OPSEC.md',
        'CRYPTOGRAPHY.md',
      ]);
    });

    test('omitting references lands as null', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '3'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.references).toBeNull();
    });

    test('explicit empty [] round-trips as authoritative empty', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'minimal',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '4'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        references: [],
      });
      expect(getSubagentRun(db, child.id)?.references).toEqual([]);
    });

    test('corrupt JSON falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, reference_paths, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not json', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.references).toBeNull();
    });

    test('non-string entries fall back to null', () => {
      // The runtime renders each entry into a markdown bullet —
      // a non-string would either crash the renderer or produce
      // a `[object Object]` line. Defensive parse rejects the
      // whole row as malformed rather than silently dropping
      // bad entries.
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, reference_paths, captured_at)
         VALUES (?, 'mixed', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '["a", 42]', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.references).toBeNull();
    });

    test('non-array shape falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, reference_paths, captured_at)
         VALUES (?, 'object', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '{"x":1}', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.references).toBeNull();
    });
  });

  describe('output_schema (migration 027)', () => {
    test('round-trips a shorthand schema', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'review',
        scope: 'project',
        sourcePath: '/p',
        sourceSha256: '5'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        outputSchema: { summary: 'string', blockers: 'array' },
      });
      expect(getSubagentRun(db, child.id)?.outputSchema).toEqual({
        summary: 'string',
        blockers: 'array',
      });
    });

    test('round-trips a JSON Schema-style mapping', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'threat-model',
        scope: 'project',
        sourcePath: '/p',
        sourceSha256: '6'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
      });
      expect(getSubagentRun(db, child.id)?.outputSchema).toEqual({
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      });
    });

    test('omitting outputSchema lands as null', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '7'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.outputSchema).toBeNull();
    });

    test('corrupt JSON falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, output_schema, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not json', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.outputSchema).toBeNull();
    });

    test('non-mapping shape falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, output_schema, captured_at)
         VALUES (?, 'array', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '[1,2,3]', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.outputSchema).toBeNull();
    });
  });

  describe('context_recipe (migration 028)', () => {
    test('round-trips a non-empty recipe', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'security-audit',
        scope: 'project',
        sourcePath: '/p',
        sourceSha256: '8'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        contextRecipe: {
          memoryFilter: ['security', 'reference'],
          stepReflection: 'terse',
          clarifyMode: 'on_high_blast',
          goalReinjectionEveryNSteps: 4,
        },
      });
      expect(getSubagentRun(db, child.id)?.contextRecipe).toEqual({
        memoryFilter: ['security', 'reference'],
        stepReflection: 'terse',
        clarifyMode: 'on_high_blast',
        goalReinjectionEveryNSteps: 4,
      });
    });

    test('omitting contextRecipe lands as null', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '9'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.contextRecipe).toBeNull();
    });

    test('corrupt JSON falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, context_recipe, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not json', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.contextRecipe).toBeNull();
    });
  });

  // Slice 95 — PERMISSION_ENGINE.md §10.1 effective envelope
  // persistence. The tri-state (undefined / [] / [...]) MUST
  // survive round-trip without conflation: collapsing undefined
  // and `[]` would silently flip a pure-LLM child to a
  // parent-inherited envelope, re-opening the R11 P0-3 gap.
  describe('effective_capabilities (migration 040)', () => {
    test('omitting effectiveCapabilities lands as null', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '8'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
      });
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toBeNull();
    });

    test('empty array round-trips as empty array (pure-LLM bound)', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '7'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        effectiveCapabilities: [],
      });
      // CRITICAL: `[]` must be distinguishable from `null`. The
      // pure-LLM contract collapses if the column reads back as
      // null (no constraint) when the parent meant "no side-
      // effect caps".
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toEqual([]);
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).not.toBeNull();
    });

    test('non-empty array round-trips verbatim', () => {
      const child = seedSession(seedSession().id);
      insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'user',
        sourcePath: '/p',
        sourceSha256: '6'.repeat(64),
        systemPrompt: 'body',
        toolsWhitelist: ['read_file'],
        budgetMaxSteps: 1,
        budgetMaxCostUsd: 0.01,
        effectiveCapabilities: ['read-fs:src/**', 'exec:shell'],
      });
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toEqual([
        'read-fs:src/**',
        'exec:shell',
      ]);
    });

    test('corrupt JSON falls back to null (not to []) — safer to surface as no-snapshot', () => {
      // Falling back to `[]` would silently FLIP the child to
      // pure-LLM (deny everything) on a corrupt row — surprising
      // and hard to diagnose. Falling back to `null` keeps the
      // child running under root semantics, matching the legacy
      // / undefined behavior; the corrupt row is visible in
      // audit listings.
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, effective_capabilities, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', 'not json', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toBeNull();
    });

    test('wrong-shape JSON (object instead of array) falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, effective_capabilities, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '{"x":1}', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toBeNull();
    });

    test('mixed-type array (number entry) falls back to null', () => {
      const child = seedSession(seedSession().id);
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            policy_snapshot, effective_capabilities, captured_at)
         VALUES (?, 'corrupt', 'user', '/p', 'h', 'p', '[]', 1, 0, '{}', '["read-fs:**", 42]', 0)`,
      ).run(child.id);
      expect(getSubagentRun(db, child.id)?.effectiveCapabilities).toBeNull();
    });
  });
});
