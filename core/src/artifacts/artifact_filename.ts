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
  const scoped = stripUserNamespace(filename);
  if (scoped !== scoped.trim()) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not have leading or trailing whitespace.`,
    );
  }
}

/**
 * Throws if any path segment of `filename` ends with a period.
 *
 * Windows removes a trailing period from a path component, so
 * `'trailing.dot.'` and `'trailing.dot'` name one directory there. The second
 * save then appends a version to the first artifact and reads return the wrong
 * bytes, while the in-memory and GCS backends keep the two names apart. Every
 * backend rejects the name so that no backend aliases one artifact onto
 * another.
 *
 * The answer is host-independent by design. The check splits on `\` as well as
 * `/`, so a backslash-separated name is rejected on POSIX too, where a
 * backslash is a legal filename character. `.` and `..` are exempt: they are
 * navigation segments that `path.resolve` consumes before the host filesystem
 * sees them.
 *
 * See
 * https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats#trim-characters.
 *
 * @param filename The artifact filename, including any `user:` prefix.
 */
export function assertNoTrailingPeriod(filename: string): void {
  const segments = stripUserNamespace(filename).split(/[/\\]/);
  if (segments.some(endsWithPeriod)) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not have a path segment ending in a period.`,
    );
  }
}

function stripUserNamespace(filename: string): string {
  return filename.startsWith(USER_NAMESPACE_PREFIX)
    ? filename.substring(USER_NAMESPACE_PREFIX.length)
    : filename;
}

function endsWithPeriod(segment: string): boolean {
  return segment.endsWith('.') && segment !== '.' && segment !== '..';
}
