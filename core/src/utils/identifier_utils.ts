/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks if the given string is a valid identifier.
 *
 * ADK applies this rule to any name that becomes part of a path or an event
 * author — an agent name, a workflow node name — so the name survives being
 * split back out of that path.
 *
 * The rule is Unicode-aware (`ID_Start` / `ID_Continue`) and additionally
 * permits `-`, which plain JavaScript identifiers do not, because hyphenated
 * agent and node names are widespread in ADK.
 *
 * @param str The string to check.
 * @return True if the string is a valid identifier, false otherwise.
 */
export function isIdentifier(str: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u.test(str);
}
