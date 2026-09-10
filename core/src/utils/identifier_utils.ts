/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks if the given string is a valid identifier.
 *
 * An identifier starts with a Unicode `ID_Start` character, `$` or `_`, and
 * continues with `ID_Continue` characters, `$`, `_` or `-`. ADK names that
 * become path segments or an `Event.author` value must match it.
 *
 * @param str The string to check.
 * @return True if the string is a valid identifier, false otherwise.
 */
export function isIdentifier(str: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u.test(str);
}
