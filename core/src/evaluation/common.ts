/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {toSnakeCaseKey} from '../utils/object_notation_utils.js';

/**
 * Wraps an evaluation object schema so it reads adk-python's snake_case
 * spelling of a property as well as the canonical camelCase one.
 *
 * A key keeps its spelling when the canonical one is already present, so
 * supplying both leaves the alias in place, and a strict object then reports
 * it as an unrecognized key.
 */
export function evalSchema<Shape extends z.ZodRawShape>(
  object: z.ZodObject<Shape>,
): z.ZodType<z.infer<z.ZodObject<Shape>>> {
  const properties = new Map<string, string>();
  for (const property of Object.keys(object.shape)) {
    properties.set(toSnakeCaseKey(property), property);
  }

  return z
    .looseObject({})
    .transform((raw) => renameKeys(raw, properties))
    .pipe(object);
}

/**
 * Validates a value against an evaluation schema.
 *
 * @param name The model name, used in the validation error message.
 * @throws {InputValidationError} If the value does not fit the schema.
 */
export function parseEval<T>(
  schema: z.ZodType<T>,
  name: string,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${name}: ${describeIssues(result.error)}`,
      {cause: result.error},
    );
  }
  return result.data;
}

/** Renames the keys of `source` through `replacements`. */
function renameKeys(
  source: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const replacement = replacements.get(key);
    const rename = replacement !== undefined && !(replacement in source);
    renamed[rename ? replacement : key] = value;
  }
  return renamed;
}

/** Summarizes a validation failure, naming the property of each problem. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}
