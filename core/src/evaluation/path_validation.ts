/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rejects values that could alter a filesystem path.
 *
 * @param value The caller-supplied identifier.
 * @param fieldName Human-readable field name used in error messages.
 * @throws {Error} If the value is empty, or contains null bytes, path
 *     separators, or traversal segments (`.` or `..`).
 */
export function validatePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  if (value.includes('\x00')) {
    throw new Error(`${fieldName} must not contain null bytes.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(
      `${fieldName} '${value}' must not contain path separators.`,
    );
  }
  if (value === '.' || value === '..') {
    throw new Error(
      `${fieldName} '${value}' must not contain traversal segments.`,
    );
  }
}
