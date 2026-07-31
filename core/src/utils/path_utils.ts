/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Reports whether `candidate` is `root` itself or sits underneath it.
 *
 * Both paths are resolved first, and containment is decided per path segment,
 * so a sibling whose name merely starts with the root's — `/srv/data-old`
 * against a root of `/srv/data` — is not reported as contained.
 *
 * This compares path strings. A caller that needs the answer to hold against
 * the filesystem must canonicalise both paths with `fs.realpath` first, and
 * even then it says nothing about a path swapped between this check and the
 * use that follows it (TOCTOU), or about hard links.
 */
export function isPathContained(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..')
  );
}
