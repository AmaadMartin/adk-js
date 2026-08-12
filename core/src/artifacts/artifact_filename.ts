/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Throws if `filename` differs only in case from an artifact already stored in
 * the same scope.
 *
 * An artifact filename is a storage key. `FileArtifactService` maps a filename
 * onto a directory name, and NTFS and APFS resolve two names that differ only
 * in case to one directory, so that backend cannot keep both artifacts apart.
 * Every backend rejects the second name, so that one backend never aliases
 * `'Report.txt'` onto `'report.txt'` while the others store them separately.
 *
 * The comparison uses `toLowerCase()` rather than `toLocaleLowerCase()`, so the
 * same pair of filenames is accepted or rejected under every host locale.
 *
 * @param existingFilenames The artifact keys already stored in the same scope,
 *     in the same representation as `filename`.
 * @param filename The candidate artifact filename.
 */
export function assertNoCaseCollision(
  existingFilenames: Iterable<string>,
  filename: string,
): void {
  const foldedFilename = filename.toLowerCase();
  for (const existing of existingFilenames) {
    if (existing !== filename && existing.toLowerCase() === foldedFilename) {
      throw new Error(
        `Artifact filename ${JSON.stringify(filename)} differs only in case ` +
          `from existing artifact ${JSON.stringify(existing)}.`,
      );
    }
  }
}
