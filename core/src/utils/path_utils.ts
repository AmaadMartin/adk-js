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
 * This is a lexical check on path strings, not a sandbox. It says nothing about
 * the filesystem: it does not follow symlinks, it is unaffected by hard links
 * or bind mounts, and it cannot speak for a path that is swapped between this
 * call and the use that follows it (TOCTOU). A caller that needs the answer to
 * hold against the filesystem must canonicalise both paths with `fs.realpath`
 * first, and even then must tolerate the race.
 */
export function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return (
    rel === '' ||
    (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
  );
}
