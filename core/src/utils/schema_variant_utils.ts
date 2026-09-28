/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

/** The only `format` values the Gemini Developer API accepts on a number. */
const GEMINI_NUMERIC_FORMATS = new Set(['int32', 'int64']);

/** The only `format` values the Gemini Developer API accepts on a string. */
const GEMINI_STRING_FORMATS = new Set(['date-time', 'enum']);

/**
 * Whether the Gemini Developer API accepts `format` on a field of this type.
 *
 * The type name is folded to lower case so that both dialects resolve: a genai
 * `Schema` spells it `INTEGER`, a JSON Schema document spells it `integer`.
 */
function isFormatSupportedByGemini(
  type: string | undefined,
  format: string,
): boolean {
  switch (type?.toLowerCase()) {
    case 'integer':
    case 'number':
      return GEMINI_NUMERIC_FORMATS.has(format);
    case 'string':
      return GEMINI_STRING_FORMATS.has(format);
    default:
      return false;
  }
}

/**
 * Drops the `format` values the Gemini Developer API rejects, recursing into
 * `items`, `properties` and `anyOf`.
 *
 * The Vertex AI API accepts the wider OpenAPI `format` vocabulary, so callers
 * run this only for the `GEMINI_API` variant. A schema that survives unchanged
 * is still returned as a copy, because the caller may hold the input. Mirrors
 * adk-python's `_sanitize_schema_formats_for_gemini`.
 */
export function stripUnsupportedGeminiFormats(schema: Schema): Schema {
  const sanitized: Schema = {...schema};

  if (
    sanitized.format &&
    !isFormatSupportedByGemini(schema.type, sanitized.format)
  ) {
    delete sanitized.format;
  }
  if (sanitized.items) {
    sanitized.items = stripUnsupportedGeminiFormats(sanitized.items);
  }
  if (sanitized.properties) {
    sanitized.properties = Object.fromEntries(
      Object.entries(sanitized.properties).map(([name, property]) => [
        name,
        stripUnsupportedGeminiFormats(property),
      ]),
    );
  }
  if (sanitized.anyOf) {
    sanitized.anyOf = sanitized.anyOf.map(stripUnsupportedGeminiFormats);
  }
  return sanitized;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullBranch(branch: unknown): boolean {
  return isJsonObject(branch) && branch['type'] === 'null';
}

/**
 * Rewrites `anyOf: [X, {type: 'null'}]` as `X` plus `nullable: true`, recursing
 * into `properties`, `items` and the surviving branches.
 *
 * Vertex AI rejects a subschema that declares no top-level `type`, and that is
 * the form Zod emits for a nullable field. A union that keeps more than one
 * non-null branch stays a union and only gains `nullable`; a union with no null
 * branch is left alone. Mirrors adk-python's `_annotate_nullable_fields`.
 *
 * Total by construction: a value it cannot interpret is copied through rather
 * than rejected, so a declaration can never fail to build here.
 */
export function flattenNullableAnyOf(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {...jsonSchema};

  if (isJsonObject(out['items'])) {
    out['items'] = flattenNullableAnyOf(out['items']);
  }
  if (isJsonObject(out['properties'])) {
    out['properties'] = Object.fromEntries(
      Object.entries(out['properties']).map(([name, property]) => [
        name,
        isJsonObject(property) ? flattenNullableAnyOf(property) : property,
      ]),
    );
  }
  if (!Array.isArray(out['anyOf'])) {
    return out;
  }

  const branches: unknown[] = out['anyOf'].map((branch) =>
    isJsonObject(branch) ? flattenNullableAnyOf(branch) : branch,
  );
  const nonNull = branches.filter((branch) => !isNullBranch(branch));
  if (nonNull.length === branches.length) {
    out['anyOf'] = branches;
    return out;
  }

  // Only an object branch can be merged upwards; a boolean branch has no keys
  // to carry, so the union is kept rather than dropping what it allowed.
  const [survivor] = nonNull;
  if (nonNull.length === 1 && isJsonObject(survivor)) {
    delete out['anyOf'];
    return {...out, ...survivor, nullable: true};
  }
  if (nonNull.length === 0) {
    delete out['anyOf'];
    return {...out, nullable: true};
  }
  return {...out, anyOf: nonNull, nullable: true};
}

/**
 * The JSON Schema keywords the Gemini Developer API accepts. Everything else,
 * `additionalProperties`, `$schema` and `propertyNames` included, is dropped.
 */
const GEMINI_SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'title',
  'description',
  'default',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'propertyOrdering',
  '$defs',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'pattern',
  'nullable',
]);

