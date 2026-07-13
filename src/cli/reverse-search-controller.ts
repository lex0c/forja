// Ctrl+R reverse-search sub-machine extracted from repl.ts's runRepl (R1 —
// reduce the god-function). The overlay's whole state (the live query, the
// match list, the selected index) plus its operations (open / refresh on each
// keystroke / cycle-to-older / accept / close) were ~65 lines of closures over
// three run-scoped `let`s. This owns that state; the REPL keeps thin wrappers so
// the ~20 keypress call sites are unchanged. Behavior is preserved verbatim; the
// repl / repl-history suites drive it end to end.
import type { DB } from '../storage/db.ts';
import { searchHistory } from '../storage/history.ts';
import type { Bus } from '../tui/bus.ts';

// Cap the match list: the operator scrolls via Ctrl+R, so visiting more than
// ~10 entries is rare; 200 is generous for heavy typists without mirroring a
// 10k-row history into JS on every keystroke.
const REVERSE_SEARCH_LIMIT = 200;

export interface ReverseSearchDeps {
  db: DB;
  cwd: string;
  bus: Bus;
  now: () => number;
}

export class ReverseSearchController {
  #query: string | null = null;
  #results: string[] = [];
  #idx = -1;
  readonly #deps: ReverseSearchDeps;

  constructor(deps: ReverseSearchDeps) {
    this.#deps = deps;
  }

  isOpen(): boolean {
    return this.#query !== null;
  }

  // The live query, or null when the overlay is closed. The keypress handler
  // reads this to append/backspace a character before calling refresh.
  query(): string | null {
    return this.#query;
  }

  // Sanitize a query before it lands in state. The overlay renders as a single
  // visual row (HISTORY.md §2.2); embedded newlines from a multi-line paste
  // would otherwise spill into multiple rows and break the live region's row
  // accounting. Collapse `\r?\n` → space, matching the treatment applied to
  // recalled multi-line matches in render/reverse-search.ts.
  #sanitize(raw: string): string {
    return raw.replace(/\r?\n/g, ' ');
  }

  refresh(query: string): void {
    const clean = this.#sanitize(query);
    this.#query = clean;
    this.#results =
      clean === '' ? [] : searchHistory(this.#deps.db, this.#deps.cwd, clean, REVERSE_SEARCH_LIMIT);
    this.#idx = this.#results.length > 0 ? 0 : -1;
    this.#deps.bus.emit({
      type: 'reverse-search:update',
      ts: this.#deps.now(),
      query: clean,
      results: this.#results,
      selectedIdx: this.#idx,
    });
  }

  open(): void {
    if (this.isOpen()) return;
    this.refresh('');
  }

  close(): void {
    if (!this.isOpen()) return;
    this.#query = null;
    this.#results = [];
    this.#idx = -1;
    this.#deps.bus.emit({ type: 'reverse-search:close', ts: this.#deps.now() });
  }

  cycleOlder(): void {
    if (!this.isOpen() || this.#results.length === 0) return;
    // Clamp at the oldest match (last index). Ctrl+R past the bottom is a no-op
    // rather than a wrap — bash beeps here; we just stop. Cycling past oldest
    // would surprise an operator who expects "more presses → older".
    if (this.#idx < this.#results.length - 1) {
      this.#idx += 1;
    }
    this.#deps.bus.emit({
      type: 'reverse-search:update',
      ts: this.#deps.now(),
      query: this.#query ?? '',
      results: this.#results,
      selectedIdx: this.#idx,
    });
  }

  // The match the operator is currently looking at, or null when the overlay
  // has zero matches. Used by accept (Enter / Tab) to know what to drop into
  // the input buffer.
  currentMatch(): string | null {
    if (this.#idx < 0) return null;
    return this.#results[this.#idx] ?? null;
  }
}
