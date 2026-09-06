/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Converts an object with snake_case keys to camelCase keys.
 *
 * @param obj The object to convert.
 * @param preserveKeys Dotted paths to preserve in their original form.
 * @param preserveKeysAtAnyDepth Bare keys to preserve wherever they occur, for
 *   documents whose opaque values sit at a depth the caller cannot enumerate.
 * @returns The object with camelCase keys.
 */
export function toCamelCase(
  obj: unknown,
  preserveKeys: string[] = [],
  preserveKeysAtAnyDepth: ReadonlySet<string> = NO_KEYS,
): unknown {
  return toNotation(
    obj,
    toCamelCaseKey,
    '',
    preserveKeys,
    preserveKeysAtAnyDepth,
  );
}

/**
 * Converts an object with camelCase keys to snake_case keys.
 *
 * @param obj The object to convert.
 * @param preserveKeys Dotted paths to preserve in their original form.
 * @param preserveKeysAtAnyDepth Bare keys to preserve wherever they occur, for
 *   documents whose opaque values sit at a depth the caller cannot enumerate.
 * @returns The object with snake_case keys.
 */
export function toSnakeCase(
  obj: unknown,
  preserveKeys: string[] = [],
  preserveKeysAtAnyDepth: ReadonlySet<string> = NO_KEYS,
): unknown {
  return toNotation(
    obj,
    toSnakeCaseKey,
    '',
    preserveKeys,
    preserveKeysAtAnyDepth,
  );
}

const toCamelCaseKey = (key: string) =>
  key.replace(/_([a-z])/g, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );

const toSnakeCaseKey = (key: string) =>
  key.replace(/[A-Z]/g, (g) => '_' + g.toLowerCase());

function toNotation(
  obj: unknown,
  converter: (key: string) => string,
  parentKey: string = '',
  preserveKeys: string[] = [],
  preserveKeysAtAnyDepth: ReadonlySet<string> = NO_KEYS,
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      toNotation(
        item,
        converter,
        parentKey,
        preserveKeys,
        preserveKeysAtAnyDepth,
      ),
    );
  }

  if (typeof obj === 'object' && obj !== null) {
    const source = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
      const convertedKey = converter(key);
      const fullPath = parentKey !== '' ? parentKey + '.' + key : key;

      if (preserveKeys.includes(fullPath) || preserveKeysAtAnyDepth.has(key)) {
        result[convertedKey] = source[key];
      } else {
        result[convertedKey] = toNotation(
          source[key],
          converter,
          fullPath,
          preserveKeys,
          preserveKeysAtAnyDepth,
        );
      }
    }

    return result;
  }

  return obj;
}
