// In-memory TodoList store, scoped per session. Spec §7.4 is
// explicit that the list is "estado de trabalho, não memória" — it
// does NOT persist between sessions. So this lives entirely in
// process memory, keyed by sessionId, and the harness's session-
// end hook clears it. There is intentionally no SQLite repo.
//
// The store mirrors the shape the bg manager uses (session-bound
// dependency, optional on ToolContext, owned by the harness): tools
// don't construct stores themselves; they receive one through ctx
// or fail with a clean tool error if the harness wasn't wired.

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'removed';

export interface TodoItem {
  // Stable per-session identity, assigned by the store on create and
  // never recycled (a removed item's id is never reissued, so a stale
  // model reference resolves to not_found instead of silently aliasing a
  // different task). Opaque string; today a monotonic per-session counter.
  id: string;
  // Imperative description of the task ("Implement payment flow").
  content: string;
  // Lifecycle marker. At most one item should be 'in_progress' at a
  // time per spec §7.4 — the tool layer enforces this with a clean
  // invalid_arg rather than allowing a degenerate state.
  status: TodoStatus;
  // Present-progressive form ("Implementing payment flow") used by
  // the live TUI renderer (M4 Ink). Stored verbatim; no derivation
  // attempt — the model writes whichever form makes sense.
  activeForm: string;
}

export interface TodoStore {
  // Returns the current list for a session. Returns an empty array
  // for unknown session ids — the absence of a list is semantically
  // equivalent to an empty list. Read-only: the store does NOT
  // create a Map entry on first read, so an unused session leaves
  // no trace.
  get(sessionId: string): TodoItem[];
  // Replaces the list for the session. Atomic — no merge semantics at
  // this layer. The CRUD tools (todo_create / todo_update / …) do
  // read-modify-write: get(), apply the change, then set() the full list
  // back. The loop's store wrapper emits the TUI `todo_updated` event off
  // this set(), so any op that ends in set() repaints the live region.
  set(sessionId: string, items: TodoItem[]): void;
  // Monotonic per-session id generator for new items. Never recycles — a
  // removed item's id is never reissued within a session, so a stale
  // reference resolves to not_found rather than aliasing a different task.
  // The counter is torn down with the list at session end.
  nextId(sessionId: string): string;
  // Cleanup hook for session end. Drops the entry so a long-lived
  // process running multiple sessions doesn't accumulate dead
  // state. Idempotent — calling on an unknown session is a no-op.
  clear(sessionId: string): void;
}

// Deep clone via structuredClone. Cheap for the small lists this
// tool deals with (typical: <20 items, each ~100 bytes). The
// shallow `items.slice()` we used initially only clones the outer
// array — `result[0].content = 'X'` would still mutate the stored
// item. structuredClone walks the object tree, so a caller can't
// reach back into the store through the returned reference.
const cloneItems = (items: TodoItem[]): TodoItem[] => structuredClone(items);

export const createTodoStore = (): TodoStore => {
  const lists = new Map<string, TodoItem[]>();
  // Per-session id counter, kept independent of the list so it survives
  // the read-modify-write churn of the CRUD tools — a deleted item must
  // not free its id for reuse. Monotonic; reset only by clear().
  const counters = new Map<string, number>();
  return {
    get: (sessionId) => {
      const items = lists.get(sessionId);
      // Deep defensive copy: the store is the single owner of
      // mutation; set() is the only path that changes state.
      // Without the deep clone, a caller mutating any field of any
      // returned item would silently corrupt stored state.
      return items === undefined ? [] : cloneItems(items);
    },
    set: (sessionId, items) => {
      // Symmetric deep copy on the way in: a caller mutating an
      // item after set() must not change what the store holds.
      lists.set(sessionId, cloneItems(items));
    },
    nextId: (sessionId) => {
      const next = (counters.get(sessionId) ?? 0) + 1;
      counters.set(sessionId, next);
      return String(next);
    },
    clear: (sessionId) => {
      lists.delete(sessionId);
      // Drop the counter too, so a re-used session id restarts at 1 and
      // there's no cross-session id bleed — mirrors the list teardown.
      counters.delete(sessionId);
    },
  };
};
