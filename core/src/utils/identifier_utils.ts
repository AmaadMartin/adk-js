/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** What is being named, as it reads in the rejection message. */
export type NamedKind = 'Agent' | 'Node';

/**
 * Checks if the given string is a valid identifier.
 *
 * An identifier starts with a Unicode `ID_Start` character, `$` or `_`, and
 * continues with `ID_Continue` characters, `$`, `_` or `-`. ADK names that
 * become path segments or an `Event.author` value must match it. Hyphens are
 * accepted because ADK names are used as event authors and path segments, not
 * as source-language symbols.
 *
 * @param str The string to check.
 * @return True if the string is a valid identifier, false otherwise.
 */
export function isIdentifier(str: string): boolean {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u.test(str);
}

/**
 * Returns `name` if it is a valid identifier, and throws naming it if not.
 *
 * Agents and nodes share one rule and one message, because an agent is a node.
 *
 * @param kind What is being named, as it reads in the message.
 * @param name The name to validate.
 * @return The validated name.
 */
export function validateIdentifierName(kind: NamedKind, name: string): string {
  if (!isIdentifier(name)) {
    throw new Error(
      `Found invalid ${kind.toLowerCase()} name: "${
        name
      }". ${kind} name must be a valid identifier. It should start with a letter (a-z, A-Z) or an underscore (_), and can only contain letters, digits (0-9), underscores, and hyphens.`,
    );
  }
  return name;
}
