/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from '../../../utils/case_utils.js';

/** Argument name used when a parameter's location is not a known one. */
const DEFAULT_NAME = 'value';

/**
 * Argument name used when a parameter's name derives to nothing.
 *
 * A `Map` rather than an object literal: the key is the parameter location
 * straight from an untrusted document, and an object lookup resolves
 * inherited names such as `constructor`.
 */
const DEFAULT_NAME_BY_LOCATION: ReadonlyMap<string, string> = new Map([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** One argument of a tool generated from an OpenAPI operation. */
export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
}

/** The values {@link createApiParameter} derives a parameter from. */
export interface ApiParameterInit {
  originalName: string;
  paramLocation: string;
  /** A schema object, or a JSON string holding one. */
  paramSchema?:
    | OpenAPIV3.SchemaObject
    | OpenAPIV3.ReferenceObject
    | string
    | boolean;
  description?: string;
  /** Overrides the derived name when provided. */
  name?: string;
  required?: boolean;
}

/** Parses a schema held as a JSON string. */
function parseSchemaJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
}

/**
 * Coerces a schema-bearing OpenAPI value into a concrete schema object.
 *
 * A document is parsed from user JSON or YAML, so a schema field arrives in
 * shapes the typings do not promise: absent, a boolean, an unresolved `$ref`,
 * a JSON string, or a value that is not an object at all. This accepts the
 * usable ones and rejects the rest with a message naming the field, rather
 * than letting a `TypeError` escape from deeper in.
 *
 * @param value The value to coerce.
 * @param context Phrase naming the value, used in the error message.
 * @throws {Error} If the value cannot be a usable schema.
 * @returns The schema; an already-plain object is returned by reference.
 */
function normalizeOpenApiSchema(
  value: unknown,
  context: string,
): OpenAPIV3.SchemaObject {
  if (value === undefined || value === null || value === true) {
    return {};
  }
  if (value === false) {
    throw new Error(`${context} uses an unsatisfiable false schema`);
  }

  const parsed =
    typeof value === 'string' ? parseSchemaJson(value, context) : value;

  if (Array.isArray(parsed)) {
    throw new Error(`${context} must be an OpenAPI schema, got array`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `${context} must be an OpenAPI schema, got ${typeof parsed}`,
    );
  }

  const ref = (parsed as Record<string, unknown>)['$ref'];
  if (typeof ref === 'string') {
    throw new Error(`${context} contains unresolved reference '${ref}'`);
  }
  return parsed;
}

/**
 * Derives a tool-facing parameter from an OpenAPI parameter.
 *
 * The name is the caller's, else the snake_case original, else a name for the
 * parameter's location. The description is the caller's, else the schema's
 * own. `init` is not modified.
 *
 * @param init The parameter as the document declares it.
 * @throws {Error} If the schema is unusable.
 * @returns The parameter.
 */
export function createApiParameter(init: ApiParameterInit): ApiParameter {
  const paramSchema = normalizeOpenApiSchema(
    init.paramSchema,
    `parameter '${init.originalName}' schema`,
  );
  return {
    originalName: init.originalName,
    paramLocation: init.paramLocation,
    paramSchema,
    description: init.description || paramSchema.description || '',
    name:
      init.name ||
      snakeCase(init.originalName) ||
      DEFAULT_NAME_BY_LOCATION.get(init.paramLocation) ||
      DEFAULT_NAME,
    required: init.required ?? false,
  };
}
