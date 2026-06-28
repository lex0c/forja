// The builtin tools that write a file at a KNOWN path (carried in `input.path`).
// Single source of truth so the recap projection (`filesWritten`), the
// deterministic recap summary, and the claim-time verify gate (`everMutated`,
// STATE_MACHINE §3.2.1) can't drift apart — a new file-writing builtin is added
// here ONCE, not in N hand-synced copies (a missed copy would, for the gate,
// silently let an edit through that tool escape "did you verify?").
//
// NOTE: `bash` is also `writes:true` (CONTRACTS §2.6.3 pessimism) but the path
// it writes is unknowable from its input, so it is deliberately NOT here.
export const FILE_WRITER_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'git_apply_patch',
]);
