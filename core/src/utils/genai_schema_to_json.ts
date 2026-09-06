/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';

/**
 * Keys of a genai `Schema` that carry a count/length bound. The genai (OpenAPI)
 * encoding sends these as strings; JSON Schema requires numbers.
 */
const NUMERIC_STRING_KEYS = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
] as const;

/**
 * Keys that exist only in the genai/OpenAPI dialect and have no JSON Schema
 * meaning, so they are dropped rather than passed through to a validator.
 */
const NON_JSON_SCHEMA_KEYS = new Set(['propertyOrdering', 'example']);

/** JSON Schema type names, keyed by the genai `Type` enum value. */
const TYPE_NAMES: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null',
};

/** The same type names as {@link TYPE_NAMES}, in their JSON Schema spelling. */
const JSON_SCHEMA_TYPE_NAMES = new Set(Object.values(TYPE_NAMES));

/**
 * The JSON Schema name for a declared type, in whichever dialect it was
 * written: a genai `Type` enum member (`STRING`), or a JSON Schema name that is
 * already correct (`string`).
 *
 * Returns `undefined` for `TYPE_UNSPECIFIED`, for a type union
 * (`['string', 'null']`) and for anything unrecognised — all of which mean
 * "no type constraint to carry over".
 */
function jsonSchemaTypeName(type: unknown): string | undefined {
  if (typeof type !== 'string') {
    return undefined;
  }
  if (Object.hasOwn(TYPE_NAMES, type)) {
    return TYPE_NAMES[type];
  }
  return JSON_SCHEMA_TYPE_NAMES.has(type) ? type : undefined;
}

/** Whether `type` is spelled the way the genai `Type` enum spells it. */
function isGenaiTypeName(type: unknown): boolean {
  return (
    typeof type === 'string' &&
    (type === Type.TYPE_UNSPECIFIED || Object.hasOwn(TYPE_NAMES, type))
  );
}

/**
 * Whether any value of `container` is written in the genai dialect.
 *
 * Takes both an array (`anyOf`) and a record of schemas (`properties`), since
 * `Object.values` reads the members of either.
 */
function hasGenaiDialectValue(container: unknown): boolean {
  if (container === null || typeof container !== 'object') {
    return false;
  }
  return Object.values(container).some(isGenaiDialect);
}

/**
 * Whether any node of `schema` is written in the genai/OpenAPI dialect, which
 * is to say whether {@link convertGenaiSchema} would change it.
 *
 * Each marker below stands for one transformation the conversion performs, so
 * a document carrying none of them needs no conversion — and must not be given
 * one. `convertGenaiSchema` walks a document as the genai `Schema` shape and
 * corrupts any JSON Schema construct that shape has no room for: it turns a
 * tuple `items: [A, B]` into `items: {0: A, 1: B}`, and a boolean subschema
 * (`properties: {x: true}`) into `{}`.
 *
 * A schema can arrive from JSON or YAML, so a node of any shape has to answer
 * `false` rather than throw.
 */
function isGenaiDialect(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') {
    return false;
  }
  const node = schema as Record<string, unknown>;
  return (
    isGenaiTypeName(node['type']) ||
    node['nullable'] !== undefined ||
    [...NON_JSON_SCHEMA_KEYS].some((key) => node[key] !== undefined) ||
    node['format'] === 'enum' ||
    NUMERIC_STRING_KEYS.some((key) => typeof node[key] === 'string') ||
    isGenaiDialect(node['items']) ||
    hasGenaiDialectValue(node['properties']) ||
    hasGenaiDialectValue(node['anyOf'])
  );
}

/**
 * Converts a genai `Schema` into a standard JSON Schema object.
 *
 * This is the inverse of `zodObjectToSchema`, which renders Zod into the
 * genai/OpenAPI dialect. The two dialects differ in four ways, all handled
 * here:
 *
 * - `type` is an uppercase enum (`STRING`) rather than a JSON Schema type name
 *   (`string`). `TYPE_UNSPECIFIED` means "no constraint" and is dropped.
 * - `nullable: true` widens the type, which JSON Schema expresses as a type
 *   union (`['string', 'null']`).
 * - Count and length bounds are stringified (`maxItems: '5'`).
 * - `propertyOrdering` and `example` have no JSON Schema equivalent.
 *
 * Everything else (`description`, `title`, `default`, `pattern`, `required`,
 * `minimum`, `maximum`, `format`) is already JSON-Schema-shaped and passes
 * through, with `items`, `properties` and `anyOf` converted recursively.
 *
 * A document that carries no genai marker is already JSON Schema and is
 * returned as it was given — the caller's own object, not a copy — so that a
 * construct this conversion cannot represent survives. See
 * {@link isGenaiDialect}.
 */
export function genaiSchemaToJsonSchema(
  schema: Schema,
): Record<string, unknown> {
  return isGenaiDialect(schema)
    ? convertGenaiSchema(schema)
    : (schema as Record<string, unknown>);
}

/** Rewrites every node of a genai `Schema` into JSON Schema. */
function convertGenaiSchema(schema: Schema): Record<string, unknown> {
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || NON_JSON_SCHEMA_KEYS.has(key)) {
      continue;
    }

    switch (key) {
      case 'type':
      case 'nullable':
        // Handled together below, since `nullable` widens `type`.
        break;
      case 'items':
        out['items'] = convertGenaiSchema(value as Schema);
        break;
      case 'properties': {
        const properties: Record<string, unknown> = {};
        for (const [name, property] of Object.entries(
          value as Record<string, Schema>,
        )) {
          properties[name] = convertGenaiSchema(property);
        }
        out['properties'] = properties;
        break;
      }
      case 'anyOf':
        out['anyOf'] = (value as Schema[]).map(convertGenaiSchema);
        break;
      case 'format':
        // `enum` is a genai marker for "this string field is an enumeration",
        // not a JSON Schema format; the `enum` member list already says so.
        if (value !== 'enum') {
          out['format'] = value;
        }
        break;
      default:
        out[key] = NUMERIC_STRING_KEYS.includes(
          key as (typeof NUMERIC_STRING_KEYS)[number],
        )
          ? Number(value)
          : value;
    }
  }

  const typeName = jsonSchemaTypeName(schema.type);
  if (typeName) {
    out['type'] = schema.nullable ? [typeName, 'null'] : typeName;
  }

  // genai sends every enum member as a string, even for a numeric field
  // (`{type: INTEGER, format: enum, enum: ['101', '201']}`), so the members
  // have to be narrowed back to match the declared type.
  if (
    Array.isArray(out['enum']) &&
    (typeName === 'integer' || typeName === 'number')
  ) {
    out['enum'] = (out['enum'] as unknown[]).map((member) =>
      typeof member === 'string' &&
      member.trim() !== '' &&
      !isNaN(Number(member))
        ? Number(member)
        : member,
    );
  }

  return out;
}
