/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Resolves `filePath` against `baseDir` and reports whether it stays inside.
 *
 * This is a **lexical** containment check on the resolved path strings, not a
 * sandbox: it does not survive symlinks, hardlinks, bind mounts, or TOCTOU
 * races. It is a guard against accidental traversal, not a security boundary.
 *
 * The caller owns the failure message, so `undefined` is returned rather than
 * thrown. The return type forces the escape case to be handled.
 *
 * @param baseDir The directory the result must stay inside.
 * @param filePath A path relative to `baseDir`, or an absolute path.
 * @return The resolved absolute path, or `undefined` when it escapes.
 */
export function resolveWithinDir(
  baseDir: string,
  filePath: string,
): string | undefined {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    // `path.relative` returns an absolute path across Windows drives.
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return resolved;
}
