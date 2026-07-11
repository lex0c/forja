import { describe, expect, test } from 'bun:test';
import { concatQueuedBodies, INBOX_DRAIN_SEPARATOR } from '../../src/cli/inbox-drain.ts';

describe('concatQueuedBodies (INBOX §5.1)', () => {
  test('separator is a blank-line-delimited markdown horizontal rule', () => {
    expect(INBOX_DRAIN_SEPARATOR).toBe('\n\n---\n\n');
  });

  test('empty queue → empty string', () => {
    expect(concatQueuedBodies([])).toBe('');
  });

  test('single item is returned verbatim (no separator)', () => {
    expect(concatQueuedBodies(['only one'])).toBe('only one');
  });

  test('multiple items join with the separator in FIFO order', () => {
    expect(concatQueuedBodies(['first', 'second', 'third'])).toBe(
      'first\n\n---\n\nsecond\n\n---\n\nthird',
    );
  });

  test('preserves multi-line bodies (only the boundaries get a rule)', () => {
    expect(concatQueuedBodies(['a\nb', 'c'])).toBe('a\nb\n\n---\n\nc');
  });
});
