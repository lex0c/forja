// Public surface of the TUI layer. Re-exports the building blocks
// (term primitives, key parser, event bus + types) so call sites
// import from `src/tui` instead of reaching into individual modules.

export * from './bus.ts';
export * from './events.ts';
export * from './keys.ts';
export * from './term.ts';
