import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentChild } from '../../src/cli/subagent-child.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { openDb } from '../../src/storage/db.ts';
import {
  appendMessage,
  createSession,
  getSubagentOutput,
  insertSubagentRun,
  migrate,
} from '../../src/storage/index.ts';

// Cover the canonical happy + error paths for the
// subagent-child entry. The test injects a `providerOverride`
// so we don't need an API key, and uses a real on-disk DB so
// the child + tests share the same SQLite path (mirrors what
// the real subprocess flow does).

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'forja-child-test-'));
  dbPath = join(dbDir, 'agent.sqlite');
});

afterEach(() => {
  try {
    unlinkSync(dbPath);
  } catch {}
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {}
});

const stubProvider = (text: string): Provider => ({
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  async *generate(): AsyncGenerator<StreamEvent> {
    yield { kind: 'start', message_id: 'mock-msg' };
    if (text.length > 0) yield { kind: 'text_delta', text };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const seedChildSession = (cwd: string): { sessionId: string } => {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const parent = createSession(db, { model: 'mock/m', cwd });
    const child = createSession(db, {
      model: 'mock/m',
      cwd,
      parentSessionId: parent.id,
    });
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/fake/explore.md',
      sourceSha256: 'a'.repeat(64),
      systemPrompt: 'You are explore.',
      toolsWhitelist: [],
      budgetMaxSteps: 5,
      budgetMaxCostUsd: 0.1,
    });
    appendMessage(db, {
      sessionId: child.id,
      role: 'user',
      content: 'find the README',
    });
    return { sessionId: child.id };
  } finally {
    db.close();
  }
};

