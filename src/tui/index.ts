// Public surface of the TUI layer. Re-exports the building blocks
// (term primitives, key parser, event bus + types, state reducer,
// renderer) so call sites import from `src/tui` instead of reaching
// into individual modules.

export * from './bus.ts';
export * from './events.ts';
export * from './keys.ts';
export * from './renderer.ts';
export * from './state.ts';
export * from './term.ts';
