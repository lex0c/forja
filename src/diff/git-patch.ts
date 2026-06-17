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
  | 'no_hunk'; // headers but no `@@` hunk (e.g. mode-only change)

export type ParseGitPatchResult =
  | { ok: true; path: string }
  | { ok: false; reason: PatchRejectReason; message: string };

// Strip a leading `a/` or `b/` strip-level-1 prefix (git's default). A path
// equal to `/dev/null` (creation/deletion sentinel) is returned as-is so the
// caller can detect it.
const stripPrefix = (raw: string): string => {
  if (raw === '/dev/null') return raw;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
};

// Extract the path from a `--- ` / `+++ ` header line: drop the 4-char marker,
// then any trailing `\t<timestamp>` git/diff appends, then the strip prefix.
const headerPath = (line: string): string => {
  const afterMarker = line.slice(4);
  const tab = afterMarker.indexOf('\t');
  const raw = tab === -1 ? afterMarker : afterMarker.slice(0, tab);
  return stripPrefix(raw.trim());
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
      headers.push({ minus: headerPath(a), plus: headerPath(b) });
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

  const { minus, plus } = headers[0] as { minus: string; plus: string };
  // Modify → both sides name the file. Creation → `--- /dev/null`, path on +++.
  // Deletion → `+++ /dev/null`, path on ---.
  const path = plus === '/dev/null' ? minus : plus;
  if (path === '/dev/null' || path.length === 0) {
    return {
      ok: false,
      reason: 'no_path',
      message: 'could not resolve a target path from headers',
    };
  }
  return { ok: true, path };
};
