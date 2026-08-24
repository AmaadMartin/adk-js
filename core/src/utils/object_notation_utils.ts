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
 * @returns The object with camelCase keys.
 */
export function toCamelCase(
  obj: unknown,
  preserveKeys: string[] = [],
): unknown {
  return toNotation(obj, toCamelCaseKey, '', preserveKeys);
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
 * Removes every property whose value is `null`, recursively.
 *
 * Python serializers write an unset optional field as `null`, while a zod
 * `.optional()` field accepts the property being absent but not `null`. Drop
 * those properties to read such a payload.
 *
 * @param obj The value to clean.
 * @param preserveKeys Dotted paths whose values are left exactly as they are,
 *     using the same path syntax as {@link toCamelCase}. Use it for maps of
 *     user-defined keys, where a `null` value is data rather than an omission.
 */
export function stripNullValues(
  obj: unknown,
  preserveKeys: string[] = [],
): unknown {
  return stripNulls(obj, '', preserveKeys);
}

function stripNulls(
  obj: unknown,
  parentKey: string,
  preserveKeys: string[],
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => stripNulls(item, parentKey, preserveKeys));
  }

  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const source = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const fullPath = parentKey !== '' ? parentKey + '.' + key : key;
    if (preserveKeys.includes(fullPath)) {
      result[key] = value;
    } else if (value !== null) {
      result[key] = stripNulls(value, fullPath, preserveKeys);
    }
  }
  return result;
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
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      toNotation(item, converter, parentKey, preserveKeys),
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
      } else {
        result[convertedKey] = toNotation(
          source[key],
          converter,
          fullPath,
          preserveKeys,
        );
      }
    }

    return result;
  }

  return obj;
}
