import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRoutingMetrics,
  loadPlaybookFixtures,
  loadRoutingFixtures,
} from '../../src/evals/playbook-fixtures.ts';

// Helper: stage a temp eval root and return paths.
const stageEvalRoot = (): string => mkdtempSync(join(tmpdir(), 'forja-eval-fx-'));

describe('loadPlaybookFixtures (bundled)', () => {
  test('every shipped per-playbook stub loads cleanly', () => {
    const root = join(import.meta.dir, '../../evals/playbooks');
    const fixtures = loadPlaybookFixtures(root);
    // One stub per canonical playbook — the count anchors the
    // contract that every bundled playbook has at least one
    // regression entry.
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    const playbookNames = new Set(fixtures.map((f) => f.playbook));
    expect(playbookNames).toContain('code-review');
    expect(playbookNames).toContain('security-audit');
    expect(playbookNames).toContain('perf-investigate');
    expect(playbookNames).toContain('gap-audit');
    expect(playbookNames).toContain('challenge-assumptions');
  });

  test('every fixture references its own directory as the playbook name', () => {
    // The cross-check inside the loader catches misfiled
    // fixtures; this test assertion is the regression guard for
    // an author who forgets to rename one of the two coordinates.
    const root = join(import.meta.dir, '../../evals/playbooks');
    const fixtures = loadPlaybookFixtures(root);
    for (const f of fixtures) {
      expect(f.playbook).toBe(f.directory);
    }
  });
});

describe('loadRoutingFixtures (bundled)', () => {
  test('the bundled routing set covers dispatch / none / ambiguous', () => {
    const root = join(import.meta.dir, '../../evals/playbooks');
    const routing = loadRoutingFixtures(root);
    expect(routing.length).toBeGreaterThanOrEqual(4);
    const flavors = new Set(routing.map((r) => r.expectDispatch));
    expect(flavors).toContain('none');
    expect(flavors).toContain('ambiguous');
    // At least one specific playbook dispatch.
    const specifics = routing.filter(
      (r) => r.expectDispatch !== 'none' && r.expectDispatch !== 'ambiguous',
    );
    expect(specifics.length).toBeGreaterThan(0);
  });
});

