// Single-file unified-diff validator for `git_apply_patch`.
//
// The tool is git-backed: `git apply` does the real application (context
// matching, fuzz, whitespace). This module does NOT reimplement that — it only
// inspects the patch HEADERS to (a) enforce the single-file invariant the
// permission model relies on (one path, gated from the tool's explicit `path`
// arg — see git_apply_patch / engine one-path gating) and (b) reject shapes
// that are unsafe or out of scope for a single-file content apply.
//
// Why header-only: `git apply` writes exactly the files named in the patch
// headers, so enumerating the headers is sufficient to know — and bound — what
// will be touched. We deliberately do not parse hunks; that is git's job.

// Why a parse failed. The tool maps these onto its ToolError codes; keeping the
// reason an enum here keeps the parser pure (no dependency on tool error codes).
export type PatchRejectReason =
  | 'empty' // no patch text
  | 'no_path' // no `+++ `/`--- ` file header found
  | 'multi_file' // touches more than one file
  | 'rename_or_copy' // rename/copy — a second path the single-path gate can't see
  | 'binary' // binary patch — not a line-oriented content change
  | 'mode_change' // chmod (old mode/new mode) — not a content edit
  | 'deletion' // `+++ /dev/null` — file removal is a delete-fs op (use the shell)
  | 'bad_header' // header path not `/dev/null` or `a/`/`b/`-prefixed (git-diff format)
  | 'no_hunk'; // headers but no `@@` hunk (e.g. mode-only change)

export type ParseGitPatchResult =
  | { ok: true; path: string }
  | { ok: false; reason: PatchRejectReason; message: string };

// Extract the path from a `--- ` / `+++ ` header line: drop the 4-char marker,
// any trailing `\t<timestamp>` git/diff appends, then the strip-level-1 prefix.
//
// CRITICAL — must match `git apply`'s own path normalization. The tool runs
// `git apply` with the DEFAULT `-p1`, which strips ONE leading path component.
// For git-format headers that component is the `a/`/`b/` prefix, so stripping
// it reproduces git's write target exactly. A TRADITIONAL header without the
// prefix (e.g. `--- src/f.txt`) would have its first REAL component (`src/`)
// stripped by git -p1 → git writes `f.txt` while this parser (if it returned
// `src/f.txt`) would pin against `src/f.txt`, passing the gate while git edits
// an UNGATED path. So a header path is valid only as `/dev/null` or with the
// `a/`/`b/` prefix; anything else returns null and the caller refuses it,
// rather than risk a normalization that diverges from the actual write.
//
// Strip ONLY syntax git also strips — the optional `\t<timestamp>` after the
// name, and a trailing CR from a CRLF line ending — NOT filename whitespace.
// git preserves leading/trailing spaces in the name (verified: `--- a/foo `
// applies to the file `foo `, not `foo`), so a `.trim()` here would pin a
// different path than git writes (a call gated for `foo` could touch `foo `).
const headerPath = (line: string): string | null => {
  const afterMarker = line.slice(4);
  const tab = afterMarker.indexOf('\t');
  let raw = tab === -1 ? afterMarker : afterMarker.slice(0, tab);
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  if (raw === '/dev/null') return raw;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return null;
};

