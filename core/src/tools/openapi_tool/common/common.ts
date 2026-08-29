/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from '../../../utils/case_utils.js';

/** Content type preferred when a response offers several. */
const JSON_MEDIA_TYPE = 'application/json';

/** Indent placed before each property line of an object's documentation. */
const PROPERTY_INDENT = '       ';

/** Prefix applied to an argument name that collides with a reserved word. */
const RESERVED_WORD_PREFIX = 'param_';

/** Argument name used when a parameter's location is not a known one. */
const DEFAULT_NAME = 'value';

/** Matches a status key that is a plain number, such as `200`. */
const NUMERIC_STATUS = /^\d+$/;

/**
 * Argument name used when a parameter's name derives to nothing.
 *
 * A `Map` rather than an object literal: the key is the parameter location
 * straight from an untrusted spec, and an object lookup resolves inherited
 * names such as `constructor`.
 */
const DEFAULT_NAME_BY_LOCATION: ReadonlyMap<string, string> = new Map([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** OpenAPI schema type -> the kind naming it, for every non-array type. */
const KIND_BY_SCHEMA_TYPE: ReadonlyMap<
  string,
  'integer' | 'number' | 'boolean' | 'string' | 'record'
> = new Map([
  ['integer', 'integer'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['string', 'string'],
  ['object', 'record'],
]);

/** Kind -> the TypeScript type name shown to the model. */
const TYPE_NAME_BY_KIND: Record<Exclude<TypeValue['kind'], 'array'>, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  record: 'Record<string, unknown>',
  unknown: 'unknown',
};

/**
 * JavaScript reserved words, including the strict-mode and contextual ones.
 *
 * A spec is free to name a parameter `class` or `default`. The generated
 * argument name is model-facing and is also a plausible identifier, so it is
 * prefixed rather than emitted as-is.
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
 * The runtime type a schema describes.
 *
 * TypeScript erases its types, so a schema resolves to a structural
 * descriptor rather than to a type object. `integer` stays distinct from
 * `number` because JSON Schema distinguishes them; both render as `number`.
 */
export type TypeValue =
  | {kind: 'string'}
  | {kind: 'number'}
  | {kind: 'integer'}
  | {kind: 'boolean'}
  | {kind: 'record'}
  | {kind: 'unknown'}
  | {kind: 'array'; items: TypeValue};

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

/** A parameter with every derived field resolved. */
export interface NormalizedApiParameter extends ApiParameter {
  description: string;
  typeValue: TypeValue;
  typeHint: string;
}

/** The projection {@link serializeApiParameter} produces. */
export interface SerializedApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string;
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
 * A spec is parsed from user JSON or YAML, so a schema field arrives in shapes
 * the typings do not promise: absent, a boolean, an unresolved `$ref`, a JSON
 * string, or a value that is not an object at all. This accepts the usable
 * ones and rejects the rest, once, at the boundary.
 *
 * @param value The value to coerce.
 * @param context Phrase naming the value, used in the error message.
 * @throws {Error} If the value cannot be a usable schema.
 * @returns The schema; an already-plain object is returned by reference.
 */
export function normalizeOpenApiSchema(
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
 * Narrows a schema-bearing field onto a schema object.
 *
 * Returns nothing for the shapes that carry no type: absent, an unresolved
 * `$ref`, and the boolean schemas JSON Schema allows wherever a schema is
 * allowed.
 */
function asSchemaObject(
  value: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.SchemaObject | undefined {
  if (!value || typeof value !== 'object' || '$ref' in value) {
    return undefined;
  }
  return value;
}

/**
 * Reads the single schema type, tolerating the type array that OpenAPI 3.1
 * allows but the OpenAPI 3.0 typings do not declare.
 *
 * A union such as `['string', 'null']` names one usable type; `['string',
 * 'number']` names none.
 */
function schemaTypeOf(
  schema: OpenAPIV3.SchemaObject | undefined,
): string | undefined {
  const rawType: unknown = schema?.type;
  if (typeof rawType === 'string') {
    return rawType;
  }
  if (!Array.isArray(rawType)) {
    return undefined;
  }
  const named = rawType.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== 'null',
  );
  return named.length === 1 ? named[0] : undefined;
}

/** Reads `items` off a schema the typings only give an array schema. */
function itemsSchemaOf(
  schema: OpenAPIV3.SchemaObject,
): OpenAPIV3.SchemaObject | undefined {
  return asSchemaObject('items' in schema ? schema.items : undefined);
}

/** Maps a schema type onto its kind, for every type but `array`. */
function nonArrayTypeValue(type: string | undefined): TypeValue {
  return {kind: (type && KIND_BY_SCHEMA_TYPE.get(type)) || 'unknown'};
}

/**
 * Resolves a schema onto its runtime type.
 *
 * An array's item type is resolved one level only, matching the reference
 * implementation: an array of arrays holds items of unknown type.
 *
 * @param schema The schema.
 * @returns The type; `{kind: 'unknown'}` when the schema names no usable type.
 */
export function getSchemaTypeValue(schema: OpenAPIV3.SchemaObject): TypeValue {
  const type = schemaTypeOf(schema);
  if (type !== 'array') {
    return nonArrayTypeValue(type);
  }
  const itemType = schemaTypeOf(itemsSchemaOf(schema));
  return {
    kind: 'array',
    items:
      itemType === 'array'
        ? {kind: 'array', items: {kind: 'unknown'}}
        : nonArrayTypeValue(itemType),
  };
}

/** Renders a resolved type as the TypeScript type name shown to the model. */
function renderTypeValue(value: TypeValue): string {
  return value.kind === 'array'
    ? `Array<${renderTypeValue(value.items)}>`
    : TYPE_NAME_BY_KIND[value.kind];
}

/**
 * Maps a schema onto the TypeScript type name shown to the model.
 *
 * This renders {@link getSchemaTypeValue}, so the two cannot disagree.
 *
 * @param schema The schema.
 * @returns A type name; `unknown` when the schema names no usable type.
 */
export function getSchemaTypeHint(schema: OpenAPIV3.SchemaObject): string {
  return renderTypeValue(getSchemaTypeValue(schema));
}

/**
 * Prefixes an argument name that collides with a JavaScript reserved word.
 *
 * @param name The argument name.
 * @param prefix The prefix to apply on a collision.
 * @returns The prefixed name on a collision, otherwise `name` unchanged.
 */
export function renameReservedKeyword(
  name: string,
  prefix: string = RESERVED_WORD_PREFIX,
): string {
  return RESERVED_WORDS.has(name) ? `${prefix}${name}` : name;
}

/**
 * Derives a tool-facing parameter from an OpenAPI parameter.
 *
 * The name is the caller's, else the snake_case original with a reserved word
 * prefixed, else a name for the location. The description is the caller's,
 * else the schema's own. `init` is not modified.
 *
 * @param init The parameter as the spec declares it.
 * @throws {Error} If the schema is unusable; see {@link normalizeOpenApiSchema}.
 * @returns The parameter, with every derived field resolved.
 */
export function createApiParameter(
  init: ApiParameterInit,
): NormalizedApiParameter {
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
      renameReservedKeyword(snakeCase(init.originalName)) ||
      DEFAULT_NAME_BY_LOCATION.get(init.paramLocation) ||
      DEFAULT_NAME,
    required: init.required ?? false,
    typeValue: getSchemaTypeValue(paramSchema),
    typeHint: getSchemaTypeHint(paramSchema),
  };
}

/**
 * Documents the properties of an object schema, one indented line each.
 *
 * @returns The lines, or `''` when the schema is not an object with
 *     properties.
 */
function describeObjectProperties(schema: OpenAPIV3.SchemaObject): string {
  const properties = schema.properties;
  if (schemaTypeOf(schema) !== 'object' || !properties) {
    return '';
  }
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return '';
  }
  let doc = ' Object properties:\n';
  for (const [propertyName, property] of entries) {
    const resolved = asSchemaObject(property);
    const typeHint = resolved ? getSchemaTypeHint(resolved) : 'unknown';
    const description = resolved?.description ?? '';
    doc += `${PROPERTY_INDENT}${propertyName} (${typeHint}): ${description}\n`;
  }
  return doc;
}

/**
 * Documents a parameter for the description a model reads.
 *
 * @param param The parameter.
 * @returns One line, followed by a line per property of an object parameter.
 */
export function generateParamDoc(param: NormalizedApiParameter): string {
  const doc = `${param.name} (${param.typeHint}): ${param.description.trim()}`;
  return doc + describeObjectProperties(param.paramSchema);
}

/**
 * Orders response status keys: numeric codes first and ascending, then
 * ranges such as `2XX` in alphabetical order.
 *
 * The numeric code is padded so that the keys compare as numbers.
 */
function statusSortKey(key: string): string {
  return NUMERIC_STATUS.test(key) ? `0${key.padStart(6, '0')}` : `1${key}`;
}

/** Picks the success response a return value is documented from. */
function selectSuccessResponse(
  responses: OpenAPIV3.ResponsesObject,
): OpenAPIV3.ResponseObject | undefined {
  let best: OpenAPIV3.ResponseObject | undefined;
  let bestKey = '';
  for (const [key, response] of Object.entries(responses)) {
    if (!key.startsWith('2') || '$ref' in response) {
      continue;
    }
    if (!response.content || Object.keys(response.content).length === 0) {
      continue;
    }
    if (!best || statusSortKey(key) < statusSortKey(bestKey)) {
      best = response;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Picks the media type a return value is documented from.
 *
 * `application/json` wins whenever it is offered, even when it declares no
 * schema, matching the reference implementation.
 */
function selectMediaType(content: {
  [media: string]: OpenAPIV3.MediaTypeObject;
}): OpenAPIV3.MediaTypeObject {
  return content[JSON_MEDIA_TYPE] ?? Object.values(content)[0];
}

/**
 * Documents an operation's return value for the description a model reads.
 *
 * The lowest success status that carries content is documented; a response
 * without content describes no return value.
 *
 * @param responses The operation's responses.
 * @throws {Error} If the chosen schema is unusable; see
 *     {@link normalizeOpenApiSchema}.
 * @returns One line, followed by a line per property of an object return
 *     value, or `''` when no response qualifies.
 */
export function generateReturnDoc(
  responses: OpenAPIV3.ResponsesObject,
): string {
  const response = selectSuccessResponse(responses);
  if (!response?.content) {
    return '';
  }
  const media = selectMediaType(response.content);
  const schema = normalizeOpenApiSchema(media.schema, 'response body');
  const description = (response.description ?? '').trim();
  const doc = `Returns (${getSchemaTypeHint(schema)}): ${description}`;
  return doc + describeObjectProperties(schema);
}

/**
 * Renders a parameter as an object-literal property binding an argument.
 *
 * The reference implementation renders a Python keyword argument; the
 * equivalent binding in TypeScript is an object-literal property.
 */
export function toArgString(param: ApiParameter): string {
  return `${param.name}: ${param.name}`;
}

/** Renders a parameter as a quoted object-literal property. */
export function toDictProperty(param: ApiParameter): string {
  return `"${param.name}": ${param.name}`;
}

/** Renders a parameter as a name and its type. */
export function formatApiParameter(param: NormalizedApiParameter): string {
  return `${param.name}: ${param.typeHint}`;
}

/**
 * Projects a parameter onto its declared fields.
 *
 * The derived fields are left out, matching the reference implementation's
 * serializer. An absent description is omitted rather than serialized as
 * `undefined`.
 */
export function serializeApiParameter(
  param: ApiParameter,
): SerializedApiParameter {
  const serialized: SerializedApiParameter = {
    originalName: param.originalName,
    paramLocation: param.paramLocation,
    paramSchema: param.paramSchema,
    name: param.name,
  };
  if (param.description !== undefined) {
    serialized.description = param.description;
  }
  return serialized;
}
