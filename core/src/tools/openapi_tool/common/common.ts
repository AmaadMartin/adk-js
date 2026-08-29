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

/** Prefix applied to an argument name that collides with a reserved word. */
const RESERVED_WORD_PREFIX = 'param_';

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

/** Indent of a property line under a parameter's documentation. */
const PARAM_PROPERTY_INDENT = ' '.repeat(7);

/**
 * Indent of a property line under the return documentation.
 *
 * One space wider than {@link PARAM_PROPERTY_INDENT}. The reference
 * implementation indents the two blocks differently and the ported tests
 * compare the strings verbatim, so the difference is kept.
 */
const RETURN_PROPERTY_INDENT = ' '.repeat(8);

/** Matches a status key that is entirely digits, such as `200`. */
const NUMERIC_STATUS = /^\d+$/;

/** The resolved runtime type of a parameter, structurally comparable. */
export type TypeValue =
  | {
      readonly kind:
        | 'integer'
        | 'number'
        | 'boolean'
        | 'string'
        | 'object'
        | 'unknown';
    }
  | {readonly kind: 'array'; readonly items: TypeValue};

/** The values an {@link ApiParameter} is constructed from. */
export interface ApiParameterOptions {
  originalName: string;
  paramLocation: string;
  /**
   * The schema as the spec declares it, or a JSON string holding one;
   * normalized by {@link normalizeSchema}.
   */
  paramSchema:
    | OpenAPIV3.SchemaObject
    | OpenAPIV3.ReferenceObject
    | string
    | boolean
    | undefined;
  description?: string;
  /** Derived from `originalName`/`paramLocation` when absent or empty. */
  name?: string;
  required?: boolean;
}

/** The JSON projection of an {@link ApiParameter}. */
export interface ApiParameterJson {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description: string;
  name: string;
}

/** Parses a schema held as a JSON string. */
function parseSchemaJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (e: unknown) {
    throw new Error(`${context} is not valid JSON: ${String(e)}`);
  }
}

/**
 * Coerces a schema-bearing OpenAPI value into a concrete schema object.
 *
 * A spec is parsed from user JSON or YAML, so a schema field arrives in
 * shapes the typings do not promise: absent, a boolean, an unresolved `$ref`,
 * a JSON string, or a value that is not an object at all. This accepts the
 * usable ones and rejects the rest, so a malformed spec fails at the point it
 * enters the parser instead of producing a tool with a silently empty schema.
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

  const parsed =
    typeof value === 'string' ? parseSchemaJson(value, context) : value;

  if (Array.isArray(parsed)) {
    throw new Error(`${context} must be an OpenAPI schema, got array`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `${context} must be an OpenAPI schema, got ${parsed === null ? 'null' : typeof parsed}`,
    );
  }

  const ref = (parsed as Record<string, unknown>)['$ref'];
  if (typeof ref === 'string') {
    throw new Error(`${context} contains unresolved reference '${ref}'`);
  }
  return parsed;
}

/**
 * Reads the single schema type, tolerating the type array that OpenAPI 3.1
 * allows but the OpenAPI 3.0 typings do not declare.
 *
 * A union such as `['string', 'null']` names one usable type; `['string',
 * 'number']` names none.
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

/** Reads `items` off a schema that the typings only expose on array schemas. */
function getItemsSchema(
  schema: OpenAPIV3.SchemaObject,
): OpenAPIV3.SchemaObject | undefined {
  const items = 'items' in schema ? schema.items : undefined;
  return !items || '$ref' in items ? undefined : items;
}

/**
 * Resolves a schema onto its runtime type.
 *
 * `integer` and `number` both hint `number`, because TypeScript has one
 * numeric type, but they stay distinct here: the JSON Schema distinction is
 * information the caller may want, and the reference implementation keeps it.
 *
 * @param schema The schema, a boolean schema, or nothing.
 * @returns The type; `{kind: 'unknown'}` when the schema names no usable type.
 */
export function getTypeValue(
  schema: OpenAPIV3.SchemaObject | boolean | undefined,
): TypeValue {
  if (typeof schema !== 'object') {
    return {kind: UNKNOWN_TYPE};
  }
  const type = resolveSchemaType(schema);
  if (type === 'array') {
    return {kind: 'array', items: getTypeValue(getItemsSchema(schema))};
  }
  switch (type) {
    case 'integer':
    case 'number':
    case 'boolean':
    case 'string':
    case 'object':
      return {kind: type};
    default:
      return {kind: UNKNOWN_TYPE};
  }
}