/** The keywords whose value is a map of sub-schemas. */
const SUB_SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
]);

/** The keywords whose value is a list of alternative sub-schemas. */
const SUB_SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'anyOf',
  'oneOf',
]);

/**
 * Normalises a schema's `type`, mirroring adk-python's
 * `_sanitize_schema_type`.
 *
 * Gemini accepts a single type name where JSON Schema also allows a list, and
 * rejects an array without `items` and a non-string `enum` member on a string
 * field. `preserveNullType` keeps a bare `type: 'null'` intact, which is
 * meaningful inside a union branch and meaningless on its own.
 */
function sanitizeSchemaType(
  schema: Record<string, unknown>,
  preserveNullType: boolean,
): Record<string, unknown> {
  if (Object.keys(schema).length === 0) {
    schema['type'] = 'object';
  }
  const declaredType = schema['type'];
  if (Array.isArray(declaredType)) {
    const withoutNull = declaredType.filter((name) => name !== 'null');
    const nonNullType = withoutNull.includes('array')
      ? 'array'
      : (withoutNull[0] ?? 'object');
    schema['type'] =
      withoutNull.length === declaredType.length
        ? nonNullType
        : [nonNullType, 'null'];
  } else if (declaredType === 'null' && !preserveNullType) {
    schema['type'] = ['object', 'null'];
  }

  const schemaType = schema['type'];
  const typeNames = Array.isArray(schemaType) ? schemaType : [schemaType];
  if (typeNames.includes('array') && schema['items'] === undefined) {
    schema['items'] = {type: 'string'};
  }
  const effectiveType = typeNames.find((name) => name !== 'null');
  if (effectiveType === 'string' && Array.isArray(schema['enum'])) {
    schema['enum'] = schema['enum']
      .filter((member) => member !== null)
      .map((member) =>
        typeof member === 'string' ? member : JSON.stringify(member),
      );
  }
  return schema;
}

function sanitizeSchemaNode(
  value: unknown,
  preserveNullType: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaNode(item, preserveNullType));
  }
  // JSON Schema allows the boolean schemas `true` (accept anything) and
  // `false` (accept nothing). Gemini has an equivalent for neither, so both
  // become an unconstrained object rather than failing the conversion.
  if (typeof value === 'boolean') {
    return {type: 'object'};
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return sanitizeJsonSchemaForGemini(value, preserveNullType);
}

/**
 * Drops the JSON Schema keywords the Gemini Developer API rejects and
 * normalises the ones it accepts, recursing into every sub-schema.
 *
 * The Vertex AI API accepts the wider vocabulary, so callers run this only for
 * the `GEMINI_API` variant. Mirrors adk-python's
 * `_sanitize_schema_formats_for_gemini`, without its snake-case conversion:
 * JSON Schema and the genai JS `Schema` already spell a keyword the same way.
 *
 * Total by construction: a value it cannot interpret is copied through rather
 * than rejected, so a declaration can never fail to build here. The input is
 * never mutated.
 */
export function sanitizeJsonSchemaForGemini(
  jsonSchema: Record<string, unknown>,
  preserveNullType = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(jsonSchema)) {
    if (keyword === 'items') {
      out['items'] = sanitizeSchemaNode(value, false);
    } else if (SUB_SCHEMA_LIST_KEYWORDS.has(keyword)) {
      // `oneOf` is widened to `anyOf`, whose branch types Gemini keeps, and
      // accumulated so that a schema carrying both keywords keeps every
      // branch rather than letting the second one win.
      const branches = Array.isArray(value) ? value : [value];
      out['anyOf'] = [
        ...(Array.isArray(out['anyOf']) ? out['anyOf'] : []),
        ...branches.map((branch) => sanitizeSchemaNode(branch, true)),
      ];
    } else if (SUB_SCHEMA_MAP_KEYWORDS.has(keyword) && isJsonObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          sanitizeSchemaNode(member, false),
        ]),
      );
    } else if (keyword === 'format') {
      if (
        typeof value === 'string' &&
        isFormatSupportedByGemini(
          typeof jsonSchema['type'] === 'string'
            ? jsonSchema['type']
            : undefined,
          value,
        )
      ) {
        out['format'] = value;
      }
    } else if (GEMINI_SUPPORTED_KEYWORDS.has(keyword) && value !== null) {
      out[keyword] = value;
    }
  }
  return sanitizeSchemaType(out, preserveNullType);
}
