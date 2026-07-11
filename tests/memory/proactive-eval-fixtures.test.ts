import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixture as f01 } from '../../evals/memory/proactive/fixtures/01-useful-recall-vs-noise.ts';
import { fixture as f02 } from '../../evals/memory/proactive/fixtures/02-nothing-relevant-injects-nothing.ts';
import { fixture as f03 } from '../../evals/memory/proactive/fixtures/03-i3-untrusted-keyword-stuffing.ts';
import { fixture as f04 } from '../../evals/memory/proactive/fixtures/04-i3-quarantined-keyword-stuffing.ts';
import { fixture as f05 } from '../../evals/memory/proactive/fixtures/05-top-k-cap.ts';
import { fixture as f06 } from '../../evals/memory/proactive/fixtures/06-trigger-prompt-mention.ts';
import type {
  ProactiveFixtureMemory,
  ProactiveRecallFixture,
} from '../../evals/memory/proactive/fixtures/types.ts';
import {
  createProactiveRecall,
  formatProactiveRecallBlock,
} from '../../src/harness/proactive-memory-inject.ts';
import { rootForScope, type ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const FIXTURES: readonly ProactiveRecallFixture[] = [f01, f02, f03, f04, f05, f06];

// Seed one memory onto disk + into its scope's MEMORY.md index. `type`/`source`
// are fixed (the recall doesn't read them); state/trust/triggers ride the
// frontmatter. Without the index line the registry returns kind='unknown', so
// every fixture memory must be listed.
const seedMemory = (roots: ScopeRoots, mem: ProactiveFixtureMemory): void => {
  const scopeRoot = rootForScope(roots, mem.scope);
  mkdirSync(scopeRoot, { recursive: true });
  const lines = [
    `name: ${mem.name}`,
    `description: ${mem.description}`,
    'type: feedback',
    'source: inferred',
  ];
  if (mem.state !== undefined) lines.push(`state: ${mem.state}`);
  if (mem.trust !== undefined) lines.push(`trust: ${mem.trust}`);
  if (mem.triggers !== undefined) lines.push(`triggers: [${mem.triggers.join(', ')}]`);
  writeFileSync(
    join(scopeRoot, `${mem.name}.md`),
    `---\n${lines.join('\n')}\n---\n\n${mem.body}\n`,
  );

  const indexPath = join(scopeRoot, 'MEMORY.md');
  const indexLine = `- [${mem.description}](${mem.name}.md) — ${mem.description}\n`;
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# Memory index\n\n';
  writeFileSync(indexPath, current + indexLine);
};

interface EvalContext {
  db: ReturnType<typeof openMemoryDb>;
  roots: ScopeRoots;
  sessionId: string;
  tmps: string[];
}

const setup = (): EvalContext => {
  const base = mkdtempSync(join(tmpdir(), 'forja-proactive-eval-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'forja-proactive-eval-user-'));
  const roots: ScopeRoots = {
    user: userRoot,
    projectShared: join(base, 'shared'),
    projectLocal: join(base, 'local'),
  };
  mkdirSync(roots.projectShared, { recursive: true });
  mkdirSync(roots.projectLocal, { recursive: true });
  const db = openMemoryDb();
  migrate(db);
  const sessionId = createSession(db, { model: 'test/model', cwd: base }).id;
  return { db, roots, sessionId, tmps: [base, userRoot] };
};

let active: EvalContext | undefined;
beforeEach(() => {
  active = undefined;
});
afterEach(() => {
  if (active !== undefined) {
    active.db.close();
    for (const d of active.tmps) rmSync(d, { recursive: true, force: true });
  }
});

describe('proactive recall eval — fixture suite (evals/memory/proactive/)', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name}: ${fx.description}`, async () => {
      const ctx = setup();
      active = ctx;
      for (const mem of fx.memories) seedMemory(ctx.roots, mem);
      const registry = createMemoryRegistry({
        roots: ctx.roots,
        db: ctx.db,
        sessionId: ctx.sessionId,
      });
      // Production defaults: the real BM25 floor (1.0) + top-K (3). No minScore
      // override — the eval measures the shipping behavior, not isolated wiring.
      const recall = createProactiveRecall({ registry });
      const recalled = await recall({ goalText: fx.goalText, prompt: fx.prompt });
      const ids = recalled.map((r) => r.nodeId);

      if (fx.expected.recalls !== undefined) {
        for (const id of fx.expected.recalls) expect(ids).toContain(id);
      }
      if (fx.expected.excludes !== undefined) {
        for (const id of fx.expected.excludes) expect(ids).not.toContain(id);
      }
      if (fx.expected.count !== undefined) {
        expect(ids).toHaveLength(fx.expected.count);
      }
      if (fx.expected.maxBlockChars !== undefined) {
        const block = formatProactiveRecallBlock(recalled) ?? '';
        expect(block.length).toBeLessThanOrEqual(fx.expected.maxBlockChars);
      }
    });
  }
});