/**
 * Maps a schema onto the TypeScript type name shown to the model.
 *
 * An array of arrays hints `Array<unknown>` rather than a nested name. The
 * reference implementation's hint table has no array entry and falls back the
 * same way, while its type value nests; {@link getTypeValue} keeps the nesting.
 *
 * @param schema The schema, a boolean schema, or nothing.
 * @returns A type name; `unknown` when the schema names no usable type.
 */
export function getTypeHint(
  schema: OpenAPIV3.SchemaObject | boolean | undefined,
): string {
  if (typeof schema !== 'object') {
    return UNKNOWN_TYPE;
  }
  const type = resolveSchemaType(schema);
  if (type === 'array') {
    const items = getItemsSchema(schema);
    const itemType = items && resolveSchemaType(items);
    return `Array<${(itemType && TYPE_NAMES.get(itemType)) || UNKNOWN_TYPE}>`;
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
 * Prefixes an argument name that collides with a JavaScript reserved word.
 *
 * @param name The argument name.
 * @param prefix The prefix to apply on a collision.
 * @returns The prefixed name on a collision, otherwise `name` unchanged.
 */
export function renameReservedWord(
  name: string,
  prefix: string = RESERVED_WORD_PREFIX,
): string {
  return RESERVED_WORDS.has(name) ? `${prefix}${name}` : name;
}

/** One argument of a tool generated from an OpenAPI operation. */
export class ApiParameter {
  readonly originalName: string;
  readonly paramLocation: string;
  readonly paramSchema: OpenAPIV3.SchemaObject;
  readonly description: string;
  readonly required: boolean;
  readonly typeValue: TypeValue;
  readonly typeHint: string;
  /** Mutable: `OperationParser` renames a parameter whose name collides. */
  name: string;

  constructor(options: ApiParameterOptions) {
    this.originalName = options.originalName;
    this.paramLocation = options.paramLocation;
    this.paramSchema = normalizeSchema(
      options.paramSchema,
      `parameter '${options.originalName}'`,
    );
    this.description =
      options.description || this.paramSchema.description || '';
    this.required = options.required ?? false;
    this.typeValue = getTypeValue(this.paramSchema);
    this.typeHint = getTypeHint(this.paramSchema);

    const derived = renameReservedWord(toSnakeCaseName(options.originalName));
    this.name =
      options.name ||
      derived ||
      DEFAULT_NAME_BY_LOCATION.get(options.paramLocation) ||
      DEFAULT_NAME;
  }

  /** Renders the argument as `name: type`. */
  toString(): string {
    return `${this.name}: ${this.typeHint}`;
  }

  /** Renders the argument as it is passed on at a call site. */
  toArgString(): string {
    return `${this.name}=${this.name}`;
  }

  /** Renders the argument as an entry of an object literal. */
  toDictProperty(): string {
    return `"${this.name}": ${this.name}`;
  }

  /** Renders the argument's documentation line. */
  toDocString(): string {
    return generateParamDoc(this);
  }

  /**
   * Projects the parameter onto its serializable fields.
   *
   * `typeValue`, `typeHint` and `required` are derived, so they are left out,
   * matching the reference implementation's serializer.
   */
  toJSON(): ApiParameterJson {
    return {
      originalName: this.originalName,
      paramLocation: this.paramLocation,
      paramSchema: this.paramSchema,
      description: this.description,
      name: this.name,
    };
  }
}

/** Renders the `Object properties:` block of a schema, or `''`. */
function propertiesDoc(schema: OpenAPIV3.SchemaObject, indent: string): string {
  // Strict equality against the declared type: an `['object', 'null']` union
  // does not enumerate its properties.
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
  const description = param.description.trim();
  const properties = propertiesDoc(param.paramSchema, PARAM_PROPERTY_INDENT);
  return `${param.name} (${param.typeHint}): ${description}${properties}`;
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
 * The smallest numeric 2xx response that carries content wins, and
 * `application/json` wins among that response's media types.
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
