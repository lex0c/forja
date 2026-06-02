---
name: prefer-specialized-navigation
description: dedicated tool > Bash; grep + targeted read > whole-file read on large files
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Use a dedicated tool (Read/Edit/Grep/Glob) instead of Bash whenever
one exists. On a file > 200 lines, prefer grep + a targeted read
(`offset`/`limit` around the match) instead of reading the whole file.

**Why:** a dedicated tool has a validated schema, structured output
(path/line/text), an automatic cap, no shell-escaping bugs, and a UI
that shows range/diff. The Bash equivalent loses all of that. Reading
a whole large file burns tokens on irrelevant content; the slice
around the match + structure inferred from the path cover ~90% of
cases (typical 10-13× reduction on files > 500 lines).

**How to apply:**
- Find a symbol/string → `Grep` (not `bash("grep ...")`)
- List files by pattern → `Glob` (not `bash("find ...")`)
- Edit content → `Edit` (not `sed`/`awk`/HEREDOC via Bash)
- Read a slice of a file > 200 lines → `Grep symbol file` then
  `Read file offset=N limit=80` around the match
- Resist the "read the whole file for context" instinct — context
  comes from the relevant slice + filename + directory
- Exception: a file < 200 lines can be read whole; the overhead of a
  targeted read is not worth it
