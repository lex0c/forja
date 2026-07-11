import { describe, expect, test } from 'bun:test';
import { createTodoStore, type TodoItem } from '../../src/todo/index.ts';

describe('TodoStore', () => {
  test('returns empty list for unknown sessionId', () => {
    const store = createTodoStore();
    expect(store.get('s1')).toEqual([]);
  });

  test('set then get returns the same items', () => {
    const store = createTodoStore();
    store.set('s1', [
      { id: '1', content: 'a', status: 'pending', activeForm: 'doing a' },
      { id: '2', content: 'b', status: 'in_progress', activeForm: 'doing b' },
    ]);
    expect(store.get('s1')).toEqual([
      { id: '1', content: 'a', status: 'pending', activeForm: 'doing a' },
      { id: '2', content: 'b', status: 'in_progress', activeForm: 'doing b' },
    ]);
  });

  test('set is per-session', () => {
    const store = createTodoStore();
    store.set('s1', [{ id: '1', content: 'a', status: 'pending', activeForm: 'doing a' }]);
    store.set('s2', [{ id: '1', content: 'b', status: 'done', activeForm: 'did b' }]);
    expect(store.get('s1')[0]?.content).toBe('a');
    expect(store.get('s2')[0]?.content).toBe('b');
  });

  test('set replaces atomically (no merge)', () => {
    const store = createTodoStore();
    store.set('s1', [
      { id: '1', content: 'a', status: 'pending', activeForm: 'doing a' },
      { id: '2', content: 'b', status: 'pending', activeForm: 'doing b' },
    ]);
    store.set('s1', [{ id: '3', content: 'c', status: 'done', activeForm: 'did c' }]);
    expect(store.get('s1')).toEqual([
      { id: '3', content: 'c', status: 'done', activeForm: 'did c' },
    ]);
  });

  test('clear drops a session list', () => {
    const store = createTodoStore();
    store.set('s1', [{ id: '1', content: 'a', status: 'pending', activeForm: 'doing a' }]);
    store.clear('s1');
    expect(store.get('s1')).toEqual([]);
  });

  test('clear on unknown session is a no-op', () => {
    const store = createTodoStore();
    expect(() => store.clear('never-set')).not.toThrow();
  });

  test('returned list is a defensive copy (caller mutations do not leak)', () => {
    // Regression: if get() returned the internal array, a caller could
    // mutate the store's state. The set() path is the only valid way
    // to change what the store holds.
    const store = createTodoStore();
    store.set('s1', [{ id: '1', content: 'a', status: 'pending', activeForm: 'doing a' }]);
    const list = store.get('s1');
    list.push({ id: '2', content: 'INJECTED', status: 'done', activeForm: 'pwned' });
    expect(store.get('s1')).toHaveLength(1);
    expect(store.get('s1')[0]?.content).toBe('a');
  });

  test('input array is defensively copied on set', () => {
    // Symmetric: mutating the array after set() must not change the
    // store's view either.
    const store = createTodoStore();
    const items: TodoItem[] = [{ id: '1', content: 'a', status: 'pending', activeForm: 'doing a' }];
    store.set('s1', items);
    items.push({ id: '2', content: 'LATE', status: 'done', activeForm: 'late' });
    expect(store.get('s1')).toHaveLength(1);
  });

  test('item-level mutation on returned list does not leak (deep copy)', () => {
    // Regression: the initial implementation used items.slice() which
    // is shallow. A caller could do `result[0].content = 'X'` and
    // corrupt stored state without going through set(). The deep
    // structuredClone defends against that.
    const store = createTodoStore();
    store.set('s1', [{ id: '1', content: 'original', status: 'pending', activeForm: 'doing it' }]);
    const list = store.get('s1');
    const first = list[0];
    if (first === undefined) throw new Error('expected one item');
    first.content = 'PWNED';
    first.status = 'done';
    first.activeForm = 'corrupted';
    const reread = store.get('s1');
    expect(reread[0]?.content).toBe('original');
    expect(reread[0]?.status).toBe('pending');
    expect(reread[0]?.activeForm).toBe('doing it');
  });

  test('item-level mutation on the array passed to set does not leak', () => {
    // Symmetric: same protection on the way in.
    const store = createTodoStore();
    const items: TodoItem[] = [
      { id: '1', content: 'original', status: 'pending', activeForm: 'doing it' },
    ];
    store.set('s1', items);
    const handle = items[0];
    if (handle === undefined) throw new Error('expected one item');
    handle.content = 'PWNED';
    expect(store.get('s1')[0]?.content).toBe('original');
  });
});

describe('TodoStore.nextId', () => {
  test('returns monotonically increasing distinct ids', () => {
    const store = createTodoStore();
    expect([store.nextId('s1'), store.nextId('s1'), store.nextId('s1')]).toEqual(['1', '2', '3']);
  });

  test('is per-session — counters are independent', () => {
    const store = createTodoStore();
    expect(store.nextId('s1')).toBe('1');
    expect(store.nextId('s2')).toBe('1');
    expect(store.nextId('s1')).toBe('2');
  });

  test('clear resets the counter so a re-used session restarts at 1', () => {
    const store = createTodoStore();
    store.nextId('s1');
    store.nextId('s1');
    store.clear('s1');
    expect(store.nextId('s1')).toBe('1');
  });

  test('ids are never recycled within a session', () => {
    const store = createTodoStore();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(store.nextId('s1'));
    expect(seen.size).toBe(50);
  });
});