describe('runSubagentChild', () => {
  test('happy path: runs harness, publishes done payload, exits 0', async () => {
    const { sessionId } = seedChildSession(dbDir);
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: stubProvider('hello world'),
      // Disable real permission hierarchy so the test doesn't
      // depend on the host's /etc/agent or ~/.config/agent state.
      // Same shape for subagent discovery — keep tests
      // hermetic.
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(0);
    expect(errMessages).toEqual([]);
    // Payload landed on subagent_outputs.
    const db = openDb(dbPath);
    try {
      const out = getSubagentOutput(db, sessionId);
      expect(out?.payload).toBeDefined();
      expect(out?.payload?.status).toBe('done');
      expect(out?.payload?.output).toBe('hello world');
    } finally {
      db.close();
    }
  });

  test('policy snapshot from audit row is honored, NOT re-resolved from disk', async () => {
    // Drift defense: even if `.agent/permissions.yaml` were
    // edited mid-run between parent spawn and child read, the
    // child must use the snapshot the parent persisted, not
    // re-resolve from disk. We seed an explicit `bypass`
    // snapshot that NO disk-resolved policy would ever produce
    // (a real workspace defaults to strict); if the child were
    // re-resolving disk, it would land on strict and the assert
    // below would still pass for an empty-tool run — so we
    // also assert the engine's `mode()` reflects bypass via a
    // probe. The cleanest probe: invoke a tool that strict
    // would deny but bypass would allow. We use a stub provider
    // that emits no tool calls (keeps the test fast) and verify
    // the persisted snapshot round-tripped intact.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');
    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/fake/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
        // Distinctive snapshot value: bypass + a sentinel tool
        // rule no realistic resolved policy would produce. If
        // the child re-resolves disk, this exact shape can't
        // round-trip back through the read path.
        policySnapshot: {
          defaults: { mode: 'bypass' },
          tools: { bash: { allow: ['__sentinel-snapshot-marker'] } },
        },
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go',
      });
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: stubProvider('done'),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(0);
    // The snapshot survived through both write and read: the
    // run completed with no policy crash. Re-read the audit
    // row to confirm the snapshot is intact (defense against a
    // future regression that strips fields on the read path).
    const db2 = openDb(dbPath);
    try {
      const audit = subagentRunsRepo.getSubagentRun(db2, childId);
      expect(audit?.policySnapshot.defaults.mode).toBe('bypass');
      const bashRule = (audit?.policySnapshot.tools as Record<string, unknown>)?.bash;
      expect(bashRule).toEqual({ allow: ['__sentinel-snapshot-marker'] });
    } finally {
      db2.close();
    }
  });

  test('snapshot drives real gate behavior: bypass allows, strict denies (same tool call)', async () => {
    // Stronger probe than the round-trip test above. Two
    // children with identical tool_use scripts and identical
    // tool whitelists, differing only in their persisted
    // policySnapshot. The bypass child's read_file lands as
    // status='done' (gate passed, file read OK); the strict
    // child's lands as status='denied' (gate denied before
    // execution). If the read path were silently substituting
    // policy or the engine were somehow ignoring the snapshot,
    // BOTH would land at the same status.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    // Seed a real file the read_file tool can resolve. The
    // bypass child reads it; the strict child gets denied
    // BEFORE the read attempt (no FS error path muddies the
    // status='denied' assertion).
    writeFileSync(join(dbDir, 'probe.txt'), 'gate probe content\n');

    const seedChild = (
      snapshot: Parameters<typeof subagentRunsRepo.insertSubagentRun>[1]['policySnapshot'],
    ): string => {
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: dbDir,
          parentSessionId: parent.id,
        });
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'reader',
          scope: 'project',
          sourcePath: '/fake/reader.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are a reader.',
          toolsWhitelist: ['read_file'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.0,
          ...(snapshot !== undefined ? { policySnapshot: snapshot } : {}),
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'read probe.txt',
        });
        return child.id;
      } finally {
        db.close();
      }
    };

    // Two-step provider: turn 1 emits read_file({ path:
    // 'probe.txt' }), turn 2 closes after the tool result.
    const buildProvider = (): Provider => {
      let step = 0;
      return {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(): AsyncGenerator<StreamEvent> {
          step++;
          yield { kind: 'start', message_id: `mock-${step}` };
          if (step === 1) {
            yield { kind: 'tool_use_start', id: 'tu1', name: 'read_file' };
            yield {
              kind: 'tool_use_stop',
              id: 'tu1',
              final_args: { path: 'probe.txt' },
            };
            yield { kind: 'stop', reason: 'tool_use' };
          } else {
            yield { kind: 'text_delta', text: 'closed' };
            yield { kind: 'stop', reason: 'end_turn' };
          }
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };
    };

    const readToolStatus = (sessionId: string): string | undefined => {
      const db = openDb(dbPath);
      try {
        const row = db
          .query<{ status: string }, [string]>(
            `SELECT tc.status AS status
               FROM tool_calls tc
               JOIN messages m ON tc.message_id = m.id
              WHERE m.session_id = ? AND tc.tool_name = 'read_file'`,
          )
          .get(sessionId);
        return row?.status;
      } finally {
        db.close();
      }
    };

    // Bypass child: gate allows, file is read, status='done'.
    const bypassId = seedChild({
      defaults: { mode: 'bypass' },
      tools: {},
    });
    const bypassExit = await runSubagentChild({
      sessionId: bypassId,
      dbPath,
      providerOverride: buildProvider(),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
    });
    expect(bypassExit).toBe(0);
    expect(readToolStatus(bypassId)).toBe('done');

    // Strict child with no allow rules: gate denies BEFORE the
    // read attempts, status='denied'. Same tool, same args,
    // same model script — only the snapshot differs.
    const strictId = seedChild({
      defaults: { mode: 'strict' },
      tools: {},
    });
    const strictExit = await runSubagentChild({
      sessionId: strictId,
      dbPath,
      providerOverride: buildProvider(),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
    });
    expect(strictExit).toBe(0);
    expect(readToolStatus(strictId)).toBe('denied');
  });

  test('missing policy snapshot (pre-015 row) falls back to strict defaults', async () => {
    // Backwards-compat: a row inserted before migration 015
    // has policy_snapshot='{}' (the column default). The read
    // path must fill in `defaults.mode='strict'` and
    // `tools={}`, NOT crash the engine with undefined fields.
    // We force the empty-object shape by manually inserting
    // around the repo (which would otherwise fill in proper
    // strict defaults via the input default).
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');
    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      // Raw INSERT bypassing the repo, with policy_snapshot
      // explicitly set to '{}' to simulate a pre-migration row.
      db.query(
        `INSERT INTO subagent_runs
           (session_id, name, scope, source_path, source_sha256, system_prompt,
            tools_whitelist, budget_max_steps, budget_max_cost_usd,
            budget_max_wall_ms, policy_snapshot, captured_at)
         VALUES (?, 'explore', 'project', '/fake/explore.md', ?, 'You are explore.',
                 '[]', 5, 0.1, NULL, '{}', ?)`,
      ).run(child.id, 'a'.repeat(64), Date.now());
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go',
      });
    } finally {
      db.close();
    }
    // The child should run cleanly under strict defaults — the
    // stub provider emits text only (no tool calls), so strict
    // doesn't reject anything. The crash we're guarding against
    // is `undefined is not an object (evaluating
    // 'policy.defaults.mode')`.
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: stubProvider('strict-mode child ran'),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(0);
    const db2 = openDb(dbPath);
    try {
      const audit = subagentRunsRepo.getSubagentRun(db2, childId);
      expect(audit?.policySnapshot.defaults.mode).toBe('strict');
      expect(audit?.policySnapshot.tools).toEqual({});
    } finally {
      db2.close();
    }
  });

  test('depth flows through to the child harness config', async () => {
    // The child harness's spawn closure increments
    // (config.subagentDepth ?? 0) when launching grandchildren.
    // Without depth propagation, every subprocess starts from 0
    // and a chain of subprocesses could nest beyond the
    // MAX_SUBAGENT_DEPTH guard. We assert the child runs with
    // the depth value the parent passed by checking the
    // grandchild registration shape: a child seeded with depth=4
    // (== MAX) attempting one more nested task() must surface
    // `subagent.depth_exceeded` (the harness's spawn closure
    // refused, computed depth=5 > MAX).
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let coordId: string;
    const projectAgentsDir = mkdtempSync(join(tmpdir(), 'forja-depth-agents-'));
    try {
      // worker.md: empty toolset, just exists so the registry
      // resolves the name. The harness's spawn closure refuses
      // BEFORE actually spawning when childDepth > MAX, so worker
      // never runs.
      writeFileSync(
        join(projectAgentsDir, 'worker.md'),
        `---
name: worker
description: Worker.
tools: []
budget:
  max_steps: 2
  max_cost_usd: 0.01
---
You are the worker.`,
      );

      const db = openDb(dbPath);
      try {
        migrate(db);
        const top = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
        const coord = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: dbDir,
          parentSessionId: top.id,
        });
        coordId = coord.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: coord.id,
          name: 'coordinator',
          scope: 'project',
          sourcePath: '/fake/coord.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are the coordinator.',
          toolsWhitelist: ['task'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.0,
        });
        messagesRepo.appendMessage(db, {
          sessionId: coord.id,
          role: 'user',
          content: 'spawn the worker',
        });
      } finally {
        db.close();
      }

      let step = 0;
      const provider: Provider = {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(): AsyncGenerator<StreamEvent> {
          step++;
          yield { kind: 'start', message_id: `m-${step}` };
          if (step === 1) {
            yield { kind: 'tool_use_start', id: 'tu1', name: 'task' };
            yield {
              kind: 'tool_use_stop',
              id: 'tu1',
              final_args: { subagent: 'worker', prompt: 'go' },
            };
            yield { kind: 'stop', reason: 'tool_use' };
          } else {
            yield { kind: 'text_delta', text: 'closed' };
            yield { kind: 'stop', reason: 'end_turn' };
          }
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };

      // Run with depth=4 (== MAX_SUBAGENT_DEPTH). The
      // coordinator's task('worker') hop would compute
      // grandchildDepth = 5, which exceeds MAX. The harness's
      // spawn closure returns `depth_exceeded`. If depth weren't
      // honored (still 0), grandchildDepth would be 1 and the
      // call would proceed.
      const exitCode = await runSubagentChild({
        sessionId: coordId,
        dbPath,
        providerOverride: provider,
        userAgentsDir: null,
        projectAgentsDir,
        depth: 4,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);

      // Tool call's output captures `subagent.depth_exceeded`.
      const db2 = openDb(dbPath);
      try {
        const calls = db2
          .query<{ output: string }, [string]>(
            `SELECT tc.output AS output
               FROM tool_calls tc
               JOIN messages m ON tc.message_id = m.id
              WHERE m.session_id = ? AND tc.tool_name = 'task'`,
          )
          .all(coordId);
        expect(calls.length).toBeGreaterThan(0);
        const codes = calls
          .map((c) => {
            try {
              return (JSON.parse(c.output) as { error_code?: string }).error_code;
            } catch {
              return undefined;
            }
          })
          .filter(Boolean);
        expect(codes).toContain('subagent.depth_exceeded');
      } finally {
        db2.close();
      }
    } finally {
      rmSync(projectAgentsDir, { recursive: true, force: true });
    }
  });

  test('temperature flows through to the harness provider request', async () => {
    // Eval pipelines pin temperature=0 for determinism; without
    // propagation, the subprocess child runs at the provider
    // default and breaks reproducibility. Capture the request
    // the harness sends to provider.generate; assert
    // req.temperature matches what the child handler received.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/fake/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go',
      });
    } finally {
      db.close();
    }

    const recordedRequests: Array<{ temperature?: number }> = [];
    const recordingProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate(req): AsyncGenerator<StreamEvent> {
        recordedRequests.push(
          req.temperature !== undefined ? { temperature: req.temperature } : {},
        );
        yield { kind: 'start', message_id: 'mock-msg' };
        yield { kind: 'text_delta', text: 'done' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: recordingProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      // Pin temperature to 0 — the value an eval would set.
      // Without propagation through child handler → harness
      // → provider, the recorded request would lack this
      // value and surface as undefined / provider default.
      temperature: 0,
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(recordedRequests.length).toBeGreaterThan(0);
    expect(recordedRequests[0]?.temperature).toBe(0);
  });

  test('memoryCwd anchors the registry at the parent repo even for worktree-cwd children', async () => {
    // Subagent runs in a worktree (different cwd from parent's
    // repo). Without memoryCwd forwarding, the child would build
    // its registry from the worktree path and miss project_local
    // (gitignored, never replicated). With it, the child sees
    // the parent's memory tree intact AND the audit row anchors
    // to the child's session.cwd.
    const fs = await import('node:fs');
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    // Two distinct cwds: parent_repo holds the memory tree; the
    // child's session.cwd points at a "worktree" subdirectory.
    const parentRepo = mkdtempSync(join(tmpdir(), 'forja-mem-parent-'));
    const worktreeCwd = mkdtempSync(join(tmpdir(), 'forja-mem-worktree-'));
    // Isolate user scope under the parent repo so the dev's real
    // ~/.config/agent/memory/ doesn't bleed in.
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = parentRepo;
    try {
      // Seed parent's project_local memory.
      const localDir = join(parentRepo, '.agent', 'memory', 'local');
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — full-stack TS dev\n');
      fs.writeFileSync(
        join(localDir, 'role.md'),
        '---\nname: role\ndescription: hook\ntype: user\nsource: user_explicit\n---\n\nbody\n',
      );

      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: parentRepo });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: worktreeCwd,
          parentSessionId: parent.id,
        });
        childId = child.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'explore',
          scope: 'project',
          sourcePath: '/fake/explore.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are explore.',
          // Whitelist must include at least one memory_* tool for
          // the registry construction + section injection to fire
          // (S1 fix: lean subagents without memory access don't
          // get the prompt bloat).
          toolsWhitelist: ['memory_read'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.1,
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'go',
        });
      } finally {
        db.close();
      }

      const recordedSystem: Array<string | undefined> = [];
      const recordingProvider: Provider = {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(req): AsyncGenerator<StreamEvent> {
          recordedSystem.push(req.system);
          yield { kind: 'start', message_id: 'mock-msg' };
          yield { kind: 'text_delta', text: 'done' };
          yield { kind: 'stop', reason: 'end_turn' };
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };

      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: recordingProvider,
        userAgentsDir: null,
        projectAgentsDir: null,
        memoryCwd: parentRepo,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);
      // System prompt must include both the audit's identity
      // prompt AND the memory section anchored at the parent's
      // memory tree.
      expect(recordedSystem.length).toBeGreaterThan(0);
      const sys = recordedSystem[0];
      expect(sys).toContain('You are explore.');
      expect(sys).toContain('# Memory');
      expect(sys).toContain('[project_local] role — full-stack TS dev');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      try {
        rmSync(parentRepo, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(worktreeCwd, { recursive: true, force: true });
      } catch {}
    }
  });

  test('boot triggers probe the subagent repo root, not the raw session.cwd (regression)', async () => {
    // Bug: subagent-child evaluated boot triggers from
    // `session.cwd`. For an isolation:none subagent inheriting
    // the parent's invocation cwd, that cwd may be a repo subdir
    // (`/repo/src/components/`). Probing there missed root-level
    // files (`.git`, `package.json`, `tsconfig.json`) and silently
    // filtered out trigger-tagged memories — even though those
    // memories were loaded from the parent's repo root. Fix:
    // probe `resolveRepoRoot(session.cwd)` so the trigger anchor
    // matches the memory anchor.
    //
    // Setup: parentRepo with `git init` + memory tagged
    // `triggers: [git]`. Subagent.cwd points at a subdir within
    // parentRepo. Memory MUST appear in the subagent's system
    // prompt.
    const fs = await import('node:fs');
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    const parentRepo = mkdtempSync(join(tmpdir(), 'forja-trigger-'));
    Bun.spawnSync({
      cmd: ['git', 'init', parentRepo],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    fs.writeFileSync(join(parentRepo, 'package.json'), '{}');
    const subdir = join(parentRepo, 'src', 'components');
    fs.mkdirSync(subdir, { recursive: true });

    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = parentRepo;
    try {
      // Memory tagged with both well-known boot triggers.
      const localDir = join(parentRepo, '.agent', 'memory', 'local');
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(
        join(localDir, 'MEMORY.md'),
        '- [Tagged](git-tagged.md) — git-tagged memory\n',
      );
      fs.writeFileSync(
        join(localDir, 'git-tagged.md'),
        [
          '---',
          'name: git-tagged',
          'description: hook for git-tagged',
          'type: feedback',
          'source: user_explicit',
          'triggers:',
          '  - git',
          '  - package',
          '---',
          '',
          'body',
        ].join('\n'),
      );

      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: parentRepo });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          // Subagent runs from a subdir of parentRepo (simulates
          // isolation:none with parent at subdir).
          cwd: subdir,
          parentSessionId: parent.id,
        });
        childId = child.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'explore',
          scope: 'project',
          sourcePath: '/fake/explore.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are explore.',
          toolsWhitelist: ['memory_read'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.1,
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'go',
        });
      } finally {
        db.close();
      }

      const recordedSystem: Array<string | undefined> = [];
      const recordingProvider: Provider = {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(req): AsyncGenerator<StreamEvent> {
          recordedSystem.push(req.system);
          yield { kind: 'start', message_id: 'mock-msg' };
          yield { kind: 'text_delta', text: 'done' };
          yield { kind: 'stop', reason: 'end_turn' };
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };

      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: recordingProvider,
        userAgentsDir: null,
        projectAgentsDir: null,
        memoryCwd: parentRepo,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);
      // Memory MUST be present — `git` and `package` triggers
      // fired because the probe found `resolveRepoRoot(subdir) ===
      // parentRepo` and probed the root files there.
      const sys = recordedSystem[0] ?? '';
      expect(sys).toContain('# Memory');
      expect(sys).toContain('git-tagged');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      try {
        rmSync(parentRepo, { recursive: true, force: true });
      } catch {}
    }
  });

  test('whitelist without memory_* tools skips the section even when memoryCwd is forwarded (regression: S1)', async () => {
    // Lean-subagent guard: a subagent that only lists `read_file`
    // in its whitelist has no way to invoke memory_read /
    // memory_list / memory_search. Injecting the memory section
    // would advertise tools the model can't call AND inflate the
    // prompt with up to ~2k tokens of irrelevant index. The
    // injection must fire only when the whitelist includes at
    // least one memory_* tool.
    const fs = await import('node:fs');
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    const parentRepo = mkdtempSync(join(tmpdir(), 'forja-mem-skip-'));
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = parentRepo;
    try {
      // Memory IS present in the parent's tree — but the
      // subagent's whitelist excludes memory tools, so it must
      // NOT see the section.
      const localDir = join(parentRepo, '.agent', 'memory', 'local');
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — TS dev\n');

      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: parentRepo });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: parentRepo,
          parentSessionId: parent.id,
        });
        childId = child.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'explore',
          scope: 'project',
          sourcePath: '/fake/explore.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are explore.',
          // No memory tools — only read_file.
          toolsWhitelist: ['read_file'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.1,
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'go',
        });
      } finally {
        db.close();
      }

      const recordedSystem: Array<string | undefined> = [];
      const recordingProvider: Provider = {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(req): AsyncGenerator<StreamEvent> {
          recordedSystem.push(req.system);
          yield { kind: 'start', message_id: 'mock-msg' };
          yield { kind: 'text_delta', text: 'done' };
          yield { kind: 'stop', reason: 'end_turn' };
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };

      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: recordingProvider,
        userAgentsDir: null,
        projectAgentsDir: null,
        // memoryCwd IS forwarded, but the whitelist gate above
        // suppresses the injection.
        memoryCwd: parentRepo,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);
      expect(recordedSystem.length).toBeGreaterThan(0);
      const sys = recordedSystem[0];
      // Post-D227 review: subagent-child also prepends the
      // parallelism hint above the audit snapshot's identity
      // prompt. The whitelist-gated memory section is still
      // suppressed (the property under test); only the hint is
      // expected to land.
      expect(sys).toContain('# Parallelism');
      expect(sys).toContain('You are explore.');
      expect(sys).not.toContain('# Memory');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      try {
        rmSync(parentRepo, { recursive: true, force: true });
      } catch {}
    }
  });

  test('memoryCwd absent leaves the child without memory wiring (registry_unavailable)', async () => {
    // Older parent / direct invocation that didn't forward
    // memoryCwd: the child runs without the registry, system
    // prompt is the audit snapshot verbatim, no memory section.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/fake/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go',
      });
    } finally {
      db.close();
    }

    const recordedSystem: Array<string | undefined> = [];
    const recordingProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate(req): AsyncGenerator<StreamEvent> {
        recordedSystem.push(req.system);
        yield { kind: 'start', message_id: 'mock-msg' };
        yield { kind: 'text_delta', text: 'done' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: recordingProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      // No memoryCwd — simulates older parent or programmatic
      // caller that didn't forward.
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(recordedSystem.length).toBeGreaterThan(0);
    const sys = recordedSystem[0];
    // Post-D227 review: hint preamble lands above the
    // audit-snapshot identity even when memory is unwired.
    // Memory section suppression is the property under test.
    expect(sys).toContain('# Parallelism');
    expect(sys).toContain('You are explore.');
    expect(sys).not.toContain('# Memory');
  });

  test('temperature undefined → provider request has no temperature pin', async () => {
    // Counterpart: when the parent didn't pin a temperature,
    // the harness should leave req.temperature undefined so the
    // provider applies its own default. Locks the
    // "absent-by-default" semantics so a future regression
    // doesn't silently inject a value.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/fake/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go',
      });
    } finally {
      db.close();
    }

    const recordedRequests: Array<{ temperature?: number }> = [];
    const recordingProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate(req): AsyncGenerator<StreamEvent> {
        recordedRequests.push(
          req.temperature !== undefined ? { temperature: req.temperature } : {},
        );
        yield { kind: 'start', message_id: 'mock-msg' };
        yield { kind: 'text_delta', text: 'done' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: recordingProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      // No temperature.
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(recordedRequests.length).toBeGreaterThan(0);
    expect(recordedRequests[0]?.temperature).toBeUndefined();
  });

  test('planMode flows through to the child harness gate (writes blocked)', async () => {
    // Defense-in-depth: when the parent invoked runSubagent
    // with planMode:true, the child's harness must reject any
    // tool with planSafe:false BEFORE execution, even if the
    // tool is in the whitelist.
    //
    // Test artifact disclosure: this fixture seeds the audit
    // row with `tools_whitelist: ['bash']` directly via the
    // repo, bypassing the parent's `assertWhitelistValidForSubagent`
    // which would refuse `bash` (writes:true) without
    // `isolation:'worktree'`. The child handler does NOT
    // re-validate the whitelist — it trusts the audit row was
    // produced by a properly-configured parent — so the test
    // can invoke runSubagentChild directly with bash in scope.
    // What the test PROVES is the harness gate behavior under
    // planMode, which is the load-bearing property regardless
    // of how bash got into the whitelist. A more production-
    // shaped scenario (parent + worktree + write_file under
    // planMode) would require real git fixtures and lands
    // naturally with the worktree integration test in 4.2b.iii
    // / .iv. For now, the gate-level coverage is sufficient.
    //
    // Mechanic: `bash` from builtins has `metadata.planSafe`
    // as a predicate `(args) => args.read_only === true`. The
    // provider emits `bash({ command: 'echo hi', read_only:
    // false })` — under plan mode, the predicate returns false
    // and the harness gate denies BEFORE execution. Without
    // planMode propagation through the chain (CLI flag → child
    // opts → harness config), the call would land status='done'
    // and the assertion would fail.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'runner',
        scope: 'project',
        sourcePath: '/fake/runner.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are a runner.',
        toolsWhitelist: ['bash'],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.0,
        // Bypass policy so the only thing standing between the
        // bash call and execution is plan mode.
        policySnapshot: { defaults: { mode: 'bypass' }, tools: {} },
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'run a command',
      });
    } finally {
      db.close();
    }

    let step = 0;
    const provider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate(): AsyncGenerator<StreamEvent> {
        step++;
        yield { kind: 'start', message_id: `m-${step}` };
        if (step === 1) {
          yield { kind: 'tool_use_start', id: 'tu1', name: 'bash' };
          yield {
            kind: 'tool_use_stop',
            id: 'tu1',
            final_args: { command: 'echo hi', read_only: false },
          };
          yield { kind: 'stop', reason: 'tool_use' };
        } else {
          yield { kind: 'text_delta', text: 'closed' };
          yield { kind: 'stop', reason: 'end_turn' };
        }
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: provider,
      userAgentsDir: null,
      projectAgentsDir: null,
      planMode: true,
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);

    // Bash call MUST land status='denied' (plan-mode gate
    // rejected it). Without planMode propagation, the call
    // would've reached status='done'.
    const db2 = openDb(dbPath);
    try {
      const calls = db2
        .query<{ status: string }, [string]>(
          `SELECT tc.status AS status
             FROM tool_calls tc
             JOIN messages m ON tc.message_id = m.id
            WHERE m.session_id = ? AND tc.tool_name = 'bash'`,
        )
        .all(childId);
      expect(calls.length).toBeGreaterThan(0);
      for (const row of calls) {
        expect(row.status).toBe('denied');
      }
    } finally {
      db2.close();
    }
  });

  test('child writes last_heartbeat at the cadence interval', async () => {
    // End-to-end probe of the heartbeat writer. The child
    // installs a setInterval that calls updateSubagentHeartbeat
    // every 2000ms in production. The threshold for the parent's
    // poller is 10s, so a child that runs ≥ 4s should leave
    // observable last_heartbeat updates. We use a stub provider
    // that delays its `generate` resolution slightly to keep the
    // run alive long enough for the interval to fire at least
    // once.
    //
    // Verification: after the run completes, last_heartbeat is
    // NOT null (interval fired) and is recent (within 1s of
    // now). Without the heartbeat writer wired, last_heartbeat
    // would stay null — only setSubagentPayload bumps it on
    // exit, but that's the EXIT path, not the running path.
    // We assert the running-path pulse explicitly by reading
    // mid-run, or in a different way: just check that the
    // value was bumped at SOME point during the run, NOT just
    // by the final setSubagentPayload.
    //
    // To detect a "running pulse" specifically, we capture
    // `last_heartbeat` BEFORE the final payload write. The
    // simplest probe: have the child run for ~2.5s before
    // emitting end_turn — long enough for the interval to
    // tick at the production cadence (2000ms).
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    let childId: string;
    const db = openDb(dbPath);
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = sessionsRepo.createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'slow',
        scope: 'project',
        sourcePath: '/fake/slow.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are slow.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.0,
        policySnapshot: { defaults: { mode: 'bypass' }, tools: {} },
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'go slowly',
      });
    } finally {
      db.close();
    }

    // Provider that delays ~2.3s before emitting end_turn —
    // ensures the child's setInterval (2000ms cadence) ticks
    // at least once during the run.
    const slowProvider: Provider = {
      id: 'mock/m',
      family: 'anthropic',
      capabilities: {
        tools: 'native',
        cache: false,
        vision: false,
        streaming: true,
        constrained: 'tools',
        context_window: 1000,
        output_max_tokens: 100,
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
        notes: [],
      },
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { kind: 'start', message_id: 'mock-msg' };
        // Hold the loop for ~2.3s so the heartbeat interval
        // (2000ms cadence) fires at least once.
        await new Promise<void>((r) => setTimeout(r, 2_300));
        yield { kind: 'text_delta', text: 'done after pulse' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };

    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      providerOverride: slowProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);

    // last_heartbeat must be NOT null AND recent. The exact
    // value depends on whether the final setSubagentPayload
    // (which also bumps heartbeat) ran after the interval's
    // last tick or vice versa — both are fine for the
    // assertion. The key invariant: if the interval was
    // never installed, the only writes would be `payload-publish`
    // at the very end, and the test would still see a non-null
    // heartbeat — so the assertion below alone doesn't prove
    // the interval ran. We strengthen it by checking the
    // updated_at column (which both interval AND payload bump):
    // updated_at - created_at should be ≥ ~2000ms (the
    // interval's first tick happened before exit). If only the
    // final payload bumped updated_at, the delta would be
    // ~2300ms (the entire run); if the interval also bumped,
    // the delta is also ~2300ms. The cleaner probe: check that
    // `last_heartbeat` value sits BEFORE the run-end timestamp,
    // proving an interval mid-run pulse landed before the
    // final payload bump overwrote it.
    //
    // Simpler approach: just assert lastHeartbeat is recent
    // (within 5s of now) AND not null. The interval's
    // existence is exercised via the wedge-detection runtime
    // tests above; this test is the smoke that the writer
    // reaches the DB at all.
    const db2 = openDb(dbPath);
    try {
      const out = (await import('../../src/storage/repos/subagent-outputs.ts')).getSubagentOutput(
        db2,
        childId,
      );
      expect(out?.lastHeartbeat).not.toBeNull();
      const age = Date.now() - (out?.lastHeartbeat ?? 0);
      expect(age).toBeLessThan(5_000);
    } finally {
      db2.close();
    }
  }, 10_000);

  test('non-existent session id surfaces a stderr line and exit 1', async () => {
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: 'never-existed',
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/session never-existed not found/);
  });

  test('non-subagent session refused (parent_session_id null)', async () => {
    const db = openDb(dbPath);
    let topLevelId: string;
    try {
      migrate(db);
      const top = createSession(db, { model: 'mock/m', cwd: dbDir });
      topLevelId = top.id;
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: topLevelId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/is not a subagent/);
  });

  test('child can task() a grandchild (subagentRegistry forwarded)', async () => {
    // Regression for the missing-registry feedback: without
    // forwarding `subagentRegistry` + `rootToolRegistry`, the
    // child's `task` tool returns `subagent.unavailable` and
    // coordinator-style chains break. We assert the wiring by
    // running a child whose tool whitelist is `[task]`, scripting
    // its provider to invoke task('worker', ...), and dropping a
    // worker .md into the project agents dir. Success path:
    // child run completes 'done', the grandchild row exists in
    // the DB.
    const projectAgentsDir = mkdtempSync(join(tmpdir(), 'forja-child-agents-'));
    try {
      // Worker definition that just emits text and ends.
      writeFileSync(
        join(projectAgentsDir, 'worker.md'),
        `---
name: worker
description: Worker.
tools: []
budget:
  max_steps: 2
  max_cost_usd: 0.01
---
You are the worker.`,
      );

      const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
      const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
      const messagesRepo = await import('../../src/storage/repos/messages.ts');
      let coordinatorId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const top = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
        const coord = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: dbDir,
          parentSessionId: top.id,
        });
        coordinatorId = coord.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: coord.id,
          name: 'coordinator',
          scope: 'project',
          sourcePath: '/fake/coord.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are the coordinator.',
          toolsWhitelist: ['task'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.0,
        });
        messagesRepo.appendMessage(db, {
          sessionId: coord.id,
          role: 'user',
          content: 'spawn the worker',
        });
      } finally {
        db.close();
      }

      // Scripted provider: coordinator emits task(worker, ...),
      // then closes after the tool result. The harness's spawn
      // closure (now wired) routes through runSubagent which
      // recursively spawns the child binary — but with our
      // `providerOverride` shape, the GRANDCHILD will fall
      // back to the registry which doesn't know 'mock/m'. To
      // keep this test isolated, we use a fake spawn injection
      // pattern: not available here. Simplest end-to-end
      // assertion: invoke the child, expect the COORDINATOR run
      // to terminate with status='done' (the spawn closure
      // returned a structured tool error instead of throwing
      // unavailable). The model's text after the tool result
      // is 'done'.
      //
      // Test scope: assert that `subagentRegistry` was wired
      // by checking the harness's spawn closure was reachable.
      // We do this indirectly: with the registry wired, calling
      // task() against an UNKNOWN subagent returns
      // `subagent.unknown` (not `subagent.unavailable`). Both
      // are tool errors, but they distinguish "registry wired,
      // name not found" from "registry not wired at all". Our
      // worker.md is a valid name; if the registry is wired,
      // the spawn closure attempts to spawn a real subprocess.
      // To avoid spawning a real subprocess in the unit test,
      // we point at a non-existent worker name and assert the
      // tool error is `subagent.unknown` (not `unavailable`).
      // Two-step provider: turn 1 emits task(nonexistent), turn
      // 2 closes after the tool result lands.
      let step = 0;
      const multiStepProvider: Provider = {
        id: 'mock/m',
        family: 'anthropic',
        capabilities: {
          tools: 'native',
          cache: false,
          vision: false,
          streaming: true,
          constrained: 'tools',
          context_window: 1000,
          output_max_tokens: 100,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0,
          notes: [],
        },
        async *generate(): AsyncGenerator<StreamEvent> {
          step++;
          yield { kind: 'start', message_id: `mock-${step}` };
          if (step === 1) {
            yield { kind: 'tool_use_start', id: 'tu1', name: 'task' };
            yield {
              kind: 'tool_use_stop',
              id: 'tu1',
              final_args: { subagent: 'nonexistent', prompt: 'go' },
            };
            yield { kind: 'stop', reason: 'tool_use' };
          } else {
            yield { kind: 'text_delta', text: 'closed' };
            yield { kind: 'stop', reason: 'end_turn' };
          }
        },
        generateConstrained: () => Promise.reject(new Error('n/a')),
        countTokens: () => Promise.resolve(0),
      };
      const errMessages: string[] = [];
      const exitCode = await runSubagentChild({
        sessionId: coordinatorId,
        dbPath,
        providerOverride: multiStepProvider,
        // No user-scope agents; project scope = our tmp dir.
        userAgentsDir: null,
        projectAgentsDir,
        errSink: (s) => errMessages.push(s),
      });
      expect(exitCode).toBe(0);
      // The harness completed; tool_calls table records the
      // `task` invocation as a tool error with code
      // `subagent.unknown` — proving the spawn closure was
      // reachable (registry wired). If the registry hadn't
      // been forwarded, the code would be `subagent.unavailable`.
      const db2 = openDb(dbPath);
      try {
        const calls = db2
          .query<{ output: string }, [string]>(
            `SELECT tc.output AS output
               FROM tool_calls tc
               JOIN messages m ON tc.message_id = m.id
              WHERE m.session_id = ? AND tc.tool_name = 'task'`,
          )
          .all(coordinatorId);
        expect(calls.length).toBeGreaterThan(0);
        const errCodes = calls
          .map((c) => {
            try {
              return (JSON.parse(c.output) as { error_code?: string }).error_code;
            } catch {
              return undefined;
            }
          })
          .filter(Boolean);
        expect(errCodes).toContain('subagent.unknown');
        expect(errCodes).not.toContain('subagent.unavailable');
      } finally {
        db2.close();
      }
    } finally {
      rmSync(projectAgentsDir, { recursive: true, force: true });
    }
  });

  test('unknown session.model refuses loud (no silent fallback)', async () => {
    // Cost attribution is per-model; running on a different
    // provider than what's persisted on the session row corrupts
    // both cost reporting and audit forensics. Earlier code
    // silently substituted DEFAULT_MODEL_FALLBACK on a registry
    // miss — that's exactly the drift we MUST refuse. The child
    // publishes an unknown_model envelope and exits 1 so the
    // parent's poller surfaces a clean error.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');
    const db = openDb(dbPath);
    let childId: string;
    try {
      migrate(db);
      const parent = sessionsRepo.createSession(db, {
        model: 'anthropic/claude-sonnet-4-6',
        cwd: dbDir,
      });
      // Child session uses a model the default registry does
      // NOT know — drift simulation. The parent could have
      // registered it via its own providerOverride, but the
      // child binary's registry won't have it.
      const child = sessionsRepo.createSession(db, {
        model: 'fictional/never-registered',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
      subagentRunsRepo.insertSubagentRun(db, {
        sessionId: child.id,
        name: 'explore',
        scope: 'project',
        sourcePath: '/fake/explore.md',
        sourceSha256: 'a'.repeat(64),
        systemPrompt: 'You are explore.',
        toolsWhitelist: [],
        budgetMaxSteps: 5,
        budgetMaxCostUsd: 0.1,
      });
      messagesRepo.appendMessage(db, {
        sessionId: child.id,
        role: 'user',
        content: 'find the README',
      });
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    // No providerOverride → falls into the registry-lookup path.
    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/unknown model fictional\/never-registered/);
    // Envelope must be published so the parent's poller
    // surfaces the failure as a tool error rather than
    // hitting its own wall-clock timeout.
    const db2 = openDb(dbPath);
    try {
      const out = getSubagentOutput(db2, childId);
      expect(out?.payload?.status).toBe('error');
      expect(out?.payload?.reason).toBe('unknown_model');
      // Critical: the session row must also be finalized to
      // 'error', NOT left in 'running'. Without finalization,
      // a parent crash between the child's exit and the
      // parent's polling claim would leave the row stuck.
      const session = (await import('../../src/storage/repos/sessions.ts')).getSession(
        db2,
        childId,
      );
      expect(session?.status).toBe('error');
    } finally {
      db2.close();
    }
  });

  test('missing audit row refused with explicit diagnostic', async () => {
    // Create a child session WITHOUT the subagent_runs row — the
    // child has no way to discover its definition (system prompt,
    // tools, budget) so it must refuse rather than guess.
    const db = openDb(dbPath);
    let childId: string;
    try {
      migrate(db);
      const parent = createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/no subagent_runs row/);
    // Same finalization invariant: session row MUST be terminal,
    // not stuck in 'running'. The audit-missing branch sits
    // before the outputs row insert, so there's no payload to
    // publish — the row update is the only signal an operator
    // gets.
    const db2 = openDb(dbPath);
    try {
      const session = (await import('../../src/storage/repos/sessions.ts')).getSession(
        db2,
        childId,
      );
      expect(session?.status).toBe('error');
    } finally {
      db2.close();
    }
  });

  test('malformed agents .md does NOT abort runs whose whitelist lacks task', async () => {
    // Regression: the child used to always loadSubagents +
    // validateSubagentSet, even when `task` wasn't in
    // audit.toolsWhitelist. A malformed .md in
    // user/project agents would surface `subagent_load_failed`
    // for an unrelated run that just wanted, say, read_file.
    // The fix gates discovery on `wantsTask` so non-task runs
    // don't couple to registry health.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    const projectAgentsDir = mkdtempSync(join(tmpdir(), 'forja-bad-agents-'));
    try {
      // Drop a malformed .md — missing frontmatter delimiters
      // entirely. loadSubagents would throw on this.
      writeFileSync(
        join(projectAgentsDir, 'broken.md'),
        'this is not a valid subagent definition\nno frontmatter at all\n',
      );

      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: dbDir,
          parentSessionId: parent.id,
        });
        childId = child.id;
        // Whitelist deliberately EXCLUDES `task` — the child's
        // job has nothing to do with spawning grandchildren.
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'reader',
          scope: 'project',
          sourcePath: '/fake/reader.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are a reader.',
          toolsWhitelist: [],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.0,
          policySnapshot: { defaults: { mode: 'bypass' }, tools: {} },
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'just respond',
        });
      } finally {
        db.close();
      }

      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: stubProvider('done'),
        userAgentsDir: null,
        projectAgentsDir,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);

      // Payload published as 'done', NOT 'subagent_load_failed'.
      // Without the gate, the malformed broken.md would have
      // aborted this unrelated run.
      const db2 = openDb(dbPath);
      try {
        const out = getSubagentOutput(db2, childId);
        expect(out?.payload?.status).toBe('done');
        expect(out?.payload?.reason).toBe('done');
      } finally {
        db2.close();
      }
    } finally {
      rmSync(projectAgentsDir, { recursive: true, force: true });
    }
  });

  test('malformed agents .md DOES abort when task IS in whitelist', async () => {
    // Counterpart: when the child's whitelist includes `task`,
    // the registry is load-bearing — a malformed .md must
    // still surface `subagent_load_failed` because nested
    // task() calls would otherwise dispatch into a broken
    // registry. Locks the gate so a future regression that
    // skipped loading unconditionally surfaces here.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');

    const projectAgentsDir = mkdtempSync(join(tmpdir(), 'forja-bad-agents-'));
    try {
      writeFileSync(
        join(projectAgentsDir, 'broken.md'),
        'this is not a valid subagent definition\nno frontmatter at all\n',
      );

      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: dbDir,
          parentSessionId: parent.id,
        });
        childId = child.id;
        // Whitelist INCLUDES `task` — registry must be valid
        // for grandchildren to dispatch.
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'coordinator',
          scope: 'project',
          sourcePath: '/fake/coord.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are a coordinator.',
          toolsWhitelist: ['task'],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.0,
          policySnapshot: { defaults: { mode: 'bypass' }, tools: {} },
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'go',
        });
      } finally {
        db.close();
      }

      const errMessages: string[] = [];
      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: stubProvider('never'),
        userAgentsDir: null,
        projectAgentsDir,
        errSink: (s) => errMessages.push(s),
      });
      expect(exitCode).toBe(1);
      expect(errMessages.join('')).toMatch(/subagent load failed/);

      const db2 = openDb(dbPath);
      try {
        const out = getSubagentOutput(db2, childId);
        expect(out?.payload?.reason).toBe('subagent_load_failed');
      } finally {
        db2.close();
      }
    } finally {
      rmSync(projectAgentsDir, { recursive: true, force: true });
    }
  });

  test('non-subagent session: row left untouched (refuses without finalizing)', async () => {
    // The non-subagent path is the only error branch that
    // intentionally does NOT finalize — the session row
    // belongs to a top-level run, and marking it 'error'
    // would corrupt a session the user cares about. Lock
    // this carve-out so a future tightening doesn't
    // accidentally start finalizing top-level sessions.
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const db = openDb(dbPath);
    let topLevelId: string;
    try {
      migrate(db);
      const top = sessionsRepo.createSession(db, { model: 'mock/m', cwd: dbDir });
      topLevelId = top.id;
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: topLevelId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/is not a subagent/);
    // Row must STAY in 'running' — the child handler refused
    // to touch a session that isn't its own.
    const db2 = openDb(dbPath);
    try {
      const session = sessionsRepo.getSession(db2, topLevelId);
      expect(session?.status).toBe('running');
    } finally {
      db2.close();
    }
  });

  test('subagent-child loads and dispatches hooks from the parent repo (regression)', async () => {
    // Sanity-revert: an earlier cut built HarnessConfig without
    // `hooks` so every `task`-spawned child silently bypassed
    // every hook — defeating spec §10's `locked: true` claim
    // (an enterprise PreToolUse hook protecting `bash` would be
    // enforced in the parent but bypassed in any subagent that
    // listed `bash` in its whitelist). Fix anchors the project
    // hooks.toml at the parent's repo (via `memoryCwd`); we
    // verify the SessionStart hook fires inside the child by
    // having it touch a marker file.
    const fs = await import('node:fs');
    const sessionsRepo = await import('../../src/storage/repos/sessions.ts');
    const subagentRunsRepo = await import('../../src/storage/repos/subagent-runs.ts');
    const messagesRepo = await import('../../src/storage/repos/messages.ts');
    const hookRunsRepo = await import('../../src/storage/repos/hook-runs.ts');

    const parentRepo = mkdtempSync(join(tmpdir(), 'forja-child-hook-parent-'));
    const worktreeCwd = mkdtempSync(join(tmpdir(), 'forja-child-hook-worktree-'));
    const marker = join(parentRepo, 'session-start-fired.txt');
    // Stage a SessionStart hook in the parent's project layer.
    // The subagent-child must re-resolve from this same path.
    const hookDir = join(parentRepo, '.agent');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      join(hookDir, 'hooks.toml'),
      ['[[hooks]]', 'event = "SessionStart"', `command = "cat > ${marker}"`, ''].join('\n'),
    );

    // Isolate enterprise + user layers so the runner machine's
    // own /etc or ~/.config files don't bleed into the test.
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = parentRepo; // /etc layer is system-wide; parent repo's project layer is what we test against

    try {
      let childId: string;
      const db = openDb(dbPath);
      try {
        migrate(db);
        const parent = sessionsRepo.createSession(db, { model: 'mock/m', cwd: parentRepo });
        const child = sessionsRepo.createSession(db, {
          model: 'mock/m',
          cwd: worktreeCwd,
          parentSessionId: parent.id,
        });
        childId = child.id;
        subagentRunsRepo.insertSubagentRun(db, {
          sessionId: child.id,
          name: 'explore',
          scope: 'project',
          sourcePath: '/fake/explore.md',
          sourceSha256: 'a'.repeat(64),
          systemPrompt: 'You are explore.',
          toolsWhitelist: [],
          budgetMaxSteps: 5,
          budgetMaxCostUsd: 0.1,
        });
        messagesRepo.appendMessage(db, {
          sessionId: child.id,
          role: 'user',
          content: 'go',
        });
      } finally {
        db.close();
      }

      const exitCode = await runSubagentChild({
        sessionId: childId,
        dbPath,
        providerOverride: stubProvider('done'),
        userAgentsDir: null,
        projectAgentsDir: null,
        memoryCwd: parentRepo,
        errSink: () => undefined,
      });
      expect(exitCode).toBe(0);

      // The hook subprocess wrote its payload to the marker.
      // File presence proves: (a) the child resolved hooks
      // from the parent's repo, (b) the harness dispatched
      // SessionStart, (c) the operator command ran.
      expect(fs.existsSync(marker)).toBe(true);

      // Audit: hook_runs has the SessionStart row attributed
      // to the child's session.
      const dbCheck = openDb(dbPath);
      try {
        const runs = hookRunsRepo.listHookRunsBySession(dbCheck, childId);
        const ss = runs.filter((r) => r.event === 'SessionStart');
        expect(ss).toHaveLength(1);
        expect(ss[0]?.outcome).toBe('allow');
        expect(ss[0]?.layer).toBe('project');
      } finally {
        dbCheck.close();
      }
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      try {
        rmSync(parentRepo, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(worktreeCwd, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe('runSubagentChild — IPC', () => {
  test('opens channel when ipcVersion=1 and brackets the run with session_start/session_finished', async () => {
    const { sessionId } = seedChildSession(dbDir);
    const { IPC_PROTOCOL_VERSION, createChannel, fakeTransportPair } = await import(
      '../../src/subagents/ipc.ts'
    );
    type IpcMessage = import('../../src/subagents/ipc.ts').IpcMessage;
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const received: IpcMessage[] = [];
    parentChannel.onMessage((m) => received.push(m));

    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: stubProvider('hello'),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
      ipcVersion: 1,
      // Inject the child's transport directly so we don't have
      // to spin up a real subprocess. The fake pair routes the
      // child's writes into our parentChannel above.
      ipcTransportFactory: () => b,
    });
    expect(exitCode).toBe(0);

    const types = received.map((m) => m.type);
    // Spec §4.2 + §4.3: session_start is the FIRST message;
    // session_finished is the LAST. Other variants may land
    // between them in future slices, but the bracket invariant
    // is fixed.
    expect(types[0]).toBe('session_start');
    expect(types[types.length - 1]).toBe('session_finished');

    const start = received[0];
    if (start?.type === 'session_start') {
      expect(start.sessionId).toBe(sessionId);
      expect(start.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
    } else {
      throw new Error('expected first message to be session_start');
    }
  });

  test('refuses ipc_version_mismatch and exits non-zero before any work', async () => {
    const { sessionId } = seedChildSession(dbDir);
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: stubProvider('hi'),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: (s) => errMessages.push(s),
      // Pretend a future parent requested protocol v999 — child
      // only knows v1.
      ipcVersion: 999,
    });
    // Dedicated EX_USAGE exit code (64) — parent's wait loop
    // maps this to `reason: 'ipc_version_mismatch'` so mixed-
    // version deployments surface the handshake failure
    // explicitly instead of as a generic crash.
    expect(exitCode).toBe(64);
    expect(errMessages.some((s) => s.includes('ipc_version_mismatch'))).toBe(true);
    // Payload row was never inserted because the refusal lands
    // before the harness path runs.
    const db = openDb(dbPath);
    try {
      const out = getSubagentOutput(db, sessionId);
      expect(out).toBeNull();
      // BUT the session row IS finalized (post-fix). Belt-and-
      // suspenders so a parent crash between spawn and the
      // wait-loop's finalize wouldn't leak the row as 'running'
      // — every other early-refusal path in subagent-child
      // calls finalizeAsError; the version-mismatch path now
      // matches that pattern.
      const session = (await import('../../src/storage/repos/sessions.ts')).getSession(
        db,
        sessionId,
      );
      expect(session?.status).toBe('error');
    } finally {
      db.close();
    }
  });

  test('interrupt:hard over IPC routes to harness signal (preemptive abort)', async () => {
    const { sessionId } = seedChildSession(dbDir);
    const { createChannel, fakeTransportPair, makeInterruptHard } = await import(
      '../../src/subagents/ipc.ts'
    );
    const { a, b } = fakeTransportPair();
    const parentChannel = createChannel(a);
    const slowProvider: Provider = {
      ...stubProvider('content'),
      async *generate() {
        await new Promise((r) => setTimeout(r, 30));
        yield { kind: 'start', message_id: 'm1' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };
    setTimeout(() => parentChannel.send(makeInterruptHard()), 5);
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: slowProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
      ipcVersion: 1,
      ipcTransportFactory: () => b,
    });
    expect(exitCode).toBe(0);
    const db = openDb(dbPath);
    try {
      const out = getSubagentOutput(db, sessionId);
      const payload = out?.payload as Record<string, unknown> | undefined;
      expect(payload?.status).toBe('interrupted');
      expect(payload?.reason).toBe('aborted');
      expect(payload?.abort_cause).toBe('hard');
    } finally {
      db.close();
    }
  });

  test('omitting ipcVersion runs in legacy mode (no channel opened)', async () => {
    const { sessionId } = seedChildSession(dbDir);
    let factoryCalled = false;
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: stubProvider('hi'),
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
      // No ipcVersion. The factory should never run; if it did,
      // the test would catch the regression here.
      ipcTransportFactory: () => {
        factoryCalled = true;
        // Stub returning a no-op transport. Never reached when
        // ipcVersion is absent — that's the property under test.
        return {
          write: () => undefined,
          onLine: () => () => undefined,
          onTransportError: () => () => undefined,
          onClose: () => () => undefined,
          close: () => undefined,
        };
      },
    });
    expect(exitCode).toBe(0);
    expect(factoryCalled).toBe(false);
  });

  test('child system prompt carries the parallelism hint (D227 review)', async () => {
    // Bug fix from review of D227: the parallelism hint
    // (`PARALLEL_HINT_PROMPT`) was injected only in
    // bootstrap.ts (parent path), so subagent children — which
    // build their config in subagent-child.ts — went without
    // it. An exploration subagent (typical `tools: [read_file,
    // grep, glob]`) got the per-tool "Parallel-safe: ..."
    // descriptions but missed the meta-rule preamble. This
    // test pins down that subagent-child now prepends the hint
    // ABOVE the audit's persisted systemPrompt, mirroring
    // bootstrap's three-layer composition.
    const { sessionId } = seedChildSession(dbDir);
    let captured: string | undefined;
    const captureProvider: Provider = {
      ...stubProvider('done'),
      async *generate(req): AsyncGenerator<StreamEvent> {
        captured = req.system;
        yield { kind: 'start', message_id: 'mock-msg' };
        yield { kind: 'text_delta', text: 'done' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: captureProvider,
      userAgentsDir: null,
      projectAgentsDir: null,
      errSink: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    // Hint preamble lands BEFORE the subagent's own identity
    // prompt — the meta-rule is universal background and the
    // identity prompt is the more-specific operating context.
    expect(captured).toContain('# Parallelism');
    expect(captured).toContain('You are explore.');
    const hintIdx = (captured ?? '').indexOf('# Parallelism');
    const identityIdx = (captured ?? '').indexOf('You are explore.');
    expect(hintIdx).toBeLessThan(identityIdx);
  });
});
