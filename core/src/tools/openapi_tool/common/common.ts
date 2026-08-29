/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {toSnakeCaseIdentifier} from '../../../utils/case_utils.js';
import {isRecord} from '../../../utils/object_notation_utils.js';

/** Prefix that keeps a generated parameter name off a reserved word. */
const RESERVED_WORD_PREFIX = 'param_';

/**
 * The words a generated parameter name must not collide with.
 *
 * The reference implementation guards against Python keywords. The generated
 * identifier here is TypeScript, so this is the ECMAScript reserved set plus
 * the strict-mode and contextual words.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/**
 * The parameter name to use when the derived name is empty, by location.
 *
 * A `Map` rather than an object literal: the key is a location string taken
 * straight from a user-supplied document, and an object lookup would resolve
 * inherited names such as `constructor`.
 */
const DEFAULT_NAME_BY_LOCATION: ReadonlyMap<string, string> = new Map([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** The parameter name to use when the location is not a known one. */
const FALLBACK_PARAM_NAME = 'value';

/** TypeScript type hints, by OpenAPI schema type. */
const TYPE_HINTS: ReadonlyMap<string, string> = new Map([
  ['integer', 'number'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['string', 'string'],
  ['object', 'Record<string, unknown>'],
]);

/** The hint for a schema whose type is absent or ambiguous. */
const UNKNOWN_HINT = 'unknown';

/** The hint for the elements of an array nested inside another array. */
const NESTED_ARRAY_HINT = 'Array<unknown>';

/**
 * Indent of a property line in a parameter doc.
 *
 * Seven spaces here and eight in a return doc, matching the reference
 * implementation exactly; both widths are pinned by tests.
 */
const PARAM_PROPERTY_INDENT = '       ';

/** Indent of a property line in a return doc. */
const RETURN_PROPERTY_INDENT = '        ';

/** One argument of a tool generated from an OpenAPI operation. */
export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  /** The name used in the generated tool schema (may be snake_cased). */
  name: string;
  required: boolean;
}

/** The values {@link createApiParameter} derives a parameter from. */
export interface ApiParameterInit {
  originalName: string;
  paramLocation: string;
  /**
   * The schema as the document holds it.
   *
   * An unresolved reference is rejected; see {@link schemaFromOpenApi}.
   */
  paramSchema?: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
  description?: string;
  /** Overrides the derived name when provided. */
  name?: string;
  required?: boolean;
}

/**
 * Reads a string field, treating any other shape as absent.
 *
 * A document written in YAML leaves `null` wherever a key has no value, so a
 * field the typings declare as a string arrives missing, null, or holding
 * something else entirely.
 */
function stringField(value: unknown, field: string): string {
  if (!isRecord(value)) {
    return '';
  }
  const read = value[field];
  return typeof read === 'string' ? read : '';
}

/**
 * Normalizes a schema-bearing OpenAPI value into a schema object.
 *
 * A document is parsed from user-supplied JSON or YAML, so a schema field
 * arrives in shapes the typings do not promise: absent, a boolean JSON schema,
 * an unresolved `$ref`, or a value that is not an object at all. This accepts
 * the usable shapes and rejects the rest with a message that names the
 * offending field, instead of letting a `TypeError` escape from deeper in. The
 * message quotes only the `$ref` and the `typeof`, never the document.
 *
 * @param value The value to normalize.
 * @param context A phrase naming the field, used verbatim in every message.
 * @throws {Error} If the value cannot be a usable schema.
 * @returns The schema; a plain object is returned by reference, unmodified.
 */
export function schemaFromOpenApi(
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
  if (!isRecord(value)) {
    throw new Error(
      `${context} must be an OpenAPI schema, got ${typeof value}`,
    );
  }
  const ref = value['$ref'];
  if (typeof ref === 'string') {
    throw new Error(`${context} contains unresolved reference '${ref}'`);
  }
  return value;
}

/**
 * Prefixes a name that collides with a TypeScript reserved word.
 *
 * @param name The name to check.
 * @returns The prefixed name, or the name unchanged.
 */
export function renameReservedWords(name: string): string {
  return RESERVED_WORDS.has(name) ? RESERVED_WORD_PREFIX + name : name;
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
  const paramSchema = schemaFromOpenApi(
    init.paramSchema,
    `parameter '${init.originalName}' schema`,
  );
  const derivedName = renameReservedWords(
    toSnakeCaseIdentifier(init.originalName),
  );
  return {
    originalName: init.originalName,
    paramLocation: init.paramLocation,
    paramSchema,
    description: init.description || paramSchema.description || '',
    name:
      init.name ||
      derivedName ||
      DEFAULT_NAME_BY_LOCATION.get(init.paramLocation) ||
      FALLBACK_PARAM_NAME,
    required: init.required ?? false,
  };
}

/**
 * Reads the type of a schema, dropping the `null` of a nullable union.
 *
 * OpenAPI 3.1 allows `type` to be an array. A union that still names more than
 * one type after `null` is removed has no single hint, so it resolves to
 * nothing.
 */
function resolveSchemaType(type: unknown): string | undefined {
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    const named = type.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== 'null',
    );
    return named.length === 1 ? named[0] : undefined;
  }
  return undefined;
}

