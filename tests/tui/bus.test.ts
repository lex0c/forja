import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';

const tickEvent: UIEvent = {
  type: 'assistant:delta',
  ts: 1,
  messageId: 'm1',
  text: 'hello',
};

describe('createBus', () => {
  test('on() delivers narrowed event payload', () => {
    const bus = createBus();
    let received = null as string | null;
    bus.on('assistant:delta', (e) => {
      // Type narrowing: e.text is string here.
      received = e.text;
    });
    bus.emit(tickEvent);
    expect(received).toBe('hello');
  });

  test('on() returns unsubscribe handle', () => {
    const bus = createBus();
    let count = 0;
    const off = bus.on('assistant:delta', () => count++);
    bus.emit(tickEvent);
    off();
    bus.emit(tickEvent);
    expect(count).toBe(1);
  });

  test('events of one type do not leak to listeners of another', () => {
    const bus = createBus();
    let deltaCalls = 0;
    let endCalls = 0;
    bus.on('assistant:delta', () => deltaCalls++);
    bus.on('assistant:end', () => endCalls++);
    bus.emit(tickEvent);
    expect(deltaCalls).toBe(1);
    expect(endCalls).toBe(0);
    bus.emit({ type: 'assistant:end', ts: 2, messageId: 'm1' });
    expect(deltaCalls).toBe(1);
    expect(endCalls).toBe(1);
  });

  test('once() fires exactly once and self-detaches', () => {
    const bus = createBus();
    let count = 0;
    bus.once('assistant:delta', () => count++);
    bus.emit(tickEvent);
    bus.emit(tickEvent);
    expect(count).toBe(1);
  });

  test('once() unsubscribe handle cancels before the first fire', () => {
    const bus = createBus();
    let count = 0;
    const off = bus.once('assistant:delta', () => count++);
    off();
    bus.emit(tickEvent);
    expect(count).toBe(0);
  });

  test('emit with no listeners is a no-op', () => {
    const bus = createBus();
    expect(() => bus.emit(tickEvent)).not.toThrow();
  });

  test('onAny() receives every event in emit order', () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.onAny((e) => seen.push(e.type));
    bus.emit(tickEvent);
    bus.emit({ type: 'tool:start', ts: 2, toolId: 't1', name: 'bash', args: 'ls' });
    bus.emit({ type: 'session:end', ts: 3, sessionId: 's1', reason: 'done' });
    expect(seen).toEqual(['assistant:delta', 'tool:start', 'session:end']);
  });

  test('onAny() unsubscribe handle stops further events', () => {
    const bus = createBus();
    let count = 0;
    const off = bus.onAny(() => count++);
    bus.emit(tickEvent);
    off();
    bus.emit(tickEvent);
    expect(count).toBe(1);
  });

  test('removeAll() drops every listener', () => {
    const bus = createBus();
    let typed = 0;
    let any = 0;
    bus.on('assistant:delta', () => typed++);
    bus.onAny(() => any++);
    bus.removeAll();
    bus.emit(tickEvent);
    expect(typed).toBe(0);
    expect(any).toBe(0);
  });

  test('listenerCount reports per-type and any-channel separately', () => {
    const bus = createBus();
    bus.on('assistant:delta', () => {});
    bus.on('assistant:delta', () => {});
    bus.on('tool:start', () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount('assistant:delta')).toBe(2);
    expect(bus.listenerCount('tool:start')).toBe(1);
    expect(bus.listenerCount('assistant:end')).toBe(0);
    // No-arg form returns the wildcard channel count (used by onAny).
    expect(bus.listenerCount()).toBe(1);
  });

  test('multiple subscribers fire in registration order', () => {
    const bus = createBus();
    const log: number[] = [];
    bus.on('assistant:delta', () => log.push(1));
    bus.on('assistant:delta', () => log.push(2));
    bus.on('assistant:delta', () => log.push(3));
    bus.emit(tickEvent);
    expect(log).toEqual([1, 2, 3]);
  });

  test('emit + onAny + typed handler all receive the same instance', () => {
    const bus = createBus();
    let fromTyped = null as UIEvent | null;
    let fromAny = null as UIEvent | null;
    bus.on('assistant:delta', (e) => {
      fromTyped = e;
    });
    bus.onAny((e) => {
      fromAny = e;
    });
    bus.emit(tickEvent);
    expect(fromTyped).toBe(tickEvent);
    expect(fromAny).toBe(tickEvent);
  });
});
