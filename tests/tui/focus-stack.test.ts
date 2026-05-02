import { describe, expect, test } from 'bun:test';
import { createFocusStack } from '../../src/tui/focus-stack.ts';
import type { KeyEvent } from '../../src/tui/keys.ts';

const fakeKey: KeyEvent = {
  kind: 'key',
  name: 'enter',
  ctrl: false,
  alt: false,
  shift: false,
  raw: '\r',
};

describe('createFocusStack', () => {
  test('empty stack: dispatch returns false; size is 0', () => {
    const fs = createFocusStack();
    expect(fs.size()).toBe(0);
    expect(fs.dispatch(fakeKey)).toBe(false);
  });

  test('single handler: receives the key, return value bubbles up', () => {
    const fs = createFocusStack();
    let received = null as KeyEvent | null;
    fs.push((k) => {
      received = k;
      return true;
    });
    expect(fs.dispatch(fakeKey)).toBe(true);
    expect(received).toBe(fakeKey);
  });

  test('top handler runs first; consumes (returns true) → stops dispatch', () => {
    const fs = createFocusStack();
    const log: string[] = [];
    fs.push((_k) => {
      log.push('bottom');
      return false;
    });
    fs.push((_k) => {
      log.push('top');
      return true;
    });
    fs.dispatch(fakeKey);
    expect(log).toEqual(['top']);
  });

  test('top handler returns false → dispatcher falls through to next', () => {
    const fs = createFocusStack();
    const log: string[] = [];
    fs.push((_k) => {
      log.push('bottom');
      return true;
    });
    fs.push((_k) => {
      log.push('top');
      return false;
    });
    fs.dispatch(fakeKey);
    expect(log).toEqual(['top', 'bottom']);
  });

  test('all handlers return false → dispatch returns false', () => {
    const fs = createFocusStack();
    fs.push(() => false);
    fs.push(() => false);
    expect(fs.dispatch(fakeKey)).toBe(false);
  });

  test('remove(handler) takes a specific handler off the stack', () => {
    const fs = createFocusStack();
    const log: string[] = [];
    const a = (_k: KeyEvent): boolean => {
      log.push('a');
      return false;
    };
    const b = (_k: KeyEvent): boolean => {
      log.push('b');
      return true;
    };
    fs.push(a);
    fs.push(b);
    expect(fs.remove(b)).toBe(true);
    fs.dispatch(fakeKey);
    expect(log).toEqual(['a']);
  });

  test('remove(handler) returns false if the handler is not on the stack', () => {
    const fs = createFocusStack();
    const orphan = (): boolean => true;
    expect(fs.remove(orphan)).toBe(false);
  });

  test('remove searches top-down (LIFO common case)', () => {
    const fs = createFocusStack();
    const sentinel = (): boolean => false;
    fs.push(() => false);
    fs.push(sentinel);
    fs.push(() => true);
    expect(fs.remove(sentinel)).toBe(true);
    expect(fs.size()).toBe(2);
  });

  test('clear empties the stack', () => {
    const fs = createFocusStack();
    fs.push(() => true);
    fs.push(() => true);
    fs.push(() => true);
    fs.clear();
    expect(fs.size()).toBe(0);
    expect(fs.dispatch(fakeKey)).toBe(false);
  });
});
