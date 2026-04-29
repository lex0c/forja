export const migration006BgStderrCursor = {
  id: 6,
  name: '006-bg-stderr-cursor',
  // M3 / Step 2.1 code review fix. The original 005 schema kept a single
  // cursor_position. Manager.readOutput advanced that cursor by stdout's
  // window end and reused the same offset for stderr — a pattern that
  // silently loses stderr writes once stdout outpaces stderr in bytes:
  //
  //   stdout: "abc"   (3B, cursor → 3)
  //   stderr: "X"     (1B at this point)
  //   stderr later writes "Y" (now 2B). Next readOutput uses start=3,
  //   3 >= stderr_total=2 → returns empty. "Y" is lost forever, even
  //   if stderr later grows past 3 (we'd start from 3 again, missing
  //   bytes 1-2 every time).
  //
  // Fix: track stderr's cursor independently. Default 0 keeps the
  // semantics unchanged for existing rows — first read after the
  // migration captures everything in stderr from byte 0. New rows
  // start at 0 too.
  sql: `
    ALTER TABLE background_processes
      ADD COLUMN stderr_cursor_position INTEGER NOT NULL DEFAULT 0;
  `,
} as const;
