/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A dependency-free validator for the subset of JSON Schema that ADK freezes
 * into events, with the scalar coercion a wire payload needs.
 *
 * Mirrors `google/adk-python` `_validate_resume_response`, which delegates to
 * pydantic in lax mode. The mainstream JSON Schema validators compile schemas
 * through the `Function` constructor, which a strict-CSP browser blocks, and
 * the web bundle is a supported target.
 */

import {formatError} from './error_utils.js';

/** Strings a `boolean` schema accepts, after trimming and lowercasing. */
const BOOLEAN_STRINGS = new Map<string, boolean>([
  ['true', true],
  ['1', true],
  ['false', false],
  ['0', false],
]);

/** A string an `integer` schema may coerce: optional sign, digits only. */
const INTEGER_PATTERN = /^\s*[+-]?\d+\s*$/;

/**
 * Validates `value` against `schema`, coercing scalars written as strings.
 *
 * A schema shape this subset does not recognise — no `type`, an unknown
 * `type`, a `type` array, a `$ref` — is accepted unvalidated rather than
 * rejected, so a resume that works today cannot start failing on a schema the
 * validator does not understand.
 *
 * @param value The value to validate.
 * @param schema A plain JSON Schema object, or anything else to skip.
 * @return The validated value, with coerced scalars substituted.
 * @throws Error describing the first violation found.
 */
export function validateAgainstJsonSchema(
  value: unknown,
  schema: unknown,
): unknown {
  if (!isRecord(schema)) {
    return value;
  }
  // A genai `Schema` spells optionality as `nullable`, unlike the `type` array
  // a Zod-derived schema produces.
  if (schema['nullable'] === true && value === null) {
    return value;
  }
  const type = schema['type'];
  if (typeof type !== 'string') {
    return value;
  }
  // A genai `Schema` passes through `toJsonSchema` verbatim, so its `type` is
  // the uppercase `Type` enum while a Zod-derived one is lowercase.
  switch (type.toLowerCase()) {
    case 'string':
      return validateString(value);
    case 'integer':
      return coerceInteger(value);
    case 'number':
      return coerceNumber(value);
    case 'boolean':
      return coerceBoolean(value);
    case 'array':
      return validateArray(value);
    case 'object':
      return validateObject(value, schema);
    default:
      return value;
  }
}

/** Narrows an unknown value to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  // No number-to-string coercion, matching pydantic's lax mode.
  throw typeError('string', value);
}

function coerceInteger(value: unknown): number {
  const parsed =
    typeof value === 'string' && INTEGER_PATTERN.test(value)
      ? Number(value)
      : value;
  if (typeof parsed === 'number' && Number.isSafeInteger(parsed)) {
    return parsed;
  }
  throw typeError('integer', value);
}

function coerceNumber(value: unknown): number {
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    return parsed;
  }
  throw typeError('number', value);
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const coerced = BOOLEAN_STRINGS.get(value.trim().toLowerCase());
    if (coerced !== undefined) {
      return coerced;
    }
  }
  throw typeError('boolean', value);
}

function validateArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    // `items` is not descended into, matching `google/adk-python`.
    return value;
  }
  throw typeError('array', value);
}

function validateObject(
  value: unknown,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw typeError('object', value);
  }
  const properties = schema['properties'];
  if (!isRecord(properties)) {
    return value;
  }
  const required = schema['required'];
  const requiredKeys = Array.isArray(required) ? required : [];
  // Keys outside `properties` are preserved: discarding data the caller sent
  // is worse than passing it through unvalidated.
  const validated: Record<string, unknown> = {...value};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value)) {
      if (requiredKeys.includes(key)) {
        throw propertyError(key, 'required property is missing');
      }
      continue;
    }
    try {
      validated[key] = validateAgainstJsonSchema(value[key], propertySchema);
    } catch (e: unknown) {
      throw propertyError(key, formatError(e));
    }
  }
  return validated;
}

function typeError(type: string, value: unknown): Error {
  return new Error(
    `Failed to coerce data to ${type}: expected ${type}, got ${describe(value)}`,
  );
}

function propertyError(key: string, reason: string): Error {
  return new Error(
    `Validation failed for object schema: property '${key}': ${reason}`,
  );
}

/** Renders a rejected value compactly, without echoing a whole payload. */
function describe(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value === 'object' ? 'object' : String(value);
}
