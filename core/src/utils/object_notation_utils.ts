/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts an object with snake_case keys to camelCase keys.
 *
 * @param obj The object to convert.
 * @param preserveKeys Keys to preserve in their original form.
 * @param dropNulls Whether to also drop every property whose value is `null`.
 *     Python serializers write an unset optional field as `null`, while a zod
 *     `.optional()` field accepts the property being absent but not `null`. A
 *     property under a preserved key is kept either way, because a `null` in a
 *     map of user-defined keys is data rather than an omission.
 * @returns The object with camelCase keys.
 */
export function toCamelCase(
  obj: unknown,
  preserveKeys: string[] = [],
  dropNulls = false,
): unknown {
  return toNotation(obj, toCamelCaseKey, '', preserveKeys, dropNulls);
}

/**
 * Converts an object with camelCase keys to snake_case keys.
 *
 * @param obj The object to convert.
 * @param preserveKeys Keys to preserve in their original form.
 * @returns The object with snake_case keys.
 */
export function toSnakeCase(
  obj: unknown,
  preserveKeys: string[] = [],
): unknown {
  return toNotation(obj, toSnakeCaseKey, '', preserveKeys);
}

/**
 * Rewrites one snake_case key as camelCase.
 */
export const toCamelCaseKey = (key: string) =>
  key.replace(/_([a-z])/g, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );

/**
 * Rewrites one camelCase key as snake_case.
 */
export const toSnakeCaseKey = (key: string) =>
  key.replace(/[A-Z]/g, (g) => '_' + g.toLowerCase());

function toNotation(
  obj: unknown,
  converter: (key: string) => string,
  parentKey: string = '',
  preserveKeys: string[] = [],
  dropNulls = false,
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      toNotation(item, converter, parentKey, preserveKeys, dropNulls),
    );
  }

  if (typeof obj === 'object' && obj !== null) {
    const source = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
      const convertedKey = converter(key);
      const fullPath = parentKey !== '' ? parentKey + '.' + key : key;

      if (preserveKeys.includes(fullPath)) {
        result[convertedKey] = source[key];
      } else if (!dropNulls || source[key] !== null) {
        result[convertedKey] = toNotation(
          source[key],
          converter,
          fullPath,
          preserveKeys,
          dropNulls,
        );
      }
    }

    return result;
  }

  return obj;
}
