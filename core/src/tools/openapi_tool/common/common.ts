/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';

/** Type name used whenever a schema does not name a type this module maps. */
const UNKNOWN_TYPE = 'unknown';

/** OpenAPI schema type -> TypeScript type name. */
const TYPE_NAMES = new Map<string, string>([
  ['integer', 'number'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['string', 'string'],
  ['object', 'Record<string, unknown>'],
]);

/**
 * Argument name used when a parameter's name derives to nothing.
 *
 * A `Map` rather than an object literal: the key is the parameter location
 * straight from an untrusted spec, and an object lookup resolves inherited
 * names such as `constructor`.
 */
const DEFAULT_NAME_BY_LOCATION = new Map<string, string>([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** Fallback when the location is unknown. */
const DEFAULT_NAME = 'value';

/** Indent of a property line under a parameter's documentation. */
const PARAM_PROPERTY_INDENT = '       ';

/** Indent of a property line under the return documentation. */
const RETURN_PROPERTY_INDENT = '        ';

/** Matches an all-digit response status key such as `200`. */
const NUMERIC_STATUS = /^\d+$/;

/** A single argument of a tool generated from an OpenAPI operation. */
export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
}

/** The values `createApiParameter` derives an {@link ApiParameter} from. */
export interface ApiParameterInit {
  originalName: string;
  paramLocation: string;
  /** The schema as the spec declares it; normalized via `normalizeSchema`. */
  paramSchema:
    | OpenAPIV3.SchemaObject
    | OpenAPIV3.ReferenceObject
    | boolean
    | undefined;
  description?: string;
  /** Derived from `originalName`/`paramLocation` when absent or empty. */
  name?: string;
  required?: boolean;
}

/**
 * Coerces a schema-bearing OpenAPI value into a concrete schema object.
 *
 * A spec is parsed from user JSON or YAML, so a schema field arrives in
 * shapes the typings do not promise: absent, a boolean, an unresolved `$ref`,
 * or a value that is not an object at all. This accepts the usable ones and
 * rejects the rest, so a malformed spec fails at the point it enters the
 * parser instead of producing a tool with a silently empty schema.
 *
 * @param value The value to coerce.
 * @param context Phrase naming the value, used in the error message.
 * @throws {Error} If the value cannot be a usable schema.
 * @returns The schema; an already-plain object is returned by reference.
 */
export function normalizeSchema(
  value: unknown,
  context: string,
): OpenAPIV3.SchemaObject {
  if (value === undefined || value === null || value === true) {
    return {};
  }
  if (value === false) {
    throw new Error(`${context} uses an unsatisfiable false schema`);
  }

  if (Array.isArray(value)) {
    throw new Error(`${context} must be an OpenAPI schema, got array`);
  }
  if (typeof value !== 'object') {
    throw new Error(
      `${context} must be an OpenAPI schema, got ${typeof value}`,
    );
  }

  const ref = (value as Record<string, unknown>)['$ref'];
  if (typeof ref === 'string') {
    throw new Error(`${context} contains unresolved reference '${ref}'`);
  }
  return value;
}

/**
 * Reads the single schema type, tolerating the type array that
 * `sanitizeSchemaTypes` writes but the OpenAPI typings do not declare.
 */
function resolveSchemaType(schema: OpenAPIV3.SchemaObject): string | undefined {
  const rawType: unknown = schema.type;
  if (typeof rawType === 'string') {
    return rawType;
  }
  if (!Array.isArray(rawType)) {
    return undefined;
  }
  const named: string[] = [];
  for (const entry of rawType) {
    if (typeof entry === 'string' && entry !== 'null') {
      named.push(entry);
    }
  }
  return named.length === 1 ? named[0] : undefined;
}

function itemTypeName(schema: OpenAPIV3.SchemaObject): string {
  const items = 'items' in schema ? schema.items : undefined;
  if (!items || '$ref' in items) {
    return UNKNOWN_TYPE;
  }
  const itemType = resolveSchemaType(items);
  return (itemType && TYPE_NAMES.get(itemType)) || UNKNOWN_TYPE;
}

/**
 * Maps a normalized schema onto its TypeScript type name.
 *
 * @param schema The schema, as returned by `normalizeSchema`.
 * @returns A type name; `unknown` when the schema names no usable type.
 */
export function getTypeHint(schema: OpenAPIV3.SchemaObject): string {
  const type = resolveSchemaType(schema);
  if (type === 'array') {
    return `${itemTypeName(schema)}[]`;
  }
  return (type && TYPE_NAMES.get(type)) || UNKNOWN_TYPE;
}

/**
 * Converts an OpenAPI parameter name to the snake_case argument name.
 *
 * This is the OpenAPI parameter-naming rule, not the recursive object-key
 * conversion that `utils/object_notation_utils.ts` exports as `toSnakeCase`.
 *
 * @param originalName The name as the spec declares it.
 * @returns The argument name.
 */
export function toSnakeCaseName(originalName: string): string {
  return originalName
    .replace(/[A-Z]/g, (g) => '_' + g.toLowerCase())
    .replace(/^_/, '');
}

/**
 * Derives a complete {@link ApiParameter} from an OpenAPI parameter.
 *
 * @param init The parameter as the spec declares it.
 * @throws {Error} If `paramSchema` cannot be a usable schema.
 * @returns The parameter, with a non-empty name and a concrete schema.
 */
export function createApiParameter(init: ApiParameterInit): ApiParameter {
  const paramSchema = normalizeSchema(
    init.paramSchema,
    `parameter '${init.originalName}'`,
  );
  const derivedName = init.name || toSnakeCaseName(init.originalName);
  return {
    originalName: init.originalName,
    paramLocation: init.paramLocation,
    paramSchema,
    description: init.description || paramSchema.description || '',
    name:
      derivedName ||
      DEFAULT_NAME_BY_LOCATION.get(init.paramLocation) ||
      DEFAULT_NAME,
    required: init.required ?? false,
  };
}

/** Renders the `Object properties:` block of a schema, or `''`. */
function propertiesDoc(schema: OpenAPIV3.SchemaObject, indent: string): string {
  if (schema.type !== 'object' || !schema.properties) {
    return '';
  }
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) {
    return '';
  }

  let doc = ' Object properties:\n';
  for (const [propName, propDetails] of entries) {
    if ('$ref' in propDetails) {
      doc += `${indent}${propName} (${UNKNOWN_TYPE}): \n`;
      continue;
    }
    const propDoc = propDetails.description || '';
    doc += `${indent}${propName} (${getTypeHint(propDetails)}): ${propDoc}\n`;
  }
  return doc;
}

/**
 * Renders the documentation line for one argument.
 *
 * @param param The parameter to document.
 * @returns The documentation string.
 */
export function generateParamDoc(param: ApiParameter): string {
  const description = param.description?.trim() ?? '';
  const typeHint = getTypeHint(param.paramSchema);
  const properties = propertiesDoc(param.paramSchema, PARAM_PROPERTY_INDENT);
  return `${param.name} (${typeHint}): ${description}${properties}`;
}

/** Orders two response status keys; numeric keys sort before the rest. */
function sortsBefore(key: string, other: string): boolean {
  const keyIsNumeric = NUMERIC_STATUS.test(key);
  if (keyIsNumeric !== NUMERIC_STATUS.test(other)) {
    return keyIsNumeric;
  }
  return keyIsNumeric ? Number(key) < Number(other) : key < other;
}

/** The 2xx response that the tool returns. */
interface SuccessResponse {
  key: string;
  content: {[media: string]: OpenAPIV3.MediaTypeObject};
  description: string;
}

/** Picks the 2xx response with content that the tool returns. */
function selectSuccessResponse(
  responses: OpenAPIV3.ResponsesObject,
): SuccessResponse | undefined {
  let best: SuccessResponse | undefined;
  for (const [key, response] of Object.entries(responses)) {
    if (!key.startsWith('2') || '$ref' in response) {
      continue;
    }
    const content = response.content;
    // `{}` is truthy in JavaScript, so an empty content map must be counted.
    if (!content || Object.keys(content).length === 0) {
      continue;
    }
    if (!best || sortsBefore(key, best.key)) {
      best = {key, content, description: response.description};
    }
  }
  return best;
}

/**
 * Renders the `Returns (...)` documentation of an operation.
 *
 * @param responses The operation's responses.
 * @throws {Error} If the selected response schema is an unresolved `$ref`.
 * @returns The documentation string, or `''` when no 2xx response has content.
 */
export function generateReturnDoc(
  responses: OpenAPIV3.ResponsesObject,
): string {
  const response = selectSuccessResponse(responses);
  if (!response) {
    return '';
  }

  const {content} = response;
  const mediaType = content['application/json'] ?? Object.values(content)[0];
  const schema = normalizeSchema(mediaType.schema, 'response body');
  const description = (response.description || '').trim();
  const properties = propertiesDoc(schema, RETURN_PROPERTY_INDENT);
  return `Returns (${getTypeHint(schema)}): ${description}${properties}`;
}
