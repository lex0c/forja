// Structured line-level diff, for DISPLAY only (the TUI write/edit
// cards). This is NOT the edit mechanism — edit_file already applied the
// change; this just visualizes before→after. It produces accurate
// +added / -removed counts plus a bounded snippet of the FIRST changed
// region for the inline card. (Slice 1 has no full-diff/expand view, so
// only the first hunk is retained — the whole file is never walked into
// the snippet.)

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface FileDiff {
  added: number;
  removed: number;
  // First changed region + a little surrounding context, capped at
  // ~maxSnippetLines. Empty when there is no change.
  snippet: DiffLine[];
  // Added/removed lines NOT shown in the snippet — drives the
  // "… +N more changed lines" tail in the renderer.
  hiddenChanges: number;
}

export interface LineDiffOptions {
  context?: number; // unchanged lines kept around a change (default 2)
  maxSnippetLines?: number; // cap on snippet length (default 10)
}

const DEFAULT_CONTEXT = 2;
const DEFAULT_MAX_SNIPPET = 10;

// Above this many differing lines (AFTER trimming the common prefix and
// suffix) the O(n·m) LCS is skipped for a block replace: the counts then
// approximate a whole-region rewrite, which is the right read for a
// giant change and keeps the display cheap. Typical edits trim to a tiny
// middle and never hit this.
const MAX_LCS_LINES = 2000;

// Split into lines, dropping a single trailing newline so "a\nb\n" is
// two lines, not three — the diff is line-content oriented and a final
// newline is not its own line.
const splitLines = (s: string): string[] => {
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};

// LCS backtrack over two line arrays → ctx/del/add ops. The caller bounds
// the sizes (common prefix/suffix trimmed, MAX_LCS_LINES gate), so the
// O(n·m) table stays small for real edits.
const lcsDiff = (a: string[], b: string[]): DiffLine[] => {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]; (m+1)×(n+1), zero-filled.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const row = dp[i] ?? [];
    const next = dp[i + 1] ?? [];
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((next[j] ?? 0) >= (row[j + 1] ?? 0)) {
      ops.push({ type: 'del', text: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < m; i++) ops.push({ type: 'del', text: a[i] ?? '' });
  for (; j < n; j++) ops.push({ type: 'add', text: b[j] ?? '' });
  return ops;
};

// Full op list with the common prefix/suffix collapsed to `context`
// unchanged lines on each side of the differing middle.
const diffOps = (a: string[], b: string[], context: number): DiffLine[] => {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi -= 1;
    bHi -= 1;
  }

  const ops: DiffLine[] = [];
  // trailing `context` lines of the common prefix (lead-in to the change)
  for (let i = Math.max(0, lo - context); i < lo; i++) ops.push({ type: 'ctx', text: a[i] ?? '' });

  const midA = a.slice(lo, aHi);
  const midB = b.slice(lo, bHi);
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    for (const text of midA) ops.push({ type: 'del', text });
    for (const text of midB) ops.push({ type: 'add', text });
  } else {
    ops.push(...lcsDiff(midA, midB));
  }

  // leading `context` lines of the common suffix (lead-out)
  for (let i = aHi; i < Math.min(a.length, aHi + context); i++) {
    ops.push({ type: 'ctx', text: a[i] ?? '' });
  }
  return ops;
};

export const lineDiff = (before: string, after: string, opts: LineDiffOptions = {}): FileDiff => {
  const context = opts.context ?? DEFAULT_CONTEXT;
  const maxSnippet = opts.maxSnippetLines ?? DEFAULT_MAX_SNIPPET;
  const ops = diffOps(splitLines(before), splitLines(after), context);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  if (added === 0 && removed === 0) {
    return { added: 0, removed: 0, snippet: [], hiddenChanges: 0 };
  }

  // Snippet = the first changed region with its surrounding context,
  // capped at maxSnippet lines. End the region after `context` trailing
  // unchanged lines, or when the cap is hit — later hunks (if any) are
  // summarized by hiddenChanges.
  const snippet: DiffLine[] = [];
  let shownChanges = 0;
  let firstChangeSeen = false;
  let trailingCtx = 0;
  for (const op of ops) {
    if (snippet.length >= maxSnippet) break;
    if (op.type === 'ctx') {
      if (firstChangeSeen) {
        trailingCtx += 1;
        if (trailingCtx > context) break;
      }
      snippet.push(op);
    } else {
      firstChangeSeen = true;
      trailingCtx = 0;
      snippet.push(op);
      shownChanges += 1;
    }
  }
  return { added, removed, snippet, hiddenChanges: added + removed - shownChanges };
};