describe('loadPlaybookFixtures — shape validation', () => {
  test('rejects missing required fields with source-aware error', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, 'code-review'), { recursive: true });
      writeFileSync(join(root, 'code-review', 'broken.yaml'), 'name: only-this\n');
      expect(() => loadPlaybookFixtures(root)).toThrow(/'playbook'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unknown top-level key', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, 'code-review'), { recursive: true });
      writeFileSync(
        join(root, 'code-review', 'broken.yaml'),
        'name: x-test\nplaybook: code-review\nprompt: "p"\nbogus_key: 1\n',
      );
      expect(() => loadPlaybookFixtures(root)).toThrow(/bogus_key.*recognized/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects mismatch between playbook field and directory', () => {
    // The cross-check is the meaningful guard: an author who
    // moves a `code-review` fixture into the `debug/` directory
    // would otherwise silently dispatch the wrong playbook
    // when the runner consumes the fixtures.
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, 'debug'), { recursive: true });
      writeFileSync(
        join(root, 'debug', 'misfiled.yaml'),
        'name: x-test\nplaybook: code-review\nprompt: "p"\n',
      );
      expect(() => loadPlaybookFixtures(root)).toThrow(/'playbook' is 'code-review'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unknown expectation key', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, 'code-review'), { recursive: true });
      writeFileSync(
        join(root, 'code-review', 'bad-expect.yaml'),
        `name: x
playbook: code-review
prompt: p
expect:
  bogus: true
`,
      );
      expect(() => loadPlaybookFixtures(root)).toThrow(/expect.bogus.*recognized/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips dirs starting with underscore (reserved for routing)', () => {
    // The discovery loop excludes `_routing` (and any other
    // future `_*` namespaces) so an author can store sibling
    // collections without the per-playbook loader picking
    // them up.
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, '_routing'), { recursive: true });
      writeFileSync(
        join(root, '_routing', 'should-be-ignored.yaml'),
        'name: ignore-me\nplaybook: x\nprompt: p\n',
      );
      const fixtures = loadPlaybookFixtures(root);
      expect(fixtures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadRoutingFixtures — shape validation', () => {
  test('rejects unknown top-level key', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, '_routing'), { recursive: true });
      writeFileSync(
        join(root, '_routing', 'bad.yaml'),
        'name: x\nprompt: p\nexpect_dispatch: code-review\nextra: 1\n',
      );
      expect(() => loadRoutingFixtures(root)).toThrow(/extra.*recognized/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects ambiguous_acceptable when expect_dispatch is not ambiguous', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, '_routing'), { recursive: true });
      writeFileSync(
        join(root, '_routing', 'mismatch.yaml'),
        'name: x\nprompt: p\nexpect_dispatch: code-review\nambiguous_acceptable: [debug]\n',
      );
      expect(() => loadRoutingFixtures(root)).toThrow(
        /only valid when expect_dispatch is 'ambiguous'/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts a sentinel expect_dispatch (none)', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, '_routing'), { recursive: true });
      writeFileSync(
        join(root, '_routing', 'no-dispatch.yaml'),
        'name: q\nprompt: where\nexpect_dispatch: none\n',
      );
      const out = loadRoutingFixtures(root);
      expect(out).toHaveLength(1);
      expect(out[0]?.expectDispatch).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed expect_dispatch (not a sentinel and not kebab-case)', () => {
    const root = stageEvalRoot();
    try {
      mkdirSync(join(root, '_routing'), { recursive: true });
      writeFileSync(
        join(root, '_routing', 'bad-dispatch.yaml'),
        'name: q\nprompt: p\nexpect_dispatch: NotKebab\n',
      );
      expect(() => loadRoutingFixtures(root)).toThrow(/'expect_dispatch'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeRoutingMetrics', () => {
  // Synthetic fixtures so we can pin the math without depending
  // on the bundled set's contents.
  const mkFixture = (
    expectDispatch: string,
    ambiguousAcceptable?: string[],
  ): import('../../src/evals/playbook-fixtures.ts').RoutingFixture => ({
    name: 'x',
    prompt: 'p',
    expectDispatch,
    ...(ambiguousAcceptable !== undefined ? { ambiguousAcceptable } : {}),
    sourcePath: '/fake',
  });

  test('all-correct yields zero rates', () => {
    const m = computeRoutingMetrics([
      { fixture: mkFixture('code-review'), observed: 'code-review' },
      { fixture: mkFixture('debug'), observed: 'debug' },
      { fixture: mkFixture('none'), observed: 'none' },
    ]);
    expect(m.total).toBe(3);
    expect(m.wrongDispatchRate).toBe(0);
    expect(m.falseDispatchRate).toBe(0);
    expect(m.missedDispatchRate).toBe(0);
  });

  test('wrong dispatch (specific → different specific) increments wrong', () => {
    const m = computeRoutingMetrics([
      { fixture: mkFixture('code-review'), observed: 'security-audit' },
    ]);
    expect(m.wrongDispatchCount).toBe(1);
    expect(m.wrongDispatchRate).toBe(1);
    expect(m.missedDispatchCount).toBe(0);
  });

  test('missed dispatch (specific → none) increments missed', () => {
    const m = computeRoutingMetrics([{ fixture: mkFixture('code-review'), observed: 'none' }]);
    expect(m.missedDispatchCount).toBe(1);
    expect(m.missedDispatchRate).toBe(1);
    expect(m.wrongDispatchCount).toBe(0);
  });

  test('false dispatch (none → specific) increments false', () => {
    const m = computeRoutingMetrics([{ fixture: mkFixture('none'), observed: 'code-review' }]);
    expect(m.falseDispatchCount).toBe(1);
    expect(m.falseDispatchRate).toBe(1);
  });

  test('ambiguous accepts any of the listed playbooks', () => {
    const m = computeRoutingMetrics([
      {
        fixture: mkFixture('ambiguous', ['code-review', 'security-audit']),
        observed: 'security-audit',
      },
    ]);
    expect(m.wrongDispatchCount).toBe(0);
    expect(m.ambiguousWrongCount).toBe(0);
  });

  test('ambiguous out-of-set counts as wrong', () => {
    const m = computeRoutingMetrics([
      {
        fixture: mkFixture('ambiguous', ['code-review', 'security-audit']),
        observed: 'debug',
      },
    ]);
    expect(m.ambiguousWrongCount).toBe(1);
    expect(m.wrongDispatchCount).toBe(1);
  });

  test('ambiguous → none is acceptable (clarifying-question response)', () => {
    const m = computeRoutingMetrics([
      { fixture: mkFixture('ambiguous', ['code-review']), observed: 'none' },
    ]);
    expect(m.ambiguousWrongCount).toBe(0);
    expect(m.missedDispatchCount).toBe(0);
  });

  test('empty observation set yields zero rates without divide-by-zero', () => {
    const m = computeRoutingMetrics([]);
    expect(m.total).toBe(0);
    expect(m.wrongDispatchRate).toBe(0);
    expect(m.falseDispatchRate).toBe(0);
    expect(m.missedDispatchRate).toBe(0);
  });
});
