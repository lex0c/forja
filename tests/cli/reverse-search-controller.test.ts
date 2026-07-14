import { beforeEach, describe, expect, test } from 'bun:test';
import { ReverseSearchController } from '../../src/cli/reverse-search-controller.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { appendHistory } from '../../src/storage/history.ts';
import { migrate } from '../../src/storage/migrate.ts';
import type { Bus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';

let db: DB;
let events: UIEvent[];

const make = (): ReverseSearchController => {
  events = [];
  const bus = { emit: (e: UIEvent) => events.push(e) } as unknown as Bus;
  return new ReverseSearchController({ db, cwd: '/p', bus, now: () => 0 });
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  // Newest last → searchHistory returns newest-first.
  appendHistory(db, '/p', 'git status');
  appendHistory(db, '/p', 'deploy staging');
  appendHistory(db, '/p', 'deploy prod');
});

describe('ReverseSearchController', () => {
  test('open emits an update with the empty query and no results', () => {
    const rs = make();
    expect(rs.isOpen()).toBe(false);
    rs.open();
    expect(rs.isOpen()).toBe(true);
    expect(rs.query()).toBe('');
    expect(events.at(-1)).toMatchObject({ type: 'reverse-search:update', query: '', results: [] });
    expect(rs.currentMatch()).toBeNull(); // empty query → no match
  });

  test('open is idempotent (a second open does not re-refresh)', () => {
    const rs = make();
    rs.open();
    const n = events.length;
    rs.open();
    expect(events.length).toBe(n);
  });

  test('refresh finds matching history newest-first and selects the newest', () => {
    const rs = make();
    rs.refresh('deploy');
    expect(rs.query()).toBe('deploy');
    expect(rs.currentMatch()).toBe('deploy prod'); // newest match at idx 0
    expect(events.at(-1)).toMatchObject({
      type: 'reverse-search:update',
      query: 'deploy',
      results: ['deploy prod', 'deploy staging'],
      selectedIdx: 0,
    });
  });

  test('cycleOlder advances toward older matches and clamps at the oldest', () => {
    const rs = make();
    rs.refresh('deploy');
    rs.cycleOlder();
    expect(rs.currentMatch()).toBe('deploy staging'); // idx 1
    rs.cycleOlder(); // already at oldest of two → no-op
    expect(rs.currentMatch()).toBe('deploy staging');
  });

  test('close resets the state and emits reverse-search:close', () => {
    const rs = make();
    rs.refresh('deploy');
    rs.close();
    expect(rs.isOpen()).toBe(false);
    expect(rs.query()).toBeNull();
    expect(rs.currentMatch()).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: 'reverse-search:close' });
  });

  test('cycleOlder is a no-op when the overlay is closed', () => {
    const rs = make();
    const n = events.length;
    rs.cycleOlder();
    expect(events.length).toBe(n);
    expect(rs.currentMatch()).toBeNull();
  });

  test('refresh collapses newlines in a multi-line query to a single row', () => {
    const rs = make();
    rs.refresh('a\r\nb'); // multi-line paste
    expect(rs.query()).toBe('a b'); // \r?\n → space (single-row overlay, HISTORY.md §2.2)
    expect(rs.query()).not.toContain('\n');
    expect(events.at(-1)).toMatchObject({ type: 'reverse-search:update', query: 'a b' });
  });

  test('a non-empty query with no matches stays open with empty results and no selection', () => {
    const rs = make();
    rs.refresh('zzz-nomatch');
    expect(rs.isOpen()).toBe(true); // distinct from the empty-query short-circuit
    expect(rs.currentMatch()).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: 'reverse-search:update',
      query: 'zzz-nomatch',
      results: [],
      selectedIdx: -1,
    });
  });
});
