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

const toCamelCaseKey = (key: string) =>
  key.replace(/_([a-z])/g, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );

/**
 * Converts a single camelCase key to its snake_case spelling.
 *
 * Each upper-case letter becomes an underscore followed by its lower-case
 * form, so `metricName1` becomes `metric_name1`. A digit does not start a new
 * segment, which differs from pydantic's `to_camel` inverse
 * (`metric_name_1`), so a field whose name ends in a digit segment needs an
 * explicit alias rather than this converter.
 */
export const toSnakeCaseKey = (key: string) =>
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
