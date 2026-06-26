// Integration coverage for §4.4 proactive injection THROUGH the harness loop —
// the orchestration the unit tests don't exercise: loop.ts builds the recall fn
// only when the flag is on (and depth 0), injects the block at the turn tail
// before the provider call, and records provenance on recompute. Drives a real
// `runAgent` with a mock provider that captures the request it receives.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/harness/loop.ts';
import { type ScopeRoots, rootForScope } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider } from '../../src/providers/index.ts';
import { estimateMessagesTokens } from '../../src/providers/tokens.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

// Minimal provider: one text-only turn, capturing every request it's handed so
// the test can inspect what the loop actually put on the wire.
const mockProvider = (): { provider: Provider; requests: GenerateRequest[] } => {
  const requests: GenerateRequest[] = [];
  const provider: Provider = {
    id: 'mock/m',
    family: 'anthropic',
    capabilities: {
      tools: 'native',
      cache: false,
      vision: false,
      streaming: true,
      constrained: 'tools',
      context_window: 200_000,
      output_max_tokens: 4096,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate(req) {
      requests.push(req);
      yield { kind: 'start', message_id: 'm1' };
      yield { kind: 'text_delta', text: 'ok' };
      yield { kind: 'stop', reason: 'end_turn' };
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: (m) => Promise.resolve(estimateMessagesTokens(m)),
  };
  return { provider, requests };
};

let db: DB;
const tmps: string[] = [];

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});
afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

const seedMemory = (roots: ScopeRoots, name: string, description: string, body: string): void => {
  const dir = rootForScope(roots, 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ntype: feedback\nsource: inferred\n---\n\n${body}\n`,
  );
  const indexPath = join(dir, 'MEMORY.md');
  const line = `- [${description}](${name}.md) — ${description}\n`;
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Memory index\n\n';
  writeFileSync(indexPath, current + line);
};

// A 3-memory corpus calibrated like eval fixture 01 so "auth" clears the BM25
// floor — a single-memory corpus collapses IDF below it.
const seedCorpus = (): ScopeRoots => {
  const base = mkdtempSync(join(tmpdir(), 'forja-proactive-loop-'));
  tmps.push(base);
  const roots: ScopeRoots = {
    user: join(base, 'user'),
    projectShared: join(base, 'shared'),
    projectLocal: join(base, 'local'),
  };
  seedMemory(
    roots,
    'jwt-auth',
    'authentication token handling',
    'Use short-lived JWT bearer tokens for authentication. Validate the token signature and reject expired auth tokens.',
  );
  seedMemory(
    roots,
    'css-naming',
    'css class naming convention',
    'Prefer BEM naming for CSS classes.',
  );
  seedMemory(roots, 'git-rebase', 'git branch workflow', 'Rebase feature branches onto main.');
  return roots;
};

const lastUserText = (req: GenerateRequest): string => {
  const last = req.messages[req.messages.length - 1];
  const c = last?.content;
  if (typeof c === 'string') return c;
  return (c ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
};

const baseConfig = (roots: ScopeRoots) => {
  const registrySession = createSession(db, { model: 'mock/m', cwd: '/p' }).id;
  const registry = createMemoryRegistry({ roots, db, sessionId: registrySession });
  const { provider, requests } = mockProvider();
  return {
    requests,
    config: {
      provider,
      toolRegistry: createToolRegistry(),
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'strict' as const }, tools: {} },
        { cwd: '/p' },
      ),
      db,
      cwd: '/p',
      userPrompt: 'how should we handle auth tokens on the API',
      memoryRegistry: registry,
    },
  };
};

describe('proactive injection through the loop (§4.4)', () => {
  test('flag ON: injects the recalled block into the request + records proactive provenance', async () => {
    const { requests, config } = baseConfig(seedCorpus());
    const result = await runAgent({ ...config, memoryProactiveInject: true });
    expect(result.status).toBe('done');

    // 1. the block rode the turn tail (the last user message), with the body.
    const text = lastUserText(requests[0] as GenerateRequest);
    expect(text).toContain('how should we handle auth tokens'); // original prompt intact
    expect(text).toContain('# Recalled for this turn');
    expect(text).toContain('memory:user/jwt-auth');
    expect(text).toContain('JWT bearer tokens');
    // I3: the noise memories did not surface.
    expect(text).not.toContain('memory:user/css-naming');

    // 2. I5: a proactive provenance row landed for the injected memory, shaped
    //    like eager (tool_call_id NULL).
    const rows = db
      .query("SELECT memory_name, tool_call_id FROM memory_provenance WHERE surface = 'proactive'")
      .all() as Array<{ memory_name: string; tool_call_id: string | null }>;
    expect(rows.some((r) => r.memory_name === 'jwt-auth')).toBe(true);
    expect(rows.every((r) => r.tool_call_id === null)).toBe(true);
  });

  test('flag OFF (explicit): no block injected, no proactive provenance', async () => {
    const { requests, config } = baseConfig(seedCorpus());
    // §4.4 default is now ON; the operator opts OUT with the flag false.
    const result = await runAgent({ ...config, memoryProactiveInject: false });
    expect(result.status).toBe('done');

    const text = lastUserText(requests[0] as GenerateRequest);
    expect(text).toContain('how should we handle auth tokens');
    expect(text).not.toContain('# Recalled for this turn');

    const rows = db.query("SELECT 1 FROM memory_provenance WHERE surface = 'proactive'").all();
    expect(rows).toHaveLength(0);
  });
});
