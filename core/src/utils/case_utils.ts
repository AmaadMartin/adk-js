/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a string to snake_case.
 *
 * This ports `_to_snake_case` from adk-python, so an OpenAPI operation that
 * omits its `operationId` gets the same generated name in both SDKs. A run of
 * non-alphanumeric characters becomes one underscore, and a camelCase boundary
 * and the end of an acronym each gain one. So `REST API` becomes `rest_api`,
 * `X-Trace-Id` becomes `x_trace_id` and `HTTPResponse` becomes
 * `http_response`. Repeated, leading and trailing separators are removed.
 *
 * This converts one name. `toSnakeCase` in `object_notation_utils.ts` converts
 * the keys of an object and is a different operation.
 *
 * ```ts
 * snakeCase('camelCase'); // 'camel_case'
 * snakeCase('REST API'); // 'rest_api'
 * ```
 *
 * @param text The string to convert.
 * @returns The snake_case form, without leading or trailing underscores.
 */
export function snakeCase(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Converts a name into snake_case.
 *
 * The name the OpenAPI spec parser uses for {@link snakeCase}. Both names
 * convert one name the same way.
 *
 * @param text The name to convert.
 * @returns The snake_case form of the name.
 */
export const toSnakeCaseName = snakeCase;

/**
 * Converts an identifier to snake_case.
 *
 * The name the OpenAPI common helpers use for {@link snakeCase}. Both names
 * convert one identifier the same way.
 *
 * @param text The identifier to convert.
 * @returns The snake_case identifier.
 */
export const toSnakeCaseIdentifier = snakeCase;

/**
 * Recursively converts the snake_case keys of a plain object to camelCase.
 *
 * Use this rather than {@link camelCaseKeys} when the input is already known to
 * be an object, so the result does not have to be narrowed again.
 *
 * @param value The object to convert.
 * @returns An object with camelCase keys.
 */
export function camelCaseRecordKeys(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
    converted[camelKey] = camelCaseKeys(value[key]);
  }
  return converted;
}

/**
 * Converts a snake_case name to lowerCamelCase.
 *
 * A name with no underscore is returned unchanged, so an already-camelCase
 * name survives the call. Every later segment is lowercased before its first
 * character is uppercased, so `TWO_WORDS` becomes `twoWords`.
 *
 * This converts one name. `camelCaseKeys` converts the keys of an object and
 * is a different operation.
 *
 * @param value The snake_case name.
 * @returns The lowerCamelCase name.
 */
export function snakeToLowerCamel(value: string): string {
  if (!value.includes('_')) {
    return value;
  }
  return value
    .split('_')
    .map((segment, index) =>
      index === 0
        ? segment.toLowerCase()
        : segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Recursively converts snake_case keys of an object to camelCase.
 *
 * @param val The value to convert.
 * @returns The converted value.
 */
export function camelCaseKeys(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(camelCaseKeys);
  }
  if (val !== null && typeof val === 'object' && val.constructor === Object) {
    return camelCaseRecordKeys(val as Record<string, unknown>);
  }
  return val;
}
