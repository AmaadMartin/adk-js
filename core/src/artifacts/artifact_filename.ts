/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prefix marking a filename as user-scoped rather than session-scoped. */
export const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Throws if `filename` has leading or trailing whitespace.
 *
 * An artifact filename is a storage key. `FileArtifactService` maps a filename
 * onto a directory name, and Windows removes trailing spaces and periods from
 * a path component, so a padded name cannot be stored there distinctly from
 * its unpadded twin. Every backend rejects a padded name, so that one backend
 * never aliases `' a.txt'` onto `'a.txt'` while the others keep them apart.
 *
 * See
 * https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats#trim-characters.
 *
 * @param filename The artifact filename, including any `user:` prefix.
 */
export function assertUnpaddedFilename(filename: string): void {
  const scoped = filename.startsWith(USER_NAMESPACE_PREFIX)
    ? filename.substring(USER_NAMESPACE_PREFIX.length)
    : filename;
  if (scoped !== scoped.trim()) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not have leading or trailing whitespace.`,
    );
  }
}