// Parse + validate a single-file unified diff. On success returns the one target
// path (strip-prefix removed, repo-relative as written in the patch); the caller
// resolves it against the worktree and confirms it matches the gated `path` arg.
export const parseSingleFilePatch = (patch: string): ParseGitPatchResult => {
  if (patch.trim().length === 0) {
    return { ok: false, reason: 'empty', message: 'patch is empty' };
  }
  const lines = patch.split('\n');

  // Reject signals scanned up front — a single matching line is disqualifying.
  for (const line of lines) {
    if (/^(rename|copy) (from|to) /.test(line)) {
      return {
        ok: false,
        reason: 'rename_or_copy',
        message: 'rename/copy patches touch two paths; not supported (single-file only)',
      };
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      return { ok: false, reason: 'binary', message: 'binary patches are not supported' };
    }
    // `old mode`/`new mode` = a chmod. Not a content edit, and a chmod-only
    // section carries no ---/+++ pair, so the header-pair count below would
    // miss it while `git apply` still applies it. Reject outright (a content
    // diff never has these; `new file mode`/`deleted file mode`, which DO ride
    // legit create/delete patches, are deliberately not matched here).
    if (/^(old|new) mode /.test(line)) {
      return {
        ok: false,
        reason: 'mode_change',
        message: 'mode-change (chmod) patches are not supported (content edits only)',
      };
    }
  }

  // File headers POSITIONALLY, not by global filter. A naive
  // `lines.filter(startsWith('--- '))` miscounts hunk-body content: a removed
  // file line `-- x` is emitted as `--- x` (the `-` diff prefix), an added line
  // `++ x` as `+++ x` — both would inflate the file count and trigger a false
  // `multi_file` reject. A real file header is the consecutive pair `--- old`
  // then `+++ new`, FOLLOWED by a hunk header (`@@ `), a next-file marker
  // (`diff `), or EOF. A content `--- x`/`+++ y` adjacency (removed line next to
  // an added line) is not followed by a bare `@@ `/`diff ` (those would be
  // prefixed inside a hunk), so it doesn't match.
  const headers: { minus: string; plus: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (a === undefined || b === undefined) continue;
    if (!a.startsWith('--- ') || !b.startsWith('+++ ')) continue;
    const after = lines[i + 2];
    // Real header iff the +++ is followed by a hunk, a next-file marker, or the
    // end of the patch (a trailing '' from the split's final newline counts as
    // end — but only when it's actually the last element, so a blank line
    // mid-hunk can't be mistaken for end-of-patch).
    const atEnd = after === undefined || (after === '' && i + 2 === lines.length - 1);
    if (atEnd || after.startsWith('@@ ') || after.startsWith('diff ')) {
      const minus = headerPath(a);
      const plus = headerPath(b);
      // A real header whose path isn't `/dev/null` or `a/`/`b/`-prefixed would
      // normalize differently under `git apply -p1` than here — refuse rather
      // than risk pinning a path other than the one git writes.
      if (minus === null || plus === null) {
        return {
          ok: false,
          reason: 'bad_header',
          message:
            'patch header paths must be /dev/null or use git-diff a/ b/ prefixes (the tool runs git apply -p1)',
        };
      }
      headers.push({ minus, plus });
    }
  }
  if (headers.length === 0) {
    return {
      ok: false,
      reason: 'no_path',
      message: 'no unified-diff file header (--- / +++ / @@)',
    };
  }
  if (headers.length > 1) {
    return {
      ok: false,
      reason: 'multi_file',
      message: `patch touches ${headers.length} files; git_apply_patch is single-file only`,
    };
  }

  if (!lines.some((l) => l.startsWith('@@ '))) {
    return { ok: false, reason: 'no_hunk', message: 'patch has no @@ hunk to apply' };
  }

  const { plus } = headers[0] as { plus: string };
  // Deletion (`+++ /dev/null`) REMOVES the file — a destructive op the engine
  // gates and risk-scores as `delete-fs` (like `rm`), distinct from a write.
  // This content-edit tool only declares write-fs/read-fs (see its resolver),
  // so applying a deletion here would remove a file under a write-fs
  // declaration, escaping the delete-fs floor/risk. Refuse it; delete files
  // with the shell (`rm`), which the permission engine gates correctly.
  if (plus === '/dev/null') {
    return {
      ok: false,
      reason: 'deletion',
      message: 'deletion patches are not supported; remove files with the shell (rm)',
    };
  }
  // Modify and creation both name the file on the `+++` side.
  const path = plus;
  if (path.length === 0) {
    return {
      ok: false,
      reason: 'no_path',
      message: 'could not resolve a target path from headers',
    };
  }

  // Every `diff --git a/X b/X` names a file `git apply` will act on. A
  // metadata-only section (chmod, or an empty create/delete with `new file
  // mode`/`deleted file mode` and NO hunk) carries no ---/+++ pair, so the
  // header-pair count above misses it — yet `git apply --recount` still applies
  // it, letting an appended section create/chmod/delete a path the permission
  // engine never gated. Require every `diff --git` line to be the canonical
  // header for the ONE edited file; anything else (a different path, or a
  // quoted/spaced name we can't match) is a second section → refuse.
  const canonical = `diff --git a/${path} b/${path}`;
  for (const line of lines) {
    if (line.startsWith('diff --git ') && line !== canonical) {
      return {
        ok: false,
        reason: 'multi_file',
        message: `patch has a 'diff --git' section other than the edited file '${path}'`,
      };
    }
  }
  return { ok: true, path };
};
