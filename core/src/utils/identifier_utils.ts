/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks if the given string is a valid identifier.
 *
 * An identifier starts with a letter or an underscore and continues with
 * letters, digits, underscores or hyphens. Hyphens are accepted because ADK
 * names are used as event authors and path segments, not as source-language
 * symbols.
 *
 * @param str The string to check.
 * @return True if the string is a valid identifier, false otherwise.
 */
export function isIdentifier(str: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u.test(str);
}
