/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prefix marking a filename as user-scoped rather than session-scoped. */
export const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Device names that Win32 resolves in every directory, case-insensitively and
 * with any extension, so a path component named after one names the device
 * rather than a file.
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** Characters that Win32 rejects in a path component. */
// eslint-disable-next-line no-control-regex -- U+0000-U+001F are part of the reserved set this pattern must match.
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;

/**
 * Throws if `filename` cannot be stored faithfully by every backend.
 *
 * An artifact filename is a storage key. `FileArtifactService` maps a filename
 * onto a directory name, and Windows removes trailing spaces and periods from
 * a path component, so two such names collapse onto one directory there while
 * the in-memory and GCS backends keep them apart. Windows also refuses to
 * create a directory that uses a reserved device name or a reserved character,
 * so such a name is storable on POSIX and unstorable there. Every backend
 * rejects all four shapes instead, so the strictest host decides the accepted
 * set for every host: a name with leading or trailing whitespace, a name with
 * a path segment ending in a period, a name containing a reserved character,
 * and a name whose path segment is a reserved device name.
 *
 * The answer is host-independent by design. The check splits on `\` as well as
 * `/`, so a backslash-separated name is rejected on POSIX too, where a
 * backslash is a legal filename character. `.` and `..` are exempt: they are
 * navigation segments that `path.resolve` consumes before the host filesystem
 * sees them.
 *
 * See
 * https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats#trim-characters
 * and
 * https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file.
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
  if (WINDOWS_RESERVED_CHARACTERS.test(scoped)) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} must not contain a character reserved by Windows (< > : " | ? * or a control character).`,
    );
  }
  for (const segment of segments) {
    const deviceName = segment.split('.')[0].trim().toUpperCase();
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(deviceName)) {
      throw new Error(
        `Artifact filename ${JSON.stringify(filename)} must not use the reserved device name "${deviceName}".`,
      );
    }
  }
}

/** Removes the `user:` prefix from `filename`, if it has one. */
export function stripUserNamespace(filename: string): string {
  return filename.startsWith(USER_NAMESPACE_PREFIX)
    ? filename.substring(USER_NAMESPACE_PREFIX.length)
    : filename;
}
