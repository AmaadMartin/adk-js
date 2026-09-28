/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for normalizing file path strings produced by the model.
 *
 * Ported from `cli/built_in_agents/utils/path_normalizer.py` in adk-python.
 */

/**
 * Whitespace and quote characters at either end of a path or of one of its
 * segments. Equivalent to the character set Python's `str.strip(chars)` is
 * given in the reference.
 */
const BOUNDARY_PATTERN = /^[ \t\r\n'"`]+|[ \t\r\n'"`]+$/g;

/** Splits a path on `/` and `\` while keeping the separators as segments. */
const SEGMENT_SPLIT_PATTERN = /([/\\])/;

/** Removes every leading and trailing {@link BOUNDARY_PATTERN} character. */
function stripBoundaryChars(value: string): string {
  return value.replace(BOUNDARY_PATTERN, '');
}

/**
 * Strips stray quotes and whitespace around a path and around each of its
 * segments.
 *
 * The model occasionally emits quoted paths such as `'tools/web.yaml'`, which
 * would otherwise create a directory literally named `'tools`. Interior
 * characters are preserved, so a real filename such as `my'file.yaml` survives.
 * When stripping would leave nothing at all, the whitespace-trimmed input is
 * returned instead, so `"'''"` stays `"'''"` rather than becoming an empty
 * path.
 *
 * @param filePath Path string provided by the model or the user.
 * @return The sanitized path string.
 */
export function sanitizeGeneratedFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return trimmed;
  }

  const sanitized = trimmed
    .split(SEGMENT_SPLIT_PATTERN)
    .map((segment) => stripBoundaryChars(segment))
    .join('');

  return stripBoundaryChars(sanitized) || trimmed;
}
