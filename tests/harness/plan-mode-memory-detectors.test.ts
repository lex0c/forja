// Plan-mode guard on memory governance detector schedulers
// (post-review fix). `--plan` declares a read-only session — the
// LLM-judge detectors (verify_failed/S11, conflict_detected/S13,
// user_override_repeated/S3) write memory_verify_attempts rows AND
// (on negative verdicts) governance proposals into
// memory_governance_proposals. Both are writes against the
// governance substrate that contradict the operator's "show me
// what you'd do, don't write" framing.
//
// Pre-fix the construction gate didn't include planMode, so plan
// runs still spawned verify subagents (charging API cost) and
// landed audit rows the operator never asked for. The fix adds
// `config.planMode !== true` to all three construction gates and
// emits a single-line stderr advisory per enabled-but-suppressed
// detector so the operator sees what's NOT happening.

import { beforeEach, describe, expect, test } from 'bun:test';
import { runAgent } from '../../src/harness/loop.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

const mockProvider = (): Provider => ({
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
    yield { kind: 'start', message_id: 'm' };
    yield { kind: 'text_delta', text: 'ok' };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

let db: DB;
let stderrCaptured: string[];
let restoreStderr: () => void;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  stderrCaptured = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrCaptured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  restoreStderr = () => {
    process.stderr.write = original;
  };
});

const finish = () => restoreStderr();

describe('plan-mode gate on memory governance detector schedulers', () => {
  test('verify-semantic: emits plan-mode advisory + does not spawn', async () => {
    try {
      const result = await runAgent({
        provider: mockProvider(),
        toolRegistry: createToolRegistry(),
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        planMode: true,
        memorySemanticVerify: true,
      });
      expect(result.status).toBe('done');
    } finally {
      finish();
    }
    const joined = stderrCaptured.join('');
    expect(joined).toContain('verify_semantic_disabled: plan mode active');
    expect(joined).toContain('no governance writes');
    // The construction-side warnings (`memory registry not wired`,
    // `definition not loaded`) must NOT also fire — plan-mode gate
    // is reached BEFORE those, so the operator sees one clean
    // advisory rather than a confusing stack of "disabled" lines.
    expect(joined).not.toContain('memory registry not wired');
    expect(joined).not.toContain('verify-semantic definition not loaded');
  });

  test('verify-conflict: emits plan-mode advisory', async () => {
    try {
      await runAgent({
        provider: mockProvider(),
        toolRegistry: createToolRegistry(),
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        planMode: true,
        memoryConflictDetect: true,
      });
    } finally {
      finish();
    }
    const joined = stderrCaptured.join('');
    expect(joined).toContain('verify_conflict_disabled: plan mode active');
    expect(joined).toContain('no governance writes');
  });

  test('verify-override: emits plan-mode advisory', async () => {
    try {
      await runAgent({
        provider: mockProvider(),
        toolRegistry: createToolRegistry(),
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        planMode: true,
        memoryOverrideDetect: true,
      });
    } finally {
      finish();
    }
    const joined = stderrCaptured.join('');
    expect(joined).toContain('verify_override_disabled: plan mode active');
    expect(joined).toContain('no governance writes');
  });

  test('all three detectors in plan mode: emits three advisories independently', async () => {
    // Operator with default-on detectors flipping into plan mode
    // should see one line per detector — not a mashed-up summary
    // and not "memory: governance disabled" that loses which
    // detector was affected.
    try {
      await runAgent({
        provider: mockProvider(),
        toolRegistry: createToolRegistry(),
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        planMode: true,
        memorySemanticVerify: true,
        memoryConflictDetect: true,
        memoryOverrideDetect: true,
      });
    } finally {
      finish();
    }
    const joined = stderrCaptured.join('');
    expect(joined).toContain('verify_semantic_disabled: plan mode active');
    expect(joined).toContain('verify_conflict_disabled: plan mode active');
    expect(joined).toContain('verify_override_disabled: plan mode active');
  });

  test('non-plan mode + memorySemanticVerify=true: does NOT emit plan-mode advisory', async () => {
    // Negative pin: plan-mode advisory is gated; the regular
    // construction path emits its own messages (registry missing
    // etc.) but NOT the plan-mode one.
    try {
      await runAgent({
        provider: mockProvider(),
        toolRegistry: createToolRegistry(),
        permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
        db,
        cwd: '/p',
        userPrompt: 'hi',
        planMode: false,
        memorySemanticVerify: true,
      });
    } finally {
      finish();
    }
    const joined = stderrCaptured.join('');
    expect(joined).not.toContain('plan mode active');
  });
});