function hintForType(type: string | undefined): string {
  if (type === undefined) {
    return UNKNOWN_HINT;
  }
  return TYPE_HINTS.get(type) ?? UNKNOWN_HINT;
}

/** Nesting stops one level down, as in the reference implementation. */
function itemTypeHint(items: unknown): string {
  if (!isRecord(items)) {
    return UNKNOWN_HINT;
  }
  const type = resolveSchemaType(items['type']);
  return type === 'array' ? NESTED_ARRAY_HINT : hintForType(type);
}

/**
 * Renders the TypeScript type a schema describes.
 *
 * @param schema The schema, in whatever shape the document supplied.
 * @returns The type hint, or `unknown` when the schema names no single type.
 */
export function getTypeHint(schema: unknown): string {
  if (!isRecord(schema)) {
    return UNKNOWN_HINT;
  }
  const type = resolveSchemaType(schema['type']);
  if (type === 'array') {
    return `Array<${itemTypeHint(schema['items'])}>`;
  }
  return hintForType(type);
}

/**
 * Renders one documentation line per property of an object schema.
 *
 * @param schema The schema whose properties to render.
 * @param indent The indent of each property line.
 * @returns The rendered lines, or `''` when the schema has no properties.
 */
function renderObjectProperties(
  schema: OpenAPIV3.SchemaObject,
  indent: string,
): string {
  const properties = schema.type === 'object' ? schema.properties : undefined;
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) {
    return '';
  }
  let doc = ' Object properties:\n';
  for (const [name, details] of entries) {
    const description = stringField(details, 'description');
    doc += `${indent}${name} (${getTypeHint(details)}): ${description}\n`;
  }
  return doc;
}

/**
 * Documents one parameter of a generated tool.
 *
 * @param param The parameter to document.
 * @returns The documentation string.
 */
export function generateParamDoc(param: ApiParameter): string {
  const description = (param.description ?? '').trim();
  return (
    `${param.name} (${getTypeHint(param.paramSchema)}): ${description}` +
    renderObjectProperties(param.paramSchema, PARAM_PROPERTY_INDENT)
  );
}

/**
 * Orders a response key: numeric keys ascend and sort before the rest.
 *
 * `default` and range codes such as `2XX` are valid OpenAPI keys, so a key is
 * only compared numerically once it is known to be all digits.
 */
function statusOrder(status: string): number {
  return /^\d+$/.test(status) ? Number(status) : Infinity;
}

/** The content block of a response, empty when the document leaves it out. */
function responseContent(
  response: OpenAPIV3.ResponseObject,
): Record<string, unknown> {
  return isRecord(response.content) ? response.content : {};
}

/**
 * Finds the response a generated tool returns.
 *
 * That is the 2xx response with the lowest numeric status code that carries
 * content. A `$ref` entry is skipped, because it names a response this module
 * cannot read.
 *
 * @param responses The responses of an OpenAPI operation.
 * @returns The response, or nothing when no 2xx response carries content.
 */
export function findSuccessResponse(
  responses: OpenAPIV3.ResponsesObject,
): OpenAPIV3.ResponseObject | undefined {
  let picked: OpenAPIV3.ResponseObject | undefined;
  let pickedOrder = Infinity;
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith('2') || !isRecord(response) || '$ref' in response) {
      continue;
    }
    if (Object.keys(responseContent(response)).length === 0) {
      continue;
    }
    const order = statusOrder(status);
    if (picked === undefined || order < pickedOrder) {
      picked = response;
      pickedOrder = order;
    }
  }
  return picked;
}

/**
 * Picks the media type a generated tool reads, preferring JSON.
 *
 * @param response The response to read.
 * @returns The media type, or nothing when the response declares none usable.
 */
export function findResponseMediaType(
  response: OpenAPIV3.ResponseObject,
): OpenAPIV3.MediaTypeObject | undefined {
  const content = responseContent(response);
  const mediaType = content['application/json'] ?? Object.values(content)[0];
  return isRecord(mediaType) ? mediaType : undefined;
}

/**
 * Documents the value a generated tool returns.
 *
 * @param responses The responses of an OpenAPI operation.
 * @returns The documentation string, or `''` when no 2xx response has content.
 */
export function generateReturnDoc(
  responses: OpenAPIV3.ResponsesObject,
): string {
  const response = findSuccessResponse(responses);
  const mediaType = response && findResponseMediaType(response);
  if (!response || !mediaType) {
    return '';
  }
  const schema = schemaFromOpenApi(mediaType.schema, 'response body');
  const description = stringField(response, 'description').trim();
  return (
    `Returns (${getTypeHint(schema)}): ${description}` +
    renderObjectProperties(schema, RETURN_PROPERTY_INDENT)
  );
}
