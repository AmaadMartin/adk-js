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
  /** The schema, already normalized via {@link normalizeSchema}. */
  paramSchema: OpenAPIV3.SchemaObject;
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
 * Handles lowerCamelCase, UpperCamelCase, space-separated text and acronyms:
 * `getHTTPResponse` becomes `get_http_response` and `REST API` becomes
 * `rest_api`.
 *
 * This is the OpenAPI parameter-naming rule, not the recursive object-key
 * conversion that `utils/object_notation_utils.ts` exports as `toSnakeCase`.
 *
 * @param originalName The name as the spec declares it.
 * @returns The argument name.
 */
export function toSnakeCaseName(originalName: string): string {
  return originalName
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Derives a complete {@link ApiParameter} from an OpenAPI parameter.
 *
 * @param init The parameter as the spec declares it.
 * @returns The parameter, with a non-empty name.
 */
export function createApiParameter(init: ApiParameterInit): ApiParameter {
  const paramSchema = init.paramSchema;
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

/**
 * Returns the scheme name a security list requires, or `''` when it requires
 * none.
 *
 * An empty requirement object is the OpenAPI idiom for optional
 * authentication. A tool that carries an auth scheme stops and asks the caller
 * for a credential instead of sending the request, so an optional requirement
 * resolves to no scheme; a caller that does want to authenticate passes the
 * scheme and the credential to the toolset.
 *
 * @param security The security requirements to read.
 * @returns The scheme name, or `''`.
 */
export function requiredSchemeName(
  security: OpenAPIV3.SecurityRequirementObject[] | undefined,
): string {
  if (!security || security.length === 0) {
    return '';
  }
  if (security.some((requirement) => Object.keys(requirement).length === 0)) {
    return '';
  }
  return Object.keys(security[0])[0];
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

/** The 2xx response that the tool returns. */
interface SuccessResponse {
  key: string;
  content: {[media: string]: OpenAPIV3.MediaTypeObject};
  description: string;
}

/**
 * Picks the 2xx response with content that the tool returns.
 *
 * @param responses The operation's responses.
 * @throws {Error} If a 2xx response is an unresolved `$ref`.
 * @returns The response, or `undefined` when none has content.
 */
function selectSuccessResponse(
  responses: OpenAPIV3.ResponsesObject,
): SuccessResponse | undefined {
  let best: SuccessResponse | undefined;
  for (const [key, response] of Object.entries(responses)) {
    if (!key.startsWith('2')) {
      continue;
    }
    if ('$ref' in response) {
      throw new Error(
        `Response contains unresolved reference '${response.$ref}'`,
      );
    }
    const content = response.content;
    // `{}` is truthy in JavaScript, so an empty content map must be counted.
    if (!content || Object.keys(content).length === 0) {
      continue;
    }
    // Status keys are three characters, so text order is numeric order.
    if (!best || key < best.key) {
      best = {key, content, description: response.description};
    }
  }
  return best;
}

/** Reads the schema of the media type a response returns. */
function schemaOf(response: SuccessResponse): OpenAPIV3.SchemaObject {
  const {content} = response;
  const mimeType =
    'application/json' in content
      ? 'application/json'
      : Object.keys(content)[0];
  return normalizeSchema(
    content[mimeType].schema,
    `response media type '${mimeType}'`,
  );
}

/**
 * Reads the schema of the value an operation returns.
 *
 * @param responses The operation's responses.
 * @throws {Error} If the selected response schema is an unresolved `$ref`.
 * @returns The schema, or an empty schema when no 2xx response has content.
 */
export function returnSchema(
  responses: OpenAPIV3.ResponsesObject,
): OpenAPIV3.SchemaObject {
  const response = selectSuccessResponse(responses);
  return response ? schemaOf(response) : {};
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

  const schema = schemaOf(response);
  const description = (response.description || '').trim();
  const properties = propertiesDoc(schema, RETURN_PROPERTY_INDENT);
  return `Returns (${getTypeHint(schema)}): ${description}${properties}`;
}
