/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Reports whether `targetPath` is `baseDir` itself or sits underneath it.
 *
 * Both arguments are resolved first, and containment is decided per path
 * segment rather than by string prefix, so a sibling whose name merely starts
 * with the base directory's — `/srv/data-old` against a base of `/srv/data` —
 * is not reported as contained.
 *
 * Lexical check on path strings, not a sandbox: it does not resolve symlinks.
 * A caller that needs the answer to hold against the filesystem must
 * `fs.realpath` both paths first, and still races.
 */
export function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(baseDir, targetPath);
  return (
    !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
  );
}
