import { describe, expect, test } from 'bun:test';
import {
  INDEX_LINE_SOFT_MAX,
  IndexError,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
  upsertIndexEntry,
} from '../../src/memory/index-file.ts';
import type { IndexEntry } from '../../src/memory/types.ts';

describe('parseIndex', () => {
  test('parses canonical entries with em-dash', () => {
    const raw = `- [User role](user-role.md) — full-stack TS dev
- [Commit style](commit-style.md) — Title Case in commits
`;
    const { entries, malformedLines } = parseIndex(raw);
    expect(malformedLines).toEqual([]);
    expect(entries).toEqual([
      { title: 'User role', href: 'user-role.md', hook: 'full-stack TS dev' },
      { title: 'Commit style', href: 'commit-style.md', hook: 'Title Case in commits' },
    ]);
  });

  test('accepts ASCII hyphen separator as fallback', () => {
    const raw = `- [User role](user-role.md) - full-stack TS dev
`;
    const { entries } = parseIndex(raw);
    expect(entries).toEqual([
      { title: 'User role', href: 'user-role.md', hook: 'full-stack TS dev' },
    ]);
  });

  test('skips blank lines and comment-style headings', () => {
    const raw = `# Memory index

> Auto-managed by the agent.

- [A](a.md) — first
`;
    const { entries, malformedLines } = parseIndex(raw);
    expect(malformedLines).toEqual([]);
    expect(entries).toEqual([{ title: 'A', href: 'a.md', hook: 'first' }]);
  });

  test('reports malformed entry-shaped lines', () => {
    const raw = `- malformed line without brackets
- [Valid](valid.md) — ok
- [Missing paren close](broken.md - bad
`;
    const { entries, malformedLines } = parseIndex(raw);
    expect(entries).toEqual([{ title: 'Valid', href: 'valid.md', hook: 'ok' }]);
    expect(malformedLines).toEqual([1, 3]);
  });

  test('handles CRLF input', () => {
    const raw = '- [A](a.md) — first\r\n- [B](b.md) — second\r\n';
    const { entries } = parseIndex(raw);
    expect(entries).toHaveLength(2);
  });
});

describe('serializeIndex', () => {
  test('emits canonical em-dash output with trailing newline', () => {
    const entries: IndexEntry[] = [
      { title: 'A', href: 'a.md', hook: 'first' },
      { title: 'B', href: 'b.md', hook: 'second' },
    ];
    const { text, oversizedEntries } = serializeIndex(entries);
    expect(text).toBe('- [A](a.md) — first\n- [B](b.md) — second\n');
    expect(oversizedEntries).toEqual([]);
  });

  test('round-trips parse → serialize for canonical entries', () => {
    const raw = `- [User role](user-role.md) — full-stack TS dev
- [Commit style](commit-style.md) — Title Case in commits
`;
    const { entries } = parseIndex(raw);
    const { text } = serializeIndex(entries);
    expect(text).toBe(raw);
  });

  test('prepends header when provided', () => {
    const entries: IndexEntry[] = [{ title: 'A', href: 'a.md', hook: 'h' }];
    const { text } = serializeIndex(entries, { header: '# Index' });
    expect(text).toBe('# Index\n\n- [A](a.md) — h\n');
  });

  test('returns empty string when entries empty and no header', () => {
    const { text } = serializeIndex([]);
    expect(text).toBe('');
  });

  test('reports oversized entries by index', () => {
    const longHook = 'x'.repeat(INDEX_LINE_SOFT_MAX);
    const entries: IndexEntry[] = [
      { title: 'A', href: 'a.md', hook: 'short' },
      { title: 'B', href: 'b.md', hook: longHook },
    ];
    const { oversizedEntries } = serializeIndex(entries);
    expect(oversizedEntries).toEqual([1]);
  });

  test('throws when total lines exceed hard cap of 200', () => {
    const entries: IndexEntry[] = Array.from({ length: 201 }, (_, i) => ({
      title: `T${i}`,
      href: `${i}.md`,
      hook: 'hook',
    }));
    expect(() => serializeIndex(entries)).toThrow(IndexError);
  });
});

describe('upsertIndexEntry', () => {
  const seed: IndexEntry[] = [
    { title: 'A', href: 'a.md', hook: 'old-A' },
    { title: 'B', href: 'b.md', hook: 'B' },
  ];

  test('replaces by href when present', () => {
    const next = upsertIndexEntry(seed, { title: 'A', href: 'a.md', hook: 'new-A' });
    expect(next).toHaveLength(2);
    expect(next[0]?.hook).toBe('new-A');
    // Input is not mutated.
    expect(seed[0]?.hook).toBe('old-A');
  });

  test('appends when href is new', () => {
    const next = upsertIndexEntry(seed, { title: 'C', href: 'c.md', hook: 'C' });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ title: 'C', href: 'c.md', hook: 'C' });
  });
});

describe('removeIndexEntry', () => {
  test('removes by href', () => {
    const seed: IndexEntry[] = [
      { title: 'A', href: 'a.md', hook: 'A' },
      { title: 'B', href: 'b.md', hook: 'B' },
    ];
    expect(removeIndexEntry(seed, 'a.md')).toEqual([{ title: 'B', href: 'b.md', hook: 'B' }]);
  });

  test('no-op when href absent', () => {
    const seed: IndexEntry[] = [{ title: 'A', href: 'a.md', hook: 'A' }];
    expect(removeIndexEntry(seed, 'missing.md')).toEqual(seed);
  });
});
