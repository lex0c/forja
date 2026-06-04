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

// Cap on the basename slice embedded in the temp name. NAME_MAX is 255
// bytes on common filesystems and the suffix (`.` + uuid + `.tmp`) is
// ~42 bytes, so 128 keeps the temp name well under the limit even for a
// long filename while leaving orphans recognizable.
const TEMP_BASENAME_CAP = 128;

export const atomicWrite = (absPath: string, content: string): number => {
  // Follow a symlink to its real target so we replace the target's
  // content (link preserved), not the link. A path that doesn't exist
  // yet (new file) has no link to follow — use it as-is.
  const target = existsSync(absPath) ? realpathSync(absPath) : absPath;
  const buf = Buffer.from(content, 'utf8');
  const tmp = join(
    dirname(target),
    `.${basename(target).slice(0, TEMP_BASENAME_CAP)}.${crypto.randomUUID()}.tmp`,
  );
  mkdirSync(dirname(target), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx'); // 'wx' — never clobber an unexpected temp
    writeSync(fd, buf);
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
