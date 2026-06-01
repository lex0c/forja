// INBOX drain semantics (docs/spec/INBOX.md §5). When more than one
// message is queued before a turn boundary, the queue drains as a
// SINGLE user turn — not N wire messages.
//
// Why one turn, not many: the provider adapters reject consecutive
// same-role messages (the harness repairs loaded history at the
// storage/compaction boundary — resume.ts / compaction.ts — but the
// live send path assumes alternation), and there is no provider-side
// merge. So "userPrompt[] in one turn" is realized as one user message
// whose body joins the queued texts with a visible separator. Concat
// also keeps the cost at one model call and the context coherent
// (§5.2), versus N sequential turns.
//
// The separator is a markdown horizontal rule on its own blank-line-
// padded line (§5.1): the model sees an explicit boundary between
// points instead of fusing them, and the operator reading the
// transcript later can tell what arrived together.

// §5.1. Exported so producers and tests share the exact string.
export const INBOX_DRAIN_SEPARATOR = '\n\n---\n\n';

// Join queued message bodies into one user-turn body. `texts` is in
// FIFO (receive) order — the caller preserves it. A single item is
// returned verbatim (no separator); an empty queue returns ''.
export const concatQueuedBodies = (texts: readonly string[]): string =>
  texts.join(INBOX_DRAIN_SEPARATOR);
