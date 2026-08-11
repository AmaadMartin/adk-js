/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prefix marking a filename as user-scoped rather than session-scoped. */
export const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Throws if `filename` cannot be stored faithfully by every backend.
 *
 * An artifact filename is a storage key. `FileArtifactService` maps a filename
 * onto a directory name, and Windows removes trailing spaces and periods from
 * a path component, so two such names collapse onto one directory there while
 * the in-memory and GCS backends keep them apart. Every backend rejects the
 * name instead, so no backend aliases one artifact onto another. Two shapes
 * are rejected: a name with leading or trailing whitespace, and a name with a
 * path segment ending in a period.
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
export function assertValidArtifactFilename(filename: string): void {
  const scoped = stripUserNamespace(filename);
  if (scoped !== scoped.trim()) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not have leading or trailing whitespace.`,
    );
  }
  const segments = scoped.split(/[/\\]/);
  if (segments.some((s) => s.endsWith('.') && s !== '.' && s !== '..')) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not have a path segment ending in a period.`,
    );
  }
}

/** Removes the `user:` prefix from `filename`, if it has one. */
export function stripUserNamespace(filename: string): string {
  return filename.startsWith(USER_NAMESPACE_PREFIX)
    ? filename.substring(USER_NAMESPACE_PREFIX.length)
    : filename;
}
