import { describe, expect, test } from 'bun:test';
import type { CapabilityKind } from '../../src/permissions/capabilities.ts';
import {
  buildContextSummary,
  type ContextSummaryEntry,
  createContextSummaryBuffer,
  DEFAULT_CONTEXT_SUMMARY_DEPTH,
  DEFAULT_CONTEXT_SUMMARY_MAX_BYTES,
} from '../../src/permissions/context-summary.ts';

const entry = (
  toolName: string,
  decision: 'allow' | 'deny' | 'confirm',
  capabilityKinds: readonly CapabilityKind[],
): ContextSummaryEntry => ({ toolName, decision, capabilityKinds });

describe('buildContextSummary — format', () => {
  test('empty buffer returns empty string', () => {
    expect(buildContextSummary([])).toBe('');
  });

  test('single entry renders one line', () => {
    const r = buildContextSummary([entry('bash', 'allow', ['read-fs', 'exec'])]);
    // Kinds sort alphabetically for determinism.
    expect(r).toBe('step 1: tool=bash decision=allow caps=exec,read-fs');
  });

  test('multiple entries render newline-separated', () => {
    const r = buildContextSummary([
      entry('bash', 'allow', ['read-fs']),
      entry('write_file', 'confirm', ['write-fs']),
      entry('fetch_url', 'deny', ['net-egress']),
    ]);
    const lines = r.split('\n');
    expect(lines).toEqual([
      'step 1: tool=bash decision=allow caps=read-fs',
      'step 2: tool=write_file decision=confirm caps=write-fs',
      'step 3: tool=fetch_url decision=deny caps=net-egress',
    ]);
  });

  test('empty capability kinds render as `caps=-`', () => {
    const r = buildContextSummary([entry('todo_create', 'allow', [])]);
    expect(r).toBe('step 1: tool=todo_create decision=allow caps=-');
  });

  test('kinds are sorted alphabetically (replay determinism)', () => {
    const a = buildContextSummary([entry('bash', 'allow', ['exec', 'read-fs', 'net-egress'])]);
    const b = buildContextSummary([entry('bash', 'allow', ['net-egress', 'read-fs', 'exec'])]);
    expect(a).toBe(b);
    expect(a).toContain('caps=exec,net-egress,read-fs');
  });
});

describe('buildContextSummary — byte cap', () => {
  test('cap of 0 returns empty string regardless of buffer', () => {
    const r = buildContextSummary([entry('bash', 'allow', ['read-fs'])], { maxBytes: 0 });
    expect(r).toBe('');
  });

  test('cap smaller than the first line drops everything', () => {
    // First line is 50 bytes; cap=10 → empty.
    const r = buildContextSummary([entry('bash', 'allow', ['read-fs', 'exec'])], {
      maxBytes: 10,
    });
    expect(r).toBe('');
  });

  test('cap stops at the boundary, no `...` marker', () => {
    // Three entries: ~45 bytes each. cap=100 → only first two fit
    // (45 + 1 + 45 = 91 ≤ 100; 91 + 1 + 45 = 137 > 100 → stop).
    const r = buildContextSummary(
      [
        entry('a', 'allow', ['read-fs']),
        entry('b', 'allow', ['read-fs']),
        entry('c', 'allow', ['read-fs']),
      ],
      { maxBytes: 100 },
    );
    expect(r.split('\n').length).toBe(2);
    expect(r).not.toContain('...');
  });

  test('default cap matches the exported constant', () => {
    // Build a buffer that overshoots the default and confirm the
    // truncation kicked in at that constant.
    const buf: ContextSummaryEntry[] = [];
    for (let i = 0; i < 50; i += 1) buf.push(entry('bash', 'allow', ['read-fs', 'exec']));
    const r = buildContextSummary(buf);
    expect(r.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_SUMMARY_MAX_BYTES);
  });
});

describe('createContextSummaryBuffer — ring eviction', () => {
  test('default depth uses the exported constant', () => {
    const buf = createContextSummaryBuffer();
    for (let i = 0; i < DEFAULT_CONTEXT_SUMMARY_DEPTH + 5; i += 1) {
      buf.push(entry('bash', 'allow', ['read-fs']));
    }
    expect(buf.size()).toBe(DEFAULT_CONTEXT_SUMMARY_DEPTH);
  });

  test('pushes beyond depth evict the oldest entries', () => {
    const buf = createContextSummaryBuffer(3);
    buf.push(entry('a', 'allow', []));
    buf.push(entry('b', 'allow', []));
    buf.push(entry('c', 'allow', []));
    buf.push(entry('d', 'allow', []));
    const snap = buf.snapshot();
    expect(snap.map((e) => e.toolName)).toEqual(['b', 'c', 'd']);
  });

  test('snapshot returns chronological order (oldest first)', () => {
    const buf = createContextSummaryBuffer(5);
    buf.push(entry('first', 'allow', []));
    buf.push(entry('second', 'allow', []));
    expect(buf.snapshot().map((e) => e.toolName)).toEqual(['first', 'second']);
  });

  test('snapshot is a defensive copy (mutation does not corrupt the buffer)', () => {
    const buf = createContextSummaryBuffer(5);
    buf.push(entry('original', 'allow', []));
    const snap = buf.snapshot();
    snap.push(entry('mutated', 'allow', []));
    expect(buf.size()).toBe(1);
    expect(buf.snapshot().map((e) => e.toolName)).toEqual(['original']);
  });
});

describe('sanitization invariants (§6.4)', () => {
  // The entry shape literally has no field for raw args / outputs /
  // scopes — these tests pin the structural defense.
  test('entries only carry toolName + decision + capabilityKinds', () => {
    const e = entry('bash', 'allow', ['read-fs']);
    const keys = Object.keys(e).sort();
    expect(keys).toEqual(['capabilityKinds', 'decision', 'toolName']);
  });

  test('output string never includes scope-shaped fragments', () => {
    // The renderer drops scopes by construction (only KIND is read).
    // Pin the behavior: the rendered line for a `read-fs` cap does
    // NOT include any `:` or path-like characters.
    const r = buildContextSummary([entry('bash', 'allow', ['read-fs'])]);
    expect(r).toBe('step 1: tool=bash decision=allow caps=read-fs');
    expect(r).not.toMatch(/read-fs:/);
  });
});
