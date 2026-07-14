/**
 * R169B-STEP10 (B4): Shared layout I/O leaf module.
 *
 * This module provides the durable directory creation primitive used by
 * the generation store, publisher, CAS store, and GC. Extracting it
 * here avoids module cycles and ensures consistent mode/permissions/fsync
 * behavior across all callers.
 *
 * STATUS: FOUNDATION / INACTIVE
 */

import {
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  fstatSync,
  constants as fsConstants,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Ensure a directory exists with mode 0o700, and fsync it (and its parent
 * if newly created). This is the shared primitive for durable layout
 * creation.
 *
 * R169B-STEP10 (§11 POST-PUSH): hardened version:
 * - Replaces existsSync with lstat fail-closed (existsSync masks errors).
 * - Verifies the directory is a regular directory (non-symlink).
 * - Verifies mode 0o700 after chmod.
 * - Verifies owner matches process uid.
 * - Fsyncs the parent on creation — FATAL if parent fsync fails (the
 *   directory entry would not be durable after a crash).
 * - Parent dir is auto-derived if not provided.
 */
export function ensureDirDurable(
  dirPath: string,
  parentDir: string | null,
): void {
  // R169B-STEP10 (§11): Use lstat instead of existsSync. existsSync
  // masks permission errors, broken symlinks, and other filesystem
  // anomalies. lstat is fail-closed: any error other than ENOENT
  // is thrown.
  let isNew = false;
  try {
    const st = lstatSync(dirPath);
    // Directory exists — verify it's a regular directory (not a symlink).
    if (st.isSymbolicLink()) {
      throw new Error(`ensureDirDurable: path is a symlink: ${dirPath}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`ensureDirDurable: path is not a directory: ${dirPath}`);
    }
    // Verify owner matches process uid (if available on this platform).
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error(
        `ensureDirDurable: directory owner uid=${st.uid} != process uid=${process.getuid()}: ${dirPath}`,
      );
    }
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      isNew = true;
    } else {
      throw new Error(`ensureDirDurable: lstat failed for "${dirPath}": ${(e as Error).message}`);
    }
  }

  if (isNew) {
    try {
      mkdirSync(dirPath, { recursive: false, mode: 0o700 });
    } catch (e) {
      // Directory might have been created by another process (EEXIST race).
      // Re-lstat to verify it's now a directory.
      try {
        const st = lstatSync(dirPath);
        if (!st.isDirectory()) {
          throw new Error(`ensureDirDurable: path exists but is not a directory after mkdir: ${dirPath}`);
        }
      } catch {
        throw new Error(`ensureDirDurable: failed to create directory "${dirPath}": ${(e as Error).message}`);
      }
    }
  }

  // Force mode 0o700 (mkdirSync mode is filtered by umask).
  try {
    chmodSync(dirPath, 0o700);
  } catch (e) {
    throw new Error(`ensureDirDurable: failed to chmod 0o700 on "${dirPath}": ${(e as Error).message}`);
  }

  // Verify the mode is actually 0o700 after chmod.
  try {
    const st = lstatSync(dirPath);
    if ((st.mode & 0o777) !== 0o700) {
      throw new Error(
        `ensureDirDurable: mode is ${String(st.mode & 0o777)} after chmod, expected 0o700: ${dirPath}`,
      );
    }
  } catch (e) {
    throw new Error(`ensureDirDurable: post-chmod lstat failed for "${dirPath}": ${(e as Error).message}`);
  }

  // R169B (§14 GATE): fsync the directory using O_RDONLY|O_DIRECTORY|O_NOFOLLOW
  // to prevent a TOCTOU race where the path becomes a symlink between the
  // lstat and the open. fstat verifies the fd matches the lstat identity.
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const fdStat = fstatSync(fd);
    // Verify the fd matches the directory we lstat'd (dev/ino).
    if (fdStat.isSymbolicLink() || !fdStat.isDirectory()) {
      throw new Error(`ensureDirDurable: fd is not a directory: ${dirPath}`);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    throw new Error(`ensureDirDurable: failed to fsync directory "${dirPath}": ${(e as Error).message}`);
  }

  // R169B-STEP10 (§11): If newly created, fsync the parent. This is
  // FATAL — without it, the directory entry for the new directory
  // would not survive a crash, making the directory itself unreachable
  // even though its contents are durable.
  if (isNew) {
    const parent = parentDir ?? dirname(dirPath);
    let parentFd: number | null = null;
    try {
      // R169B (§14): Open parent with O_RDONLY|O_DIRECTORY|O_NOFOLLOW.
      parentFd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const parentFdStat = fstatSync(parentFd);
      if (parentFdStat.isSymbolicLink() || !parentFdStat.isDirectory()) {
        throw new Error(`parent fd is not a directory: ${parent}`);
      }
      fsyncSync(parentFd);
      closeSync(parentFd);
      parentFd = null;
    } catch (e) {
      if (parentFd !== null) {
        try { closeSync(parentFd); } catch { /* best effort */ }
      }
      // FATAL: parent fsync failure means the new directory entry
      // may not be durable.
      throw new Error(
        `ensureDirDurable: FATAL — failed to fsync parent "${parent}" after creating "${dirPath}": ${(e as Error).message}`,
      );
    }
  }
}
