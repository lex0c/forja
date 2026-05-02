// Typed event bus for the TUI layer. Spec: UI.md §3.
//
// Wraps Node's EventEmitter so subscribers get the narrowed payload
// type (UIEventOf<T>) instead of variadic any[]. Single channel — all
// events share one emitter, with the type tag as the channel key.
//
// We deliberately do NOT use a third-party reactive lib (mitt, RxJS,
// nanoevents): EventEmitter is part of the runtime, the API surface
// we need is tiny, and the spec (UI.md §1) bans extra deps.

import { EventEmitter } from 'node:events';
import type { UIEvent, UIEventOf, UIEventType } from './events.ts';

export type UIEventHandler<T extends UIEventType> = (event: UIEventOf<T>) => void;

export interface Bus {
  emit: (event: UIEvent) => void;
  on: <T extends UIEventType>(type: T, handler: UIEventHandler<T>) => () => void;
  once: <T extends UIEventType>(type: T, handler: UIEventHandler<T>) => () => void;
  // Subscribe to every event regardless of type — used by the NDJSON
  // serializer (UI.md §7) which forwards everything to stdout. Order
  // of delivery matches emit order.
  onAny: (handler: (event: UIEvent) => void) => () => void;
  // Drop all listeners. Used by tests and during shutdown so any
  // in-flight listener doesn't fire after the renderer has been torn
  // down.
  removeAll: () => void;
  listenerCount: (type?: UIEventType) => number;
}

const ANY_CHANNEL = '__any__';

export const createBus = (): Bus => {
  const emitter = new EventEmitter();
  // Default cap (10) is too low for the renderer + NDJSON forwarder
  // + one or two listeners per event type (cheap to bump; nothing
  // saved by capping).
  emitter.setMaxListeners(100);

  const toUnsubscribe =
    (channel: string, handler: (...args: unknown[]) => void): (() => void) =>
    () => {
      emitter.off(channel, handler);
    };

  return {
    emit: (event) => {
      // Two channels: the typed channel (for handlers registered via
      // `on(type, ...)`) and the wildcard channel (for `onAny`). We
      // emit to both so each subscriber type stays simple.
      emitter.emit(event.type, event);
      emitter.emit(ANY_CHANNEL, event);
    },
    on: (type, handler) => {
      // The cast collapses our typed handler into EventEmitter's
      // `(...args: unknown[]) => void` shape. Sound because we only
      // emit one positional arg (the typed event) on this channel.
      const wrapped = (event: unknown): void => {
        handler(event as UIEventOf<typeof type>);
      };
      emitter.on(type, wrapped);
      return toUnsubscribe(type, wrapped);
    },
    once: (type, handler) => {
      const wrapped = (event: unknown): void => {
        handler(event as UIEventOf<typeof type>);
      };
      emitter.once(type, wrapped);
      return toUnsubscribe(type, wrapped);
    },
    onAny: (handler) => {
      const wrapped = (event: unknown): void => {
        handler(event as UIEvent);
      };
      emitter.on(ANY_CHANNEL, wrapped);
      return toUnsubscribe(ANY_CHANNEL, wrapped);
    },
    removeAll: () => {
      emitter.removeAllListeners();
    },
    listenerCount: (type) => emitter.listenerCount(type ?? ANY_CHANNEL),
  };
};
