import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Canonical atomic, durable file write — the single implementation
// shared by tools (write_file, edit_file) and the memory subsystem.
// `Bun.write` (like a bare write(2)) can leave a PARTIAL file if the
// process dies or the disk fills mid-write: the git checkpoint then
// holds the pre-write content, but the file on disk is truncated
// garbage until a rollback the crash itself may have prevented. This
// writes to a temp file in the target's directory, fsyncs it, then
// renames over the target — rename(2) is atomic on a same-filesystem
// move, so the target is only ever full-old or full-new, never partial.
//
// Behaviors so this is a drop-in for both `Bun.write(path, content)`
// and the prior memory-local atomicWrite:
//   - Parent directory is created if missing (mkdir -p) — memory callers
//     relied on this.
//   - Symlinks: resolve to the link's REAL target (realpathSync) and
//     write there, exactly as Bun.write follows the link; the temp +
//     rename happen in the target's own directory (a same-filesystem,
//     atomic rename) and the link itself is left intact.
//   - Mode: a fresh temp inode is born with the default mode, which
//     would strip an executable bit (or any custom perms) off an edited
//     file. When the target already exists, fchmod the temp to its
//     permission bits before the rename. (Ownership is NOT restored —
//     that needs privilege; the agent writes as itself, as Bun.write did.
//     Callers that must pin a fresh file's mode — e.g. a 0o600 secret —
//     still own that and should not use this helper for create.)
//
// Known constraints (shared by every temp+rename writer in the repo):
//   - Requires WRITE permission on the target's DIRECTORY (to create the
//     temp), not just on the file — an in-place write needed only file
//     perms. Editing a writable file in a read-only dir fails cleanly
//     (this is already the tested norm: see memory lifecycle EACCES).
//   - rename changes the inode: a hardlink keeps the old content and an
//     inode-keyed FS watcher sees a rename, not a modify. Standard
//     atomic-save trade-off, acceptable for source-file editing.

// Cap (in BYTES) on the basename slice embedded in the temp name.
// NAME_MAX is 255 bytes on common filesystems but as low as ~143 on
// some (eCryptfs); the fixed suffix (two dots + a uuid + `.tmp`) is
// ~42 bytes, so 80 keeps the whole temp name well under any of these
// while leaving an orphan recognizable. The cap is on ENCODED BYTES,
// not JS string length — a 240-byte non-ASCII filename is only ~80
// UTF-16 units, so a code-unit slice could still produce a temp name
// over NAME_MAX (openSync → ENAMETOOLONG) for a file the direct write
// path handled.
const TEMP_BASENAME_BYTE_CAP = 80;

// Truncate `s` to at most `maxBytes` of UTF-8 WITHOUT splitting a
// multibyte character — back the cut point off any trailing UTF-8
// continuation byte (0b10xxxxxx). Exported for unit testing.
export const truncateUtf8 = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.toString('utf8', 0, end);
};

// Drive a partial-write-safe write loop: `write(offset)` performs one
// write starting at `offset` and returns the bytes ACTUALLY written. A
// single write(2) can return a SHORT count (fewer than requested,
// WITHOUT throwing) under disk/quota pressure or on a network FS, so we
// loop until `total` bytes are written. A non-positive return means no
// forward progress (e.g. disk full) — throw rather than spin forever.
// Exported so the loop is unit-testable without a short-writing FS.
export const writeAll = (write: (offset: number) => number, total: number, label: string): void => {
  for (let off = 0; off < total; ) {
    const n = write(off);
    if (n <= 0) {
      throw new Error(`short write: only ${off} of ${total} bytes written to ${label}`);
    }
    off += n;
  }
};

export const atomicWrite = (absPath: string, content: string): number => {
  // Follow a symlink to its real target so we replace the target's
  // content (link preserved), not the link. A path that doesn't exist
  // yet (new file) has no link to follow — use it as-is.
  const target = existsSync(absPath) ? realpathSync(absPath) : absPath;
  const buf = Buffer.from(content, 'utf8');
  const tmp = join(
    dirname(target),
    `.${truncateUtf8(basename(target), TEMP_BASENAME_BYTE_CAP)}.${crypto.randomUUID()}.tmp`,
  );
  mkdirSync(dirname(target), { recursive: true });
  let fd: number | undefined;
  try {
    const openedFd = openSync(tmp, 'wx'); // 'wx' — never clobber an unexpected temp
    fd = openedFd; // track for cleanup in the catch
    // writeSync issues a single write(2) that can return a SHORT count
    // (fewer bytes than requested, without throwing) under disk/quota
    // pressure or on a network FS; writeAll loops until all bytes land,
    // so a truncated temp is never fsync+renamed over the target.
    writeAll((off) => writeSync(openedFd, buf, off), buf.length, tmp);
    // Match the target's permission bits if it already exists (keep +x).
    try {
      fchmodSync(fd, statSync(target).mode & 0o777);
    } catch {
      // target is new — keep the temp's default mode
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    // fsync the PARENT DIRECTORY so the rename is itself crash-durable.
    // Fsyncing the temp made its CONTENTS durable, but the directory
    // entry that publishes the new name (and drops the temp) lives in
    // the parent's metadata — without this, a power loss right after a
    // successful rename can lose the new name or resurrect the old entry
    // even though we returned success. Best-effort: the rename already
    // succeeded, so a dir-fsync failure (a platform/filesystem that
    // won't fsync a directory) must NOT fail a write that physically
    // happened — it only forgoes the extra durability.
    try {
      const dirFd = openSync(dirname(target), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // directory fsync unsupported here — the write still succeeded
    }
    return buf.byteLength;
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close on the failure path
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // temp may not have been created
    }
    throw e;
  }
};
