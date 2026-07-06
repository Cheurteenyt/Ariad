// v2/src/utils/safe-path.ts
// R53 (Part C): shared symlink-safe path resolution utility.
// Used by both vault.ts (assertPathInsideVault) and server.ts (routeBrowse,
// routeIndex) to avoid duplicating security-sensitive realpath logic.

import { realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';

/**
 * Resolve a path to its real (symlink-followed) location, with a fallback
 * for paths that don't exist yet (e.g., a file being created).
 */
export function safeRealpath(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    try {
      const realParent = realpathSync(dirname(absPath));
      return join(realParent, basename(absPath));
    } catch {
      return resolve(absPath);
    }
  }
}

/**
 * Check if a path is inside a root directory, following symlinks.
 */
export function assertPathInsideRoot(rootPath: string, relPath: string): string {
  if (relPath.includes('..')) {
    throw new Error(`Path traversal rejected: "${relPath}" contains "..".`);
  }
  if (/[\\]/.test(relPath)) {
    throw new Error(`Path traversal rejected: "${relPath}" contains backslashes.`);
  }
  let absRoot: string;
  try {
    absRoot = realpathSync(rootPath);
  } catch {
    absRoot = resolve(rootPath);
  }
  const absPath = resolve(join(absRoot, relPath));
  const realPath = safeRealpath(absPath);
  if (realPath !== absRoot && !realPath.startsWith(absRoot + sep)) {
    throw new Error(
      `Path traversal rejected: "${relPath}" resolves outside the root "${absRoot}".`
    );
  }
  return realPath;
}
