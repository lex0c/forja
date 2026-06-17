import { describe, expect, test } from 'bun:test';
import { parseSingleFilePatch } from '../../src/diff/git-patch.ts';

const modify = `diff --git a/src/config.ts b/src/config.ts
index 1234567..89abcde 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +1 @@
-export const enabled = false;
+export const enabled = true;
`;

describe('parseSingleFilePatch', () => {
  test('valid single-file modify → path stripped of the b/ prefix', () => {
    const r = parseSingleFilePatch(modify);
    expect(r).toEqual({ ok: true, path: 'src/config.ts' });
  });

  test('creation (--- /dev/null) → path from the +++ side', () => {
    const r = parseSingleFilePatch(
      '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n',
    );
    expect(r).toEqual({ ok: true, path: 'src/new.ts' });
  });

  test('deletion (+++ /dev/null) → path from the --- side', () => {
    const r = parseSingleFilePatch(
      '--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const x = 1;\n',
    );
    expect(r).toEqual({ ok: true, path: 'src/old.ts' });
  });

  test('strips a trailing tab-timestamp from the header path', () => {
    const r = parseSingleFilePatch(
      '--- a/x.ts\t2026-06-16 10:00:00\n+++ b/x.ts\t2026-06-16 10:01:00\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(r).toEqual({ ok: true, path: 'x.ts' });
  });

  test('multi-file patch is rejected', () => {
    const twoFiles = `${modify}diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-a
+b
`;
    const r = parseSingleFilePatch(twoFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('multi_file');
  });

  test('rename patch is rejected (two paths)', () => {
    const r = parseSingleFilePatch(
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rename_or_copy');
  });

  test('copy patch is rejected', () => {
    const r = parseSingleFilePatch('diff --git a/a.ts b/b.ts\ncopy from a.ts\ncopy to b.ts\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rename_or_copy');
  });

  test('binary patch is rejected', () => {
    const r = parseSingleFilePatch(
      'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('binary');
  });

  test('headers without a hunk are rejected (e.g. mode-only)', () => {
    const r = parseSingleFilePatch('--- a/x.ts\n+++ b/x.ts\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_hunk');
  });

  test('empty patch is rejected', () => {
    expect(parseSingleFilePatch('   \n').ok).toBe(false);
    const r = parseSingleFilePatch('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  test('text without a file header is rejected', () => {
    const r = parseSingleFilePatch('just some prose, no diff headers here\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_path');
  });

  test('hunk-body lines that LOOK like headers are not miscounted as files', () => {
    // A removed file line `-- foo` is emitted as `--- foo`; an added file line
    // `++ bar` as `+++ bar`. Positional detection must NOT count these as a
    // second file header (the old global filter did → false multi_file).
    const r = parseSingleFilePatch(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n keep\n--- foo\n+++ bar\n keep2\n',
    );
    expect(r).toEqual({ ok: true, path: 'f.txt' });
  });

  test('a lone removed line that looks like a header is not a second file', () => {
    const r = parseSingleFilePatch(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n keep\n--- lonely removed\n',
    );
    expect(r).toEqual({ ok: true, path: 'f.txt' });
  });

  test('rejects an appended metadata-only diff --git section for another path', () => {
    // One authorized content hunk for allowed.txt + an empty-create section for
    // created.txt that has NO ---/+++ pair — git apply would still create it.
    const r = parseSingleFilePatch(
      '--- a/allowed.txt\n+++ b/allowed.txt\n@@ -1 +1 @@\n-hello\n+HELLO\ndiff --git a/created.txt b/created.txt\nnew file mode 100644\nindex 0000000..0000000\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('multi_file');
  });

  test('rejects a chmod (old mode/new mode) section', () => {
    const r = parseSingleFilePatch(
      'diff --git a/f.txt b/f.txt\nold mode 100644\nnew mode 100755\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('mode_change');
  });

  test('a diff --git header matching the edited file is accepted', () => {
    const r = parseSingleFilePatch(
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(r).toEqual({ ok: true, path: 'f.txt' });
  });

  test('rejects traditional headers without a/ b/ prefixes (git -p1 strips a different component)', () => {
    // `--- src/f.txt` has no a/ prefix; git apply -p1 would strip `src/` and
    // write repo-root `f.txt`, diverging from a naive strip that keeps src/f.txt.
    const r = parseSingleFilePatch('--- src/f.txt\n+++ src/f.txt\n@@ -1 +1 @@\n-old\n+new\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_header');
  });

  test('preserves significant trailing whitespace in the filename (git keeps it)', () => {
    // git apply treats `--- a/foo ` as the file `foo ` (trailing space) — a
    // .trim() here would pin `foo` while git writes `foo `.
    const r = parseSingleFilePatch('--- a/foo \n+++ b/foo \n@@ -1 +1 @@\n-A\n+B\n');
    expect(r).toEqual({ ok: true, path: 'foo ' });
  });
});
